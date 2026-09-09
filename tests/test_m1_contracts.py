from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

ROOT = Path(__file__).resolve().parents[1]
SHA = "a" * 64

SCHEMA_PATHS = {
    "design_intent": ROOT / "packages/design-intent/schemas/design-intent-0.1.0.json",
    "asset_ir": ROOT / "packages/asset-ir/schemas/asset-ir-0.1.0.json",
    "assembly_ir": ROOT / "packages/assembly-ir/schemas/assembly-ir-0.1.0.json",
    "manufacturing_ir": ROOT / "packages/manufacturing/schemas/manufacturing-ir-0.1.0.json",
    "job_manifest": ROOT / "packages/shared/schemas/job-manifest-0.1.0.json",
    "error": ROOT / "packages/shared/schemas/error-0.1.0.json",
}


def load_schema(name: str) -> dict:
    return json.loads(SCHEMA_PATHS[name].read_text(encoding="utf-8"))


def validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(load_schema(name))


def valid_examples() -> dict[str, dict]:
    design_intent = {
        "schema_version": "0.1.0",
        "intent_id": "intent-1",
        "project_id": "arthur-figurine",
        "revision_id": "r1",
        "product_kind": "figurine",
        "style": "chibi_collectible",
        "source_assets": [
            {
                "asset_id": "photo-front",
                "sha256": SHA,
                "media_type": "image/jpeg",
                "role": "identity_reference",
            }
        ],
        "known_dimensions": [
            {
                "name": "target_height",
                "value": 120,
                "unit": "mm",
                "source": "user",
                "confidence": 1.0,
            }
        ],
        "observed_features": [],
        "hidden_geometry_assumptions": [
            {
                "id": "back-hair",
                "statement": "Back hairstyle is inferred from the front reference.",
                "confidence": 0.45,
                "user_confirmed": False,
            }
        ],
        "questions": [
            {
                "id": "pose",
                "prompt": "Use the standing pose?",
                "required": True,
                "status": "answered",
                "answer": "yes",
            }
        ],
        "status": "confirmed",
    }

    asset_ir = {
        "schema_version": "0.1.0",
        "asset_id": "figurine-body",
        "project_id": "arthur-figurine",
        "revision_id": "r2",
        "source_intent_revision_id": "r1",
        "asset_type": "figurine",
        "units": "mm",
        "geometry_artifact": {
            "artifact_id": "mesh-r2",
            "sha256": SHA,
            "format": "glb",
            "media_type": "model/gltf-binary",
            "vertex_count": 120000,
            "triangle_count": 240000,
        },
        "regions": [
            {
                "id": "hair",
                "role": "surface_region",
                "semantic_label": "hair",
                "printable_region": True,
                "visual_color": {"r": 24, "g": 22, "b": 20, "a": 255},
            }
        ],
        "print_constraints": {
            "minimum_wall_thickness_mm": 1.2,
            "minimum_feature_size_mm": 1.0,
            "base_required": True,
            "target_height_mm": 120,
        },
        "provenance": {
            "generator_kind": "mesh_provider",
            "provider": "example-provider",
            "model": "example-model",
            "job_id": "job-geometry-1",
            "input_artifact_sha256": [SHA],
        },
        "status": "needs_repair",
    }

    assembly_ir = {
        "schema_version": "0.1.0",
        "assembly_id": "tank-assembly",
        "project_id": "modular-tank",
        "revision_id": "r3",
        "product_type": "modular_tank",
        "units": "mm",
        "parts": [
            {
                "id": "chassis",
                "source_kind": "cad_ir",
                "source_ref": "cad:r2",
                "role": "structural",
                "transform": {
                    "x": 0,
                    "y": 0,
                    "z": 0,
                    "rotate_x": 0,
                    "rotate_y": 0,
                    "rotate_z": 0,
                },
            },
            {
                "id": "turret",
                "source_kind": "asset_ir",
                "source_ref": "asset:r2",
                "role": "replaceable_module",
                "transform": {
                    "x": 0,
                    "y": 0,
                    "z": 18,
                    "rotate_x": 0,
                    "rotate_y": 0,
                    "rotate_z": 0,
                },
            },
        ],
        "interfaces": [
            {
                "id": "turret-mount",
                "type": "magnetic_mount",
                "part_a": "chassis",
                "part_b": "turret",
                "spec": {
                    "clearance_mm": 0.25,
                    "magnet_diameter_mm": 4,
                    "magnet_depth_mm": 2.5,
                },
            }
        ],
        "status": "needs_validation",
    }

    manufacturing_ir = {
        "schema_version": "0.1.0",
        "plan_id": "plan-1",
        "project_id": "arthur-figurine",
        "revision_id": "r4",
        "source": {"kind": "assembly_ir", "ref": "assembly:r3"},
        "process": "fdm",
        "printer": {
            "machine_profile_id": "bambu-h2c-0.4",
            "machine_profile_sha256": SHA,
            "nozzle_diameter_mm": 0.4,
        },
        "filaments": [
            {
                "slot": 1,
                "filament_profile_id": "petg-black",
                "filament_profile_sha256": SHA,
                "material": "PETG",
                "color_hex": "#111111",
            }
        ],
        "part_assignments": [
            {
                "part_id": "figurine-body",
                "filament_slot": 1,
                "orientation": {
                    "rotate_x": 0,
                    "rotate_y": 0,
                    "rotate_z": 0,
                    "source": "validated_auto",
                },
            }
        ],
        "slice_profile": {
            "process_profile_id": "0.16-quality",
            "process_profile_sha256": SHA,
            "layer_height_mm": 0.16,
            "wall_loops": 3,
            "infill_percent": 15,
            "support": "minimal",
            "brim": True,
        },
        "validation_policy": ["geometry", "watertight", "build_volume"],
        "status": "planned",
    }

    job_manifest = {
        "schema_version": "0.1.0",
        "job_id": "job-1",
        "trace_id": "trace-1",
        "project_id": "arthur-figurine",
        "job_kind": "geometry_generation",
        "status": "blocked",
        "stage": "confirmation",
        "attempt": 0,
        "max_attempts": 3,
        "blocked_reason_code": "TURNAROUND_REQUIRED",
        "inputs": [],
        "outputs": [],
        "tool_versions": [{"component": "cad3mf-mcp", "version": "m1-dev"}],
        "created_at": "2026-09-02T10:00:00+08:00",
        "updated_at": "2026-09-02T10:00:00+08:00",
    }

    error = {
        "schema_version": "0.1.0",
        "stage": "confirmation",
        "code": "TURNAROUND_REQUIRED",
        "retryable": False,
        "message": "More views are required before geometry generation.",
        "trace_id": "trace-1",
        "job_id": "job-1",
        "context": [{"key": "required_views", "value": 3}],
    }

    return {
        "design_intent": design_intent,
        "asset_ir": asset_ir,
        "assembly_ir": assembly_ir,
        "manufacturing_ir": manufacturing_ir,
        "job_manifest": job_manifest,
        "error": error,
    }


