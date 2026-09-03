from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

import numpy as np
import pytest
import trimesh
from jsonschema import Draft202012Validator, ValidationError

ROOT = Path(__file__).resolve().parents[1]
REQUEST_SCHEMA = ROOT / "packages/printable-mesh/schemas/printable-mesh-request-0.1.0.json"
REPORT_SCHEMA = ROOT / "packages/printable-mesh/schemas/printable-mesh-report-0.1.0.json"
ENGINE_PATH = ROOT / "services/mesh-worker/printable_mesh.py"
SHA = "a" * 64

spec = importlib.util.spec_from_file_location("cad3mf_printable_mesh", ENGINE_PATH)
assert spec is not None and spec.loader is not None
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def request_fixture() -> dict:
    return {
        "schema_version": "0.1.0",
        "request_id": "printable-request-1",
        "project_id": "figurine-demo",
        "source_mesh_artifact_id": "mesh-1",
        "source_sha256": SHA,
        "operation": "diagnose_and_repair",
        "validation_requirements": [
            "watertight",
            "closed_boundary",
            "manifold_edges",
            "winding_consistent",
        ],
        "minimum_thickness_mm": None,
        "minimum_feature_mm": None,
        "repair_policy": {
            "preserve_metric_scale": True,
            "merge_vertices": True,
            "remove_duplicate_faces": True,
            "remove_degenerate_faces": True,
            "remove_unreferenced_vertices": True,
            "fix_normals": True,
            "fill_small_holes": True,
        },
        "metric_scale_tolerance_mm": 0.001,
        "status": "submitted",
        "created_at": "2026-09-03T00:00:00Z",
    }


def repair(mesh: trimesh.Trimesh, required_checks=None):
    checks = required_checks or engine.TOPOLOGY_CHECKS
    return engine.repair_topology(
        mesh,
        required_checks=checks,
        report_id="report-1",
        project_id="m1-004-test",
        source_mesh_artifact_id="mesh-1",
        source_sha256=SHA,
        metric_scale_tolerance_mm=0.001,
        created_at="2026-09-03T00:00:00Z",
    )


def operation(report: dict, name: str) -> dict:
    return next(item for item in report["repair_operations"] if item["operation"] == name)


@pytest.mark.parametrize("path", [REQUEST_SCHEMA, REPORT_SCHEMA])
def test_m1_004_schemas_are_valid_draft_2020_12(path: Path) -> None:
    Draft202012Validator.check_schema(load(path))


def test_printable_mesh_request_is_closed_and_cannot_shortcut_printability() -> None:
    schema = load(REQUEST_SCHEMA)
    Draft202012Validator(schema).validate(request_fixture())

    invalid = copy.deepcopy(request_fixture())
    invalid["printable"] = True
    with pytest.raises(ValidationError):
        Draft202012Validator(schema).validate(invalid)


def test_closed_metric_cube_needs_no_topology_repair() -> None:
    mesh = trimesh.creation.box(extents=[40.0, 60.0, 120.0])
    repaired, report = repair(mesh)

    assert report["status"] == "valid_no_repair"
    assert report["checks"]["watertight"]["status"] == "pass"
    assert report["checks"]["closed_boundary"]["value"] == 0
    assert report["checks"]["manifold_edges"]["value"] == 0
    assert report["metric_invariant"]["preserved"] is True
    assert report["metric_invariant"]["non_uniform_scale_applied"] is False
    assert np.allclose(repaired.extents, [40.0, 60.0, 120.0])
    Draft202012Validator(load(REPORT_SCHEMA)).validate(report)


