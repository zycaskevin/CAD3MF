from __future__ import annotations

from pathlib import Path

import cadquery as cq


class ExportError(RuntimeError):
    pass


def export_design(shape: cq.Workplane, output_dir: Path) -> dict[str, str]:
    output_dir.mkdir(parents=True, exist_ok=True)

    artifacts = {
        "step": output_dir / "model.step",
        "stl": output_dir / "model.stl",
        "3mf": output_dir / "model.3mf",
    }

    for path in artifacts.values():
        shape.export(str(path))
        if not path.exists() or path.stat().st_size == 0:
            raise ExportError(f"exporter did not create a non-empty artifact: {path}")

    preview_path = output_dir / "preview.glb"
    try:
        assembly = cq.Assembly(name="cad3mf-preview")
        assembly.add(shape, name="main_body")
        assembly.export(str(preview_path))
        if not preview_path.exists() or preview_path.stat().st_size == 0:
            raise ExportError("GLB exporter returned an empty artifact")
    except Exception as glb_error:
        preview_path.unlink(missing_ok=True)
        preview_path = output_dir / "preview.tjs"
        try:
            shape.export(str(preview_path))
        except Exception as tjs_error:
            raise ExportError("both GLB and TJS preview export failed") from tjs_error
        if not preview_path.exists() or preview_path.stat().st_size == 0:
            raise ExportError("both GLB and TJS preview export failed") from glb_error

    return {key: str(path) for key, path in artifacts.items()} | {"preview": str(preview_path)}
