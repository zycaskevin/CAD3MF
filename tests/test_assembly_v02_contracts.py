from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
ASSEMBLY = ROOT / "packages/assembly-ir/schemas/assembly-ir-0.1.0.json"
REPORT = ROOT / "packages/assembly-ir/schemas/assembly-validation-report-0.1.0.json"


def test_assembly_schemas_are_valid() -> None:
    for path in (ASSEMBLY, REPORT):
        Draft202012Validator.check_schema(json.loads(path.read_text(encoding="utf-8")))


def test_ai_tank_assembly_example_validates() -> None:
    schema = json.loads(ASSEMBLY.read_text(encoding="utf-8"))
    instance = {
        "schema_version": "0.1.0",
        "assembly_id": "assembly-ai-tank",
        "project_id": "ai-tank",
        "revision_id": "assembly-r1",
        "parent_revision_id": None,
        "product_type": "modular_tank",
        "units": "mm",
        "parts": [
            {
                "id": "chassis",
                "source_kind": "cad_ir",
                "source_ref": "cad:r10",
                "source_artifact_sha256": None,
                "role": "structural",
                "transform": {
                    "x": 0,
                    "y": 0,
                    "z": 0,
                    "rotate_x": 0,
                    "rotate_y": 0,
                    "rotate_z": 0,
                },
                "required_for_product": True,
            },
            {
                "id": "shell",
                "source_kind": "asset_ir",
                "source_ref": "asset:r4",
                "source_artifact_sha256": None,
                "role": "shell",
                "transform": {
                    "x": 0,
                    "y": 0,
                    "z": 0,
                    "rotate_x": 0,
                    "rotate_y": 0,
                    "rotate_z": 0,
                },
                "required_for_product": True,
            },
        ],
        "interfaces": [
            {
                "id": "shell-mount",
                "type": "screw",
                "part_a": "chassis",
                "part_b": "shell",
                "spec": {
                    "clearance_mm": None,
                    "tolerance_mm": None,
                    "magnet_diameter_mm": None,
                    "magnet_depth_mm": None,
                    "peg_diameter_mm": None,
                    "engagement_depth_mm": None,
                    "screw_standard": "M2",
                    "adhesive_gap_mm": None,
                },
            }
        ],
        "notes": [],
        "status": "needs_validation",
    }
    Draft202012Validator(schema).validate(instance)
