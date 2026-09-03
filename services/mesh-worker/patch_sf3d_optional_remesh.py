from __future__ import annotations

import argparse
import shutil
from pathlib import Path


def patch_mesh_module(repo_root: Path) -> bool:
    mesh_path = repo_root / "sf3d" / "models" / "mesh.py"
    if not mesh_path.is_file():
        raise FileNotFoundError(f"SF3D mesh module not found: {mesh_path}")

    text = mesh_path.read_text(encoding="utf-8")
    original = text

    text = text.replace("import gpytoolbox\n", "")
    text = text.replace("import pynanoinstantmeshes\n", "")

    quad_marker = "    ) -> Mesh:\n        if quad_vertex_count < 0:\n"
    quad_replacement = (
        "    ) -> Mesh:\n"
        "        import pynanoinstantmeshes\n\n"
        "        if quad_vertex_count < 0:\n"
    )
    if "        import pynanoinstantmeshes\n" not in text:
        if quad_marker not in text:
            raise RuntimeError("Could not locate SF3D quad_remesh patch point")
        text = text.replace(quad_marker, quad_replacement, 1)

    triangle_marker = "    ):\n        if triangle_vertex_count > 0:\n"
    triangle_replacement = (
        "    ):\n"
        "        import gpytoolbox\n\n"
        "        if triangle_vertex_count > 0:\n"
    )
    if "        import gpytoolbox\n" not in text:
        if triangle_marker not in text:
            raise RuntimeError("Could not locate SF3D triangle_remesh patch point")
        text = text.replace(triangle_marker, triangle_replacement, 1)

    if text == original:
        return False

    backup = mesh_path.with_suffix(".py.cad3mf-backup")
    if not backup.exists():
        shutil.copy2(mesh_path, backup)
    mesh_path.write_text(text, encoding="utf-8")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Make SF3D remesh dependencies lazy so remesh=none can run without "
            "gpytoolbox or pynanoinstantmeshes."
        )
    )
    parser.add_argument(
        "sf3d_repo",
        type=Path,
        help="Path to a Stability-AI/stable-fast-3d checkout",
    )
    args = parser.parse_args()

    changed = patch_mesh_module(args.sf3d_repo.resolve())
    print("patched" if changed else "already patched")


if __name__ == "__main__":
    main()
