from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

import requests
from gradio_client import Client, handle_file
from PIL import Image, ImageDraw

SPACE_ID = "stabilityai/stable-fast-3d"
CHARACTER_URL = (
    "https://huggingface.co/spaces/stabilityai/stable-fast-3d/resolve/main/"
    "demo_files/examples/character1.png"
)


def _download_character(path: Path) -> None:
    response = requests.get(CHARACTER_URL, timeout=60)
    response.raise_for_status()
    path.write_bytes(response.content)
    image = Image.open(path).convert("RGBA")
    if image.getextrema()[3][0] == 255:
        pixels = image.load()
        for y in range(image.height):
            for x in range(image.width):
                r, g, b, _a = pixels[x, y]
                alpha = 0 if r > 245 and g > 245 and b > 245 else 255
                pixels[x, y] = (r, g, b, alpha)
    image.save(path)


def _draw_tank(path: Path) -> None:
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    # Simple project-owned three-quarter hard-surface reference. It is intentionally
    # synthetic: the purpose is a real inference smoke test, not an art benchmark.
    draw.rounded_rectangle((75, 315, 405, 400), radius=38, fill=(45, 50, 58, 255))
    draw.rounded_rectangle((105, 285, 382, 365), radius=25, fill=(78, 92, 98, 255))
    draw.polygon(
        [(155, 270), (315, 250), (365, 300), (185, 320)],
        fill=(94, 111, 116, 255),
    )
    draw.ellipse((215, 225, 325, 310), fill=(75, 86, 90, 255))
    draw.rounded_rectangle((300, 245, 470, 266), radius=8, fill=(67, 76, 80, 255))
    draw.rectangle((445, 250, 492, 260), fill=(52, 58, 62, 255))
    for x in range(100, 385, 55):
        draw.ellipse((x, 338, x + 46, 384), fill=(25, 29, 35, 255))
        draw.ellipse((x + 9, 347, x + 37, 375), fill=(120, 128, 132, 255))
    draw.polygon([(115, 285), (165, 260), (195, 320), (135, 345)], fill=(105, 120, 124, 255))
    draw.line((150, 284, 334, 269), fill=(145, 155, 158, 255), width=5)
    image.save(path)


def _find_glb(value: Any) -> Path | None:
    if isinstance(value, (str, Path)):
        path = Path(value)
        if path.suffix.lower() == ".glb" and path.exists():
            return path
        return None
    if isinstance(value, dict):
        for key in ("path", "value", "file", "name"):
            candidate = value.get(key)
            result = _find_glb(candidate)
            if result is not None:
                return result
        for candidate in value.values():
            result = _find_glb(candidate)
            if result is not None:
                return result
        return None
    if isinstance(value, (tuple, list)):
        for candidate in value:
            result = _find_glb(candidate)
            if result is not None:
                return result
    return None


def _validate_glb(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    if len(data) < 12 or data[:4] != b"glTF":
        raise RuntimeError(f"{path} is not a valid GLB header")
    return {
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _generate(client: Client, image_path: Path, output_path: Path) -> dict[str, Any]:
    # This first event initializes the Gradio State values used by /run_button.
    prepared = client.predict(
        image=handle_file(str(image_path)),
        fr=0.85,
        api_name="/requires_bg_remove",
    )
    print("requires_bg_remove:", repr(prepared)[:1500])

    result = client.predict(
        input_image=handle_file(str(image_path)),
        foreground_ratio=0.85,
        remesh_option="None",
        vertex_count=-1,
        texture_size=1024,
        api_name="/run_button",
    )
    print("run_button:", repr(result)[:2000])
    glb = _find_glb(result)
    if glb is None:
        raise RuntimeError("SF3D Space returned no downloadable GLB")
    shutil.copy2(glb, output_path)
    return _validate_glb(output_path)


def main() -> None:
    root = Path("benchmark-output")
    root.mkdir(parents=True, exist_ok=True)
    character = root / "figurine-reference.png"
    tank = root / "tank-reference.png"
    _download_character(character)
    _draw_tank(tank)

    client = Client(SPACE_ID)
    try:
        print(json.dumps(client.view_api(return_format="dict"), indent=2, default=str)[:10000])
    except Exception as exc:
        print(f"view_api inspection failed but benchmark will still try known endpoints: {exc}")

    report: dict[str, Any] = {
        "space": SPACE_ID,
        "cases": {},
    }
    for name, image in (("figurine", character), ("tank", tank)):
        output = root / f"{name}.glb"
        try:
            report["cases"][name] = {
                "status": "success",
                **_generate(client, image, output),
                "output": str(output),
            }
        except Exception as exc:
            report["cases"][name] = {
                "status": "failed",
                "error": f"{type(exc).__name__}: {exc}",
            }

    (root / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if not all(case["status"] == "success" for case in report["cases"].values()):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
