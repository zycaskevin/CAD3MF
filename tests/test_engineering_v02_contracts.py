from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
ENVELOPE_SCHEMA = ROOT / "packages/engineering/schemas/engineering-envelope-set-0.1.0.json"
REPORT_SCHEMA = ROOT / "packages/engineering/schemas/engineering-interference-report-0.1.0.json"


def test_engineering_v02_schemas_are_valid() -> None:
    for path in (ENVELOPE_SCHEMA, REPORT_SCHEMA):
        Draft202012Validator.check_schema(json.loads(path.read_text(encoding="utf-8")))


def test_ai_tank_envelope_example_validates() -> None:
    schema = json.loads(ENVELOPE_SCHEMA.read_text(encoding="utf-8"))
    instance = {
        "schema_version": "0.1.0",
        "project_id": "ai-tank-v02",
        "revision_id": "envelopes-r1",
        "parent_revision_id": None,
        "source_asset_revision_id": "asset-r1",
        "units": "mm",
        "coordinate_frame": {
            "name": "tank-chassis",
            "handedness": "right",
            "up_axis": "z",
            "origin_policy": "chassis_origin",
        },
        "envelopes": [
            {
                "id": "battery-clearance",
                "semantic_role": "keep_out",
                "component_role": "battery",
                "shape": {"kind": "box", "x": 80, "y": 35, "z": 18},
                "transform": {
                    "x": 0,
                    "y": 0,
                    "z": 0,
                    "rotate_x": 0,
                    "rotate_y": 0,
                    "rotate_z": 0,
                },
                "clearance_mm": 1,
                "required": True,
                "notes": None,
            }
        ],
        "notes": [],
        "status": "needs_validation",
    }
    Draft202012Validator(schema).validate(instance)


def test_interference_report_makes_approximation_explicit() -> None:
    schema = json.loads(REPORT_SCHEMA.read_text(encoding="utf-8"))
    instance = {
        "schema_version": "0.1.0",
        "project_id": "ai-tank-v02",
        "report_id": "interference-r1",
        "source_revision_id": "envelopes-r1",
        "method": {
            "kind": "axis_aligned_bounding_box",
            "exact_geometry": False,
            "notes": "Declared engineering envelopes only.",
        },
        "checks": [
            {
                "envelope_a": "battery-clearance",
                "envelope_b": "pcb",
                "policy": "occupied_vs_keep_out",
                "status": "fail",
                "approximate": False,
                "overlap_mm": {"x": 10, "y": 5, "z": 2},
                "overlap_volume_mm3": 100,
                "reason": "negative control",
            }
        ],
        "summary": {"pass": 0, "fail": 1, "unknown": 0},
        "status": "fail",
        "created_at": "2026-10-03T16:00:00Z",
    }
    Draft202012Validator(schema).validate(instance)
