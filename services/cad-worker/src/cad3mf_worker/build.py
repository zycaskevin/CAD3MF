from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from cad3mf_cadquery import compile_design
from cad3mf_ir import DesignDocument

from .exporter import export_design
from .validation import require_valid_geometry


class BuildError(RuntimeError):
    pass


def load_design(path: Path) -> DesignDocument:
    return DesignDocument.model_validate_json(path.read_text(encoding="utf-8"))


def build_design(design: DesignDocument, output_dir: Path) -> dict[str, Any]:
    compiled = compile_design(design)
    if len(compiled) != 1:
        raise BuildError("CAD3MF M0 export supports exactly one body")

    body_id, shape = next(iter(compiled.items()))
    validation = require_valid_geometry(shape)
    artifacts = export_design(shape, output_dir)

    validation_path = output_dir / "validation.json"
    validation_path.write_text(json.dumps(validation, indent=2, sort_keys=True), encoding="utf-8")

    manifest: dict[str, Any] = {
        "schema_version": design.schema_version,
        "project_id": design.project_id,
        "revision_id": design.revision_id,
        "parent_revision_id": design.parent_revision_id,
        "body_id": body_id,
        "parameters": design.parameters,
        "manufacturing": design.manufacturing.model_dump(mode="json"),
        "validation": validation,
        "artifacts": artifacts | {"validation": str(validation_path)},
    }
    manifest_path = output_dir / "build.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    manifest["artifacts"]["manifest"] = str(manifest_path)
    return manifest


def build_file(spec_path: Path, output_dir: Path) -> dict[str, Any]:
    return build_design(load_design(spec_path), output_dir)
