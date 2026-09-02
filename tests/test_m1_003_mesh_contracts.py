from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

ROOT = Path(__file__).resolve().parents[1]
SHA = "a" * 64

REQUEST_SCHEMA = ROOT / "packages/mesh-generation/schemas/mesh-generation-request-0.1.0.json"
ARTIFACT_SCHEMA = ROOT / "packages/mesh-generation/schemas/mesh-artifact-0.1.0.json"
ASSET_SCHEMA = ROOT / "packages/asset-ir/schemas/asset-ir-0.1.0.json"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def request_fixture() -> dict:
    return {
        "schema_version": "0.1.0",
        "request_id": "mesh-request-r1",
        "project_id": "mesh-tank",
        "source_turnaround_revision_id": "turnaround-r1",
        "asset_kind": "vehicle_shell",
        "quality_tier": "standard",
        "output_format": "ply",
        "texture_policy": "none",
        "target_triangle_count": 10000,
        "preserve_semantic_regions": True,
        "notes": [],
        "status": "submitted",
        "created_at": "2026-09-02T00:00:00Z",
    }


def artifact_fixture() -> dict:
    return {
        "schema_version": "0.1.0",
        "artifact_id": "mesh-1",
        "project_id": "mesh-tank",
        "source_request_id": "mesh-request-r1",
        "sha256": SHA,
        "format": "ply",
        "media_type": "model/ply",
        "vertex_count": 8,
        "triangle_count": 12,
        "bounding_box_mm": {
            "min": {"x": -10, "y": -10, "z": 0},
            "max": {"x": 10, "y": 10, "z": 20},
        },
        "topology_observations": {
            "watertight": True,
            "manifold": True,
            "self_intersections_detected": False,
            "notes": [],
        },
        "provenance": {
            "provider": "deterministic-mesh-ci",
            "model": "cube-fixture",
            "model_version": "1",
            "job_id": "job-1",
            "input_artifact_sha256": [SHA],
            "generated_at": "2026-09-02T00:00:00Z",
        },
        "status": "generated",
        "created_at": "2026-09-02T00:00:00Z",
    }


@pytest.mark.parametrize("path", [REQUEST_SCHEMA, ARTIFACT_SCHEMA, ASSET_SCHEMA])
def test_m1_003_schemas_are_valid_draft_2020_12(path: Path) -> None:
    Draft202012Validator.check_schema(load(path))


def test_mesh_request_and_artifact_examples_validate() -> None:
    Draft202012Validator(load(REQUEST_SCHEMA)).validate(request_fixture())
    Draft202012Validator(load(ARTIFACT_SCHEMA)).validate(artifact_fixture())


def test_mesh_contracts_are_closed() -> None:
    request = copy.deepcopy(request_fixture())
    request["provider_specific_prompt"] = "must not become canonical"
    with pytest.raises(ValidationError):
        Draft202012Validator(load(REQUEST_SCHEMA)).validate(request)

    artifact = copy.deepcopy(artifact_fixture())
    artifact["printable"] = True
    with pytest.raises(ValidationError):
        Draft202012Validator(load(ARTIFACT_SCHEMA)).validate(artifact)


def test_mesh_artifact_cannot_claim_printability() -> None:
    schema_text = ARTIFACT_SCHEMA.read_text(encoding="utf-8")
    assert '"printable"' not in schema_text
    assert '"print_quality"' not in schema_text


def test_asset_ir_accepts_hard_surface_product_types() -> None:
    schema = load(ASSET_SCHEMA)
    values = schema["properties"]["asset_type"]["enum"]
    assert "vehicle_shell" in values
    assert "hard_surface_shell" in values
    assert "product_shell" in values
