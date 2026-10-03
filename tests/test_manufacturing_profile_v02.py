from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "packages/manufacturing/schemas/manufacturing-profile-0.1.0.json"
PROFILE = ROOT / "packages/manufacturing/profiles/bambu-class-petg-0.4-starter.json"


def test_manufacturing_profile_schema_and_starter_profile_validate() -> None:
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    profile = json.loads(PROFILE.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(profile)


def test_starter_profile_does_not_claim_machine_specific_authority() -> None:
    profile = json.loads(PROFILE.read_text(encoding="utf-8"))
    assert profile["machine_scope"]["machine_specific"] is False
    assert profile["calibration"]["required"] is True
    assert profile["calibration"]["evidence_status"] == "unverified"
    assert profile["status"] == "starter_policy"
