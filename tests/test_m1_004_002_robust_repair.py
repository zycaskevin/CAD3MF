from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import numpy as np
import pytest
import trimesh
from jsonschema import Draft202012Validator, ValidationError

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "services" / "mesh-worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import robust_repair as robust  # noqa: E402

REQUEST_SCHEMA = ROOT / "packages/printable-mesh/schemas/robust-repair-request-0.1.0.json"
REPORT_SCHEMA = ROOT / "packages/printable-mesh/schemas/robust-repair-report-0.1.0.json"
SHA = "b" * 64


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def fidelity_policy(limit: float = 0.01) -> dict[str, float | int]:
    return {
        "max_extent_drift_mm": limit,
        "max_centroid_drift_mm": limit,
        "max_sampled_vertex_chamfer_mm": limit,
        "max_sampled_vertex_hausdorff_mm": limit,
        "sample_count": 128,
    }


def request_fixture() -> dict:
    return {
        "schema_version": "0.1.0",
        "request_id": "robust-request-1",
        "project_id": "figurine-demo",
        "source_mesh_artifact_id": "mesh-1",
        "source_sha256": SHA,
        "strategy": "watertight_reconstruction",
        "quality_tier": "standard",
        "fidelity_policy": fidelity_policy(),
        "notes": [],
        "status": "submitted",
        "created_at": "2026-09-03T00:00:00Z",
    }


def run(mesh: trimesh.Trimesh, backend, *, policy=None, quality="preview"):
    return robust.robust_repair(
        mesh,
        backend=backend,
        quality_tier=quality,
        fidelity_policy=policy or fidelity_policy(),
        report_id="report-1",
        request_id="robust-request-1",
        project_id="m1-004-002-test",
        source_mesh_artifact_id="mesh-1",
        source_sha256=SHA,
        created_at="2026-09-03T00:00:00Z",
    )


class PassthroughBackend:
    backend_id = "passthrough-ci"
    algorithm_id = "identity-fixture"
    version = "1"

    def reconstruct(self, vertices_mm, faces, *, quality_tier):
        assert quality_tier in robust.QUALITY_RESOLUTION_BUDGET
        return robust.BackendMesh(vertices=np.array(vertices_mm), faces=np.array(faces))


class DistortingBackend(PassthroughBackend):
    backend_id = "distorting-ci"

    def reconstruct(self, vertices_mm, faces, *, quality_tier):
        return robust.BackendMesh(
            vertices=np.asarray(vertices_mm, dtype=np.float64) * 1.25,
            faces=np.array(faces),
        )


class InvalidTopologyBackend(PassthroughBackend):
    backend_id = "invalid-topology-ci"

    def reconstruct(self, vertices_mm, faces, *, quality_tier):
        return robust.BackendMesh(
            vertices=np.array(vertices_mm),
            faces=np.asarray(faces, dtype=np.int64)[:-1],
        )


class UnavailableBackend(PassthroughBackend):
    backend_id = "missing-ci"
    version = "unavailable"

    def reconstruct(self, vertices_mm, faces, *, quality_tier):
        raise robust.RobustRepairBackendUnavailable("fixture backend unavailable")


@pytest.mark.parametrize("path", [REQUEST_SCHEMA, REPORT_SCHEMA])
def test_m1_004_002_schemas_are_valid_draft_2020_12(path: Path) -> None:
    Draft202012Validator.check_schema(load(path))


def test_request_contract_is_closed_and_provider_neutral() -> None:
    schema = load(REQUEST_SCHEMA)
    Draft202012Validator(schema).validate(request_fixture())

    invalid = copy.deepcopy(request_fixture())
    invalid["provider"] = "point-cloud-utils"
    with pytest.raises(ValidationError):
        Draft202012Validator(schema).validate(invalid)


def test_quality_tiers_have_deterministic_resolution_budgets() -> None:
    assert robust.resolution_budget_for_quality("preview") == 5_000
    assert robust.resolution_budget_for_quality("standard") == 20_000
    assert robust.resolution_budget_for_quality("high") == 50_000
    assert robust.resolution_budget_for_quality("ultra") == 100_000
    with pytest.raises(ValueError):
        robust.resolution_budget_for_quality("provider-magic")


def test_valid_backend_output_must_pass_topology_and_fidelity() -> None:
    mesh = trimesh.creation.box(extents=[40.0, 60.0, 120.0])
    output, report = run(mesh, PassthroughBackend())

    assert output is not None
    assert report["status"] == "reconstructed_topology_valid"
    assert report["output_metrics"]["watertight"] is True
    assert report["fidelity"]["pass"] is True
    assert report["fidelity"]["sampled_vertex_hausdorff_mm"] == pytest.approx(0.0)
    assert report["appearance_rebake_required"] is True
    assert report["backend"] == {
        "backend_id": "passthrough-ci",
        "algorithm_id": "identity-fixture",
        "version": "1",
    }
    Draft202012Validator(load(REPORT_SCHEMA)).validate(report)


def test_watertight_but_distorted_output_is_rejected_by_fidelity() -> None:
    mesh = trimesh.creation.box(extents=[40.0, 60.0, 120.0])
    output, report = run(mesh, DistortingBackend(), policy=fidelity_policy(0.1))

    assert output is not None
    assert report["output_metrics"]["watertight"] is True
    assert report["fidelity"]["pass"] is False
    assert "max_extent_drift_mm" in report["fidelity"]["failed_thresholds"]
    assert report["status"] == "rejected_fidelity"
    Draft202012Validator(load(REPORT_SCHEMA)).validate(report)


def test_backend_output_is_revalidated_and_invalid_topology_fails_closed() -> None:
    mesh = trimesh.creation.box(extents=[20.0, 30.0, 40.0])
    output, report = run(mesh, InvalidTopologyBackend(), policy=fidelity_policy(100.0))

    assert output is not None
    assert report["output_metrics"]["watertight"] is False
    assert report["status"] == "reconstruction_invalid"
    Draft202012Validator(load(REPORT_SCHEMA)).validate(report)


def test_unavailable_backend_has_no_silent_fallback() -> None:
    mesh = trimesh.creation.box(extents=[20.0, 30.0, 40.0])
    output, report = run(mesh, UnavailableBackend())

    assert output is None
    assert report["status"] == "backend_unavailable"
    assert report["output_metrics"] is None
    assert report["fidelity"] is None
    assert "unavailable" in report["notes"][0]
    Draft202012Validator(load(REPORT_SCHEMA)).validate(report)