def test_small_hole_is_filled_without_scale_drift() -> None:
    mesh = trimesh.creation.box(extents=[40.0, 60.0, 120.0])
    keep = np.ones(len(mesh.faces), dtype=bool)
    keep[0] = False
    mesh.update_faces(keep)
    assert mesh.is_watertight is False

    repaired, report = repair(mesh)

    assert repaired.is_watertight is True
    assert report["status"] == "repaired_topology_valid"
    assert report["checks"]["closed_boundary"]["value"] == 0
    assert report["metric_invariant"]["max_extent_drift_mm"] <= 0.001
    assert report["appearance_rebake_required"] is True
    assert operation(report, "fill_small_holes")["status"] == "applied"
    Draft202012Validator(load(REPORT_SCHEMA)).validate(report)


def test_duplicate_faces_and_unreferenced_vertices_are_audited_and_removed() -> None:
    box = trimesh.creation.box(extents=[20.0, 30.0, 40.0])
    vertices = np.vstack((box.vertices, [[999.0, 999.0, 999.0]]))
    faces = np.vstack((box.faces, box.faces[0]))
    dirty = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)

    _repaired, report = repair(dirty)

    assert report["input_metrics"]["duplicate_face_count"] == 1
    assert report["input_metrics"]["unreferenced_vertex_count"] == 1
    assert report["output_metrics"]["duplicate_face_count"] == 0
    assert report["output_metrics"]["unreferenced_vertex_count"] == 0
    assert report["metric_invariant"]["preserved"] is True
    assert report["status"] == "repaired_topology_valid"


def test_component_count_has_no_graph_engine_dependency() -> None:
    left = trimesh.creation.box(extents=[10.0, 10.0, 10.0])
    right = trimesh.creation.box(extents=[10.0, 10.0, 10.0])
    right.apply_translation([30.0, 0.0, 0.0])
    offset = len(left.vertices)
    vertices = np.vstack((left.vertices, right.vertices))
    faces = np.vstack((left.faces, right.faces + offset))
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)

    metrics = engine.diagnose_mesh(mesh)

    assert metrics["component_count"] == 2
    assert metrics["boundary_edge_count"] == 0
    assert metrics["nonmanifold_edge_count"] == 0


def test_local_winding_flip_is_repaired_without_texture_rebake_flag() -> None:
    box = trimesh.creation.box(extents=[20.0, 30.0, 40.0])
    faces = np.asarray(box.faces).copy()
    faces[0] = faces[0][::-1]
    dirty = trimesh.Trimesh(vertices=box.vertices.copy(), faces=faces, process=False)
    assert dirty.is_winding_consistent is False

    repaired, report = repair(dirty)

    assert repaired.is_winding_consistent is True
    assert report["checks"]["winding_consistent"]["status"] == "pass"
    assert operation(report, "fix_normals")["status"] == "applied"
    assert report["appearance_rebake_required"] is False
    assert report["metric_invariant"]["preserved"] is True


def test_large_boundary_loop_is_not_aggressively_filled() -> None:
    mesh = trimesh.creation.icosphere(subdivisions=1, radius=20.0)
    keep = ~np.any(np.asarray(mesh.faces) == 0, axis=1)
    mesh.update_faces(keep)
    mesh.remove_unreferenced_vertices()
    assert mesh.is_watertight is False

    repaired, report = repair(mesh)

    assert repaired.is_watertight is False
    assert report["status"] == "needs_robust_repair"
    assert report["checks"]["closed_boundary"]["status"] == "fail"
    fill = operation(report, "fill_small_holes")
    assert fill["status"] == "no_change"
    assert "exceed 4 vertices" in (fill["note"] or "")


def test_unimplemented_required_checks_block_validation_claim() -> None:
    mesh = trimesh.creation.box(extents=[20.0, 30.0, 40.0])
    required = (*engine.TOPOLOGY_CHECKS, "self_intersections")
    _repaired, report = repair(mesh, required)

    check = report["checks"]["self_intersections"]
    assert check["required"] is True
    assert check["status"] == "not_run"
    assert report["status"] == "needs_additional_validation"
    assert "printable" not in report
    Draft202012Validator(load(REPORT_SCHEMA)).validate(report)
