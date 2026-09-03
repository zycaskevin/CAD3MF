from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
import trimesh
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "services" / "mesh-worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import manufacturing_analysis as engine  # noqa: E402

SCHEMA = (
    ROOT
    / "packages/printable-mesh/schemas/manufacturing-geometry-analysis-report-0.1.0.json"
)
SHA = "b" * 64


def load_schema() -> dict:
    return json.loads(SCHEMA.read_text(encoding="utf-8"))


class FakeSelfAnalyzer:
    backend_id = "fake-self"
    algorithm_id = "fixture"
    version = "1.0"

    def __init__(self, *, intersects: bool = False):
        self.intersects = intersects

    def analyze(self, _mesh):
        return {
            "status": "fail" if self.intersects else "pass",
            "has_intersections": self.intersects,
            "candidate_pair_count": 3,
            "tested_pair_count": 3,
            "intersecting_pair_count": 1 if self.intersects else 0,
            "exhaustive": True,
            "notes": [],
        }


class FakeRayAnalyzer:
    backend_id = "fake-ray"
    algorithm_id = "fixture"
    version = "1.0"

    def __init__(self, *, thickness=2.0, feature=1.5):
        self.thickness = thickness
        self.feature = feature
        self.called = False

    def analyze(
        self,
        mesh,
        *,
        minimum_thickness_mm,
        minimum_feature_mm,
        max_face_samples,
    ):
        self.called = True
        total = len(mesh.faces)
        return (
            {
                "status": (
                    "unknown"
                    if minimum_thickness_mm is None
                    else "pass"
                    if self.thickness >= minimum_thickness_mm
                    else "fail"
                ),
                "threshold_mm": minimum_thickness_mm,
                "observed_min_mm": self.thickness,
                "sampled_face_count": total,
                "total_face_count": total,
                "hit_count": total,
                "exhaustive": True,
                "method_scope": "inward_face_normal_chord",
                "notes": [],
            },
            {
                "status": (
                    "unknown"
                    if minimum_feature_mm is None
                    else "pass"
                    if self.feature >= minimum_feature_mm
                    else "fail"
                ),
                "threshold_mm": minimum_feature_mm,
                "observed_min_mm": self.feature,
                "sampled_face_count": total,
                "total_face_count": total,
                "hit_count": 2,
                "exhaustive": max_face_samples >= total,
                "method_scope": "outward_opposing_surface_clearance",
                "notes": [],
            },
        )


class UnavailableSelfAnalyzer(FakeSelfAnalyzer):
    def analyze(self, _mesh):
        raise engine.AnalysisBackendUnavailable("self backend missing")


def analyze(mesh, *, required=None, self_backend=None, ray_backend=None):
    return engine.analyze_manufacturing_geometry(
        mesh,
        required_checks=required
        or {"self_intersections", "minimum_thickness", "minimum_feature"},
        minimum_thickness_mm=1.0,
        minimum_feature_mm=0.8,
        self_intersection_backend=self_backend or FakeSelfAnalyzer(),
        ray_backend=ray_backend or FakeRayAnalyzer(),
        max_face_samples=1000,
        analysis_id="analysis-1",
        project_id="m1-004-003-test",
        source_mesh_artifact_id="mesh-1",
        source_sha256=SHA,
        created_at="2026-09-03T00:00:00Z",
    )


def test_analysis_schema_is_valid_draft_2020_12() -> None:
    Draft202012Validator.check_schema(load_schema())


def test_closed_box_passes_all_fake_geometry_checks() -> None:
    report = analyze(trimesh.creation.box(extents=[20.0, 30.0, 40.0]))

    assert report["overall_status"] == "pass"
    assert report["self_intersections"]["status"] == "pass"
    assert report["minimum_thickness"]["observed_min_mm"] == 2.0
    assert report["minimum_feature"]["observed_min_mm"] == 1.5
    Draft202012Validator(load_schema()).validate(report)


def test_self_intersection_failure_rejects_geometry_analysis() -> None:
    report = analyze(
        trimesh.creation.box(),
        self_backend=FakeSelfAnalyzer(intersects=True),
    )

    assert report["self_intersections"]["has_intersections"] is True
    assert report["overall_status"] == "fail"


def test_thickness_failure_rejects_geometry_analysis() -> None:
    report = analyze(
        trimesh.creation.box(),
        ray_backend=FakeRayAnalyzer(thickness=0.6, feature=2.0),
    )

    assert report["minimum_thickness"]["status"] == "fail"
    assert report["overall_status"] == "fail"


def test_feature_failure_rejects_geometry_analysis() -> None:
    report = analyze(
        trimesh.creation.box(),
        ray_backend=FakeRayAnalyzer(thickness=2.0, feature=0.4),
    )

    assert report["minimum_feature"]["status"] == "fail"
    assert report["overall_status"] == "fail"


def test_backend_unavailable_fails_closed() -> None:
    report = analyze(
        trimesh.creation.box(),
        required={"self_intersections"},
        self_backend=UnavailableSelfAnalyzer(),
    )

    assert report["self_intersections"]["status"] == "backend_unavailable"
    assert report["overall_status"] == "backend_unavailable"


def test_open_mesh_blocks_ray_measurement_without_calling_backend() -> None:
    mesh = trimesh.creation.box()
    mask = [True] * len(mesh.faces)
    mask[0] = False
    mesh.update_faces(mask)
    ray = FakeRayAnalyzer()

    report = analyze(
        mesh,
        required={"minimum_thickness", "minimum_feature"},
        ray_backend=ray,
    )

    assert ray.called is False
    assert report["minimum_thickness"]["status"] == "unknown"
    assert report["minimum_feature"]["status"] == "unknown"
    assert report["overall_status"] == "unknown"


def test_analysis_maps_into_existing_printable_mesh_checks() -> None:
    report = analyze(trimesh.creation.box())
    base = {
        name: {
            "status": "not_run",
            "required": False,
            "value": None,
            "unit": "none",
            "notes": [],
        }
        for name in (
            "watertight",
            "closed_boundary",
            "manifold_edges",
            "winding_consistent",
            "self_intersections",
            "minimum_thickness",
            "minimum_feature",
        )
    }

    merged = engine.apply_analysis_to_printable_checks(
        base,
        report,
        required_checks={"self_intersections", "minimum_thickness", "minimum_feature"},
    )

    assert merged["self_intersections"]["status"] == "pass"
    assert merged["self_intersections"]["value"] is False
    assert merged["minimum_thickness"]["value"] == 2.0
    assert merged["minimum_feature"]["value"] == 1.5
    assert merged["minimum_feature"]["unit"] == "mm"


def test_missing_threshold_remains_unknown_not_pass() -> None:
    report = engine.analyze_manufacturing_geometry(
        trimesh.creation.box(),
        required_checks={"minimum_thickness"},
        minimum_thickness_mm=None,
        minimum_feature_mm=None,
        self_intersection_backend=FakeSelfAnalyzer(),
        ray_backend=FakeRayAnalyzer(),
        max_face_samples=1000,
        analysis_id="analysis-2",
        project_id="m1-004-003-test",
        source_mesh_artifact_id="mesh-2",
        source_sha256=SHA,
        created_at="2026-09-03T00:00:00Z",
    )

    assert report["minimum_thickness"]["status"] == "unknown"
    assert report["overall_status"] == "unknown"


def test_non_positive_max_face_samples_is_rejected_by_ray_backend() -> None:
    with pytest.raises(ValueError):
        engine._sample_face_indexes(10, 0)
