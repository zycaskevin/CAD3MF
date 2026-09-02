from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

ROOT = Path(__file__).resolve().parents[1]
SHA = "b" * 64

SCHEMAS = {
    "visual_concept": ROOT / "packages/visual-concept/schemas/visual-concept-0.1.0.json",
    "turnaround_set": ROOT / "packages/visual-concept/schemas/turnaround-set-0.1.0.json",
}


def schema(name: str) -> dict:
    return json.loads(SCHEMAS[name].read_text(encoding="utf-8"))


def valid_concept() -> dict:
    return {
        "schema_version": "0.1.0",
        "concept_id": "concept-figurine",
        "project_id": "ref-vis-001",
        "revision_id": "concept-r1",
        "parent_revision_id": None,
        "source_intent_revision_id": "intent-r1",
        "product_kind": "figurine",
        "brief": "Stylized collectible figurine based on approved reference evidence.",
        "style": "chibi_collectible",
        "artifacts": [
            {
                "artifact_id": "concept-image-1",
                "sha256": SHA,
                "media_type": "image/png",
                "role": "hero",
                "width_px": 1024,
                "height_px": 1024,
            }
        ],
        "design_notes": ["Keep the face readable at 120 mm target height."],
        "open_decisions": [
            {
                "id": "pose",
                "prompt": "Confirm the primary pose.",
                "required": True,
                "status": "open",
            }
        ],
        "status": "needs_confirmation",
        "provenance": {
            "provider": "deterministic-test",
            "model": "fixture-png-v1",
            "job_id": "job-concept-1",
            "input_artifact_sha256": [SHA],
            "generated_at": "2026-09-02T12:00:00+08:00",
        },
        "created_at": "2026-09-02T12:00:00+08:00",
        "updated_at": "2026-09-02T12:00:00+08:00",
    }


def valid_turnaround() -> dict:
    view_names = [
        "front",
        "left",
        "right",
        "back",
        "three_quarter_front",
        "three_quarter_back",
    ]
    return {
        "schema_version": "0.1.0",
        "turnaround_id": "turnaround-tank",
        "project_id": "ref-vis-002",
        "revision_id": "turnaround-r1",
        "parent_revision_id": None,
        "source_concept_revision_id": "concept-r2",
        "coverage_policy": "full_six_view",
        "views": [
            {
                "view": view,
                "artifact_id": f"tank-{view}",
                "sha256": SHA,
                "media_type": "image/png",
                "projection": "orthographic_like",
                "width_px": 1024,
                "height_px": 1024,
                "notes": None,
            }
            for view in view_names
        ],
        "consistency": {
            "pass": True,
            "identity_score": 0.95,
            "style_score": 0.96,
            "silhouette_score": 0.94,
            "warnings": [],
        },
        "status": "needs_review",
        "provenance": {
            "provider": "deterministic-test",
            "model": "fixture-png-v1",
            "job_id": "job-turnaround-1",
            "input_artifact_sha256": [SHA],
            "generated_at": "2026-09-02T12:10:00+08:00",
        },
        "created_at": "2026-09-02T12:10:00+08:00",
        "updated_at": "2026-09-02T12:10:00+08:00",
    }


@pytest.mark.parametrize("name", SCHEMAS)
def test_m1_002_schema_is_valid_draft_2020_12(name: str) -> None:
    Draft202012Validator.check_schema(schema(name))


def test_figurine_visual_concept_contract() -> None:
    Draft202012Validator(schema("visual_concept")).validate(valid_concept())


def test_modular_tank_turnaround_contract() -> None:
    Draft202012Validator(schema("turnaround_set")).validate(valid_turnaround())


@pytest.mark.parametrize(
    ("name", "instance"),
    [("visual_concept", valid_concept()), ("turnaround_set", valid_turnaround())],
)
def test_m1_002_top_level_contracts_are_closed(name: str, instance: dict) -> None:
    mutated = copy.deepcopy(instance)
    mutated["provider_private_payload"] = {"temporary_url": "https://example.invalid"}
    with pytest.raises(ValidationError):
        Draft202012Validator(schema(name)).validate(mutated)


def test_visual_concept_rejects_svg_as_canonical_generated_artifact() -> None:
    mutated = copy.deepcopy(valid_concept())
    mutated["artifacts"][0]["media_type"] = "image/svg+xml"
    with pytest.raises(ValidationError):
        Draft202012Validator(schema("visual_concept")).validate(mutated)


def test_full_turnaround_requires_six_views() -> None:
    mutated = copy.deepcopy(valid_turnaround())
    mutated["views"] = mutated["views"][:4]
    with pytest.raises(ValidationError):
        Draft202012Validator(schema("turnaround_set")).validate(mutated)
