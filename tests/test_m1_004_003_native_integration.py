from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import trimesh

pytest.importorskip("fcl")
pytest.importorskip("point_cloud_utils")

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "services" / "mesh-worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import manufacturing_analysis as engine  # noqa: E402

SHA = "c" * 64


def analyze(mesh, *, thickness=1.0, feature=0.8):
    return engine.analyze_manufacturing_geometry(
        mesh,
        required_checks={"self_intersections", "minimum_thickness", "minimum_feature"},
        minimum_thickness_mm=thickness,
        minimum_feature_mm=feature,
        self_intersection_backend=engine.FclSelfIntersectionAnalyzer(),
        ray_backend=engine.PcuRayMeasurementAnalyzer(),
        max_face_samples=100_000,
        analysis_id="native-analysis",
        project_id="m1-004-003-native",
        source_mesh_artifact_id="native-mesh",
        source_sha256=SHA,
        created_at="2026-09-03T00:00:00Z",
    )


def test_real_fcl_detects_non_adjacent_triangle_self_intersection() -> None:
    vertices = np.array(
        [
            [-1.0, -1.0, 0.0],
            [1.0, -1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, -0.5, -1.0],
            [0.0, -0.5, 1.0],
            [0.0, 0.8, 0.3],
        ],
        dtype=np.float64,
    )
    mesh = trimesh.Trimesh(
        vertices=vertices,
        faces=np.array([[0, 1, 2], [3, 4, 5]], dtype=np.int64),
        process=False,
    )

    result = engine.FclSelfIntersectionAnalyzer().analyze(mesh)

    assert result["status"] == "fail"
    assert result["has_intersections"] is True
    assert result["intersecting_pair_count"] >= 1
    assert result["exhaustive"] is True


def test_real_fcl_reports_closed_box_without_self_intersection() -> None:
    result = engine.FclSelfIntersectionAnalyzer().analyze(
        trimesh.creation.box(extents=[20.0, 30.0, 40.0])
    )

    assert result["status"] == "pass"
    assert result["has_intersections"] is False
    assert result["intersecting_pair_count"] == 0


def test_real_fcl_accepts_legal_coplanar_shared_edge() -> None:
    vertices = np.array(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [1.0, 1.0, 0.0],
        ],
        dtype=np.float64,
    )
    mesh = trimesh.Trimesh(
        vertices=vertices,
        faces=np.array([[0, 1, 2], [1, 3, 2]], dtype=np.int64),
        process=False,
    )

    result = engine.FclSelfIntersectionAnalyzer().analyze(mesh)

    assert result["status"] == "pass"
    assert result["has_intersections"] is False


def test_real_fcl_detects_shared_vertex_pair_intersecting_elsewhere() -> None:
    vertices = np.array(
        [
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [1.0, -1.0, -1.0],
            [1.0, 1.0, 1.0],
        ],
        dtype=np.float64,
    )
    mesh = trimesh.Trimesh(
        vertices=vertices,
        faces=np.array([[0, 1, 2], [0, 3, 4]], dtype=np.int64),
        process=False,
    )

    result = engine.FclSelfIntersectionAnalyzer().analyze(mesh)

    assert result["status"] == "fail"
    assert result["has_intersections"] is True
    assert result["intersecting_pair_count"] == 1


def test_real_fcl_detects_coplanar_overlap_beyond_shared_edge() -> None:
    vertices = np.array(
        [
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [1.0, 1.0, 0.0],
        ],
        dtype=np.float64,
    )
    mesh = trimesh.Trimesh(
        vertices=vertices,
        faces=np.array([[0, 1, 2], [0, 1, 3]], dtype=np.int64),
        process=False,
    )

    result = engine.FclSelfIntersectionAnalyzer().analyze(mesh)

    assert result["status"] == "fail"
    assert result["has_intersections"] is True
    assert result["intersecting_pair_count"] == 1


def test_real_embree_face_normal_rays_measure_box_thickness() -> None:
    report = analyze(
        trimesh.creation.box(extents=[20.0, 30.0, 40.0]),
        thickness=5.0,
        feature=0.8,
    )

    thickness = report["minimum_thickness"]
    feature = report["minimum_feature"]
    assert thickness["status"] == "pass"
    assert thickness["exhaustive"] is True
    assert thickness["observed_min_mm"] == pytest.approx(20.0, abs=1e-4)
    assert feature["status"] == "pass"
    assert feature["observed_min_mm"] is None
    assert report["overall_status"] == "pass"


def test_real_embree_detects_sub_threshold_thin_member() -> None:
    report = analyze(
        trimesh.creation.box(extents=[0.6, 20.0, 20.0]),
        thickness=0.8,
        feature=0.4,
    )

    thickness = report["minimum_thickness"]
    assert thickness["observed_min_mm"] == pytest.approx(0.6, abs=1e-4)
    assert thickness["status"] == "fail"
    assert report["overall_status"] == "fail"


def test_real_embree_detects_narrow_exterior_gap_as_minimum_feature() -> None:
    left = trimesh.creation.box(extents=[10.0, 10.0, 10.0])
    right = trimesh.creation.box(extents=[10.0, 10.0, 10.0])
    left.apply_translation([-5.25, 0.0, 0.0])
    right.apply_translation([5.25, 0.0, 0.0])
    mesh = trimesh.util.concatenate([left, right])

    report = analyze(mesh, thickness=2.0, feature=0.8)

    feature = report["minimum_feature"]
    assert report["prerequisites"] == {
        "watertight": True,
        "manifold_edges": True,
        "winding_consistent": True,
    }
    assert feature["observed_min_mm"] == pytest.approx(0.5, abs=1e-4)
    assert feature["status"] == "fail"
    assert report["overall_status"] == "fail"
