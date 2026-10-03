from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "packages/asset-ir/schemas/asset-ir-0.2.0.json"
SHA = "a" * 64


def test_asset_ir_v02_external_reference_contract() -> None:
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    instance = {
        "schema_version": "0.2.0",
        "asset_id": "asset-ai-tank",
        "project_id": "ai-tank",
        "revision_id": "asset-r1",
        "parent_revision_id": None,
        "source": {
            "kind": "external_reference",
            "design_intent_revision_id": None,
            "turnaround_revision_id": None,
            "external_file_id": "meshy-task-123",
        },
        "asset_type": "vehicle_shell",
        "units": "mm",
        "style": None,
        "pose": None,
        "target_dimensions": [
            {"name": "target_length", "value": 160, "unit": "mm"}
        ],
        "geometry_artifact": {
            "artifact_id": "mesh-1",
            "sha256": SHA,
            "format": "glb",
            "media_type": "model/gltf-binary",
            "vertex_count": None,
            "triangle_count": None,
        },
        "regions": [],
        "print_constraints": {
            "minimum_wall_thickness_mm": 1.6,
            "minimum_feature_size_mm": 1.0,
            "base_required": False,
            "target_height_mm": None,
            "maximum_overhang_deg": None,
        },
        "provenance": {
            "generator_kind": "manual_import",
            "provider": "meshy",
            "model": "external-3d-generator",
            "model_version": None,
            "job_id": "job-import-1",
            "input_artifact_sha256": [SHA],
        },
        "status": "reference_imported",
    }
    Draft202012Validator(schema).validate(instance)


def test_asset_ir_v02_does_not_require_fake_design_intent() -> None:
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    required = set(schema["required"])
    assert "source_intent_revision_id" not in required
    assert "source" in required