@pytest.mark.parametrize("name", SCHEMA_PATHS)
def test_m1_schema_is_valid_draft_2020_12(name: str) -> None:
    Draft202012Validator.check_schema(load_schema(name))


@pytest.mark.parametrize("name", SCHEMA_PATHS)
def test_m1_valid_examples(name: str) -> None:
    validator(name).validate(valid_examples()[name])


@pytest.mark.parametrize("name", SCHEMA_PATHS)
def test_m1_top_level_contracts_are_closed(name: str) -> None:
    instance = copy.deepcopy(valid_examples()[name])
    instance["unexpected_field"] = "must be rejected"
    with pytest.raises(ValidationError):
        validator(name).validate(instance)


def test_manufacturing_ir_rejects_arbitrary_gcode() -> None:
    instance = copy.deepcopy(valid_examples()["manufacturing_ir"])
    instance["slice_profile"]["start_gcode"] = "M1000 arbitrary"
    with pytest.raises(ValidationError):
        validator("manufacturing_ir").validate(instance)


def test_assembly_ir_rejects_executable_interface_payload() -> None:
    instance = copy.deepcopy(valid_examples()["assembly_ir"])
    instance["interfaces"][0]["spec"]["python"] = "import os"
    with pytest.raises(ValidationError):
        validator("assembly_ir").validate(instance)


def test_asset_ir_requires_digest_bound_geometry() -> None:
    instance = copy.deepcopy(valid_examples()["asset_ir"])
    instance["geometry_artifact"]["sha256"] = "not-a-digest"
    with pytest.raises(ValidationError):
        validator("asset_ir").validate(instance)


def test_design_intent_does_not_accept_arbitrary_source_media() -> None:
    instance = copy.deepcopy(valid_examples()["design_intent"])
    instance["source_assets"][0]["media_type"] = "text/html"
    with pytest.raises(ValidationError):
        validator("design_intent").validate(instance)


def test_job_manifest_supports_lifecycle_terminal_states() -> None:
    base = valid_examples()["job_manifest"]
    for state in ("failed", "succeeded", "canceled"):
        instance = copy.deepcopy(base)
        instance["status"] = state
        validator("job_manifest").validate(instance)
