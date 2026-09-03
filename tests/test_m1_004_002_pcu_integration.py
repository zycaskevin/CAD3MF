from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import trimesh

pytest.importorskip("point_cloud_utils")

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "services" / "mesh-worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import robust_repair as robust  # noqa: E402

SHA = "c" * 64


def test_point_cloud_utils_repairs_a_deliberately_open_mesh() -> None:
    mesh = trimesh.creation.box(extents=[40.0, 60.0, 120.0])
    keep = np.ones(len(mesh.faces), dtype=bool)
    keep[[0, 1, 2]] = False
    mesh.update_faces(keep)
    assert mesh.is_watertight is False

    output, report = robust.robust_repair(
        mesh,
        backend=robust.PointCloudUtilsRobustRepairBackend(),
        quality_tier="preview",
        fidelity_policy={
            "max_extent_drift_mm": 1000.0,
            "max_centroid_drift_mm": 1000.0,
            "max_sampled_vertex_chamfer_mm": 1000.0,
            "max_sampled_vertex_hausdorff_mm": 1000.0,
            "sample_count": 128,
        },
        report_id="pcu-report-1",
        request_id="pcu-request-1",
        project_id="pcu-integration",
        source_mesh_artifact_id="open-box",
        source_sha256=SHA,
        created_at="2026-09-03T00:00:00Z",
    )

    assert output is not None
    assert report["backend"]["backend_id"] == "point-cloud-utils"
    assert report["backend"]["algorithm_id"] == "watertight-manifold-reconstruction"
    assert report["backend"]["version"] != "unavailable"
    assert report["reconstruction_budget"]["resolution_budget"] == 5_000
    assert report["status"] == "reconstructed_topology_valid"
    assert report["output_metrics"]["watertight"] is True
    assert report["output_metrics"]["boundary_edge_count"] == 0
    assert report["output_metrics"]["nonmanifold_edge_count"] == 0
    assert report["output_metrics"]["winding_consistent"] is True
    assert report["appearance_rebake_required"] is True
