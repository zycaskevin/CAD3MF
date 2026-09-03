from __future__ import annotations

from dataclasses import dataclass
from importlib import metadata
from typing import Any, Protocol

import numpy as np
import trimesh

from printable_mesh import diagnose_mesh

QUALITY_RESOLUTION_BUDGET = {
    "preview": 5_000,
    "standard": 20_000,
    "high": 50_000,
    "ultra": 100_000,
}


class RobustRepairBackendUnavailable(RuntimeError):
    """Raised when a configured robust-repair backend cannot be loaded."""


@dataclass(frozen=True)
class BackendMesh:
    vertices: np.ndarray
    faces: np.ndarray


class RobustRepairBackend(Protocol):
    backend_id: str
    algorithm_id: str

    @property
    def version(self) -> str: ...

    def reconstruct(
        self,
        vertices_mm: np.ndarray,
        faces: np.ndarray,
        *,
        quality_tier: str,
    ) -> BackendMesh: ...


class PointCloudUtilsRobustRepairBackend:
    backend_id = "point-cloud-utils"
    algorithm_id = "watertight-manifold-reconstruction"

    @property
    def version(self) -> str:
        try:
            return metadata.version("point-cloud-utils")
        except metadata.PackageNotFoundError:
            return "unavailable"

    def reconstruct(
        self,
        vertices_mm: np.ndarray,
        faces: np.ndarray,
        *,
        quality_tier: str,
    ) -> BackendMesh:
        resolution = resolution_budget_for_quality(quality_tier)
        try:
            import point_cloud_utils as pcu
        except ImportError as exc:
            raise RobustRepairBackendUnavailable(
                "point-cloud-utils is not installed in this robust-repair runtime"
            ) from exc

        vertices = np.asarray(vertices_mm, dtype=np.float64)
        triangles = np.asarray(faces, dtype=np.int32)
        repaired_vertices, repaired_faces = pcu.make_mesh_watertight(
            vertices,
            triangles,
            resolution=resolution,
        )
        return BackendMesh(
            vertices=np.asarray(repaired_vertices, dtype=np.float64),
            faces=np.asarray(repaired_faces, dtype=np.int64),
        )


def resolution_budget_for_quality(quality_tier: str) -> int:
    try:
        return QUALITY_RESOLUTION_BUDGET[quality_tier]
    except KeyError as exc:
        raise ValueError(f"unsupported robust repair quality tier: {quality_tier}") from exc


def _backend_provenance(backend: RobustRepairBackend) -> dict[str, str]:
    return {
        "backend_id": str(backend.backend_id),
        "algorithm_id": str(backend.algorithm_id),
        "version": str(backend.version),
    }


def _face_referenced_vertices(mesh: trimesh.Trimesh) -> np.ndarray:
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if len(vertices) == 0 or len(faces) == 0:
        return np.empty((0, 3), dtype=np.float64)
    referenced = np.unique(faces.reshape(-1))
    return vertices[referenced]


def _mesh_centroid(mesh: trimesh.Trimesh) -> np.ndarray:
    vertices = _face_referenced_vertices(mesh)
    if len(vertices) == 0:
        return np.zeros(3, dtype=np.float64)
    return vertices.mean(axis=0)


def _mesh_extents(mesh: trimesh.Trimesh) -> np.ndarray:
    vertices = _face_referenced_vertices(mesh)
    if len(vertices) == 0:
        return np.zeros(3, dtype=np.float64)
    return vertices.max(axis=0) - vertices.min(axis=0)


def _sample_vertices(vertices: np.ndarray, count: int) -> np.ndarray:
    if count <= 0:
        raise ValueError("sample count must be positive")
    if len(vertices) <= count:
        return np.asarray(vertices, dtype=np.float64)
    indexes = np.linspace(0, len(vertices) - 1, num=count, dtype=np.int64)
    return np.asarray(vertices[indexes], dtype=np.float64)


def _nearest_distances(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    if len(source) == 0 or len(target) == 0:
        return np.full(len(source), np.inf, dtype=np.float64)

    result = np.empty(len(source), dtype=np.float64)
    chunk_size = 128
    for start in range(0, len(source), chunk_size):
        stop = min(start + chunk_size, len(source))
        delta = source[start:stop, None, :] - target[None, :, :]
        squared = np.einsum("ijk,ijk->ij", delta, delta)
        result[start:stop] = np.sqrt(squared.min(axis=1))
    return result


def _fidelity_metrics(
    source: trimesh.Trimesh,
    output: trimesh.Trimesh,
    *,
    policy: dict[str, float | int],
) -> dict[str, Any]:
    source_vertices = _face_referenced_vertices(source)
    output_vertices = _face_referenced_vertices(output)
    requested_samples = int(policy["sample_count"])
    actual_samples = min(requested_samples, len(source_vertices), len(output_vertices))

    source_sample = _sample_vertices(source_vertices, actual_samples)
    output_sample = _sample_vertices(output_vertices, actual_samples)
    source_to_output = _nearest_distances(source_sample, output_sample)
    output_to_source = _nearest_distances(output_sample, source_sample)

    chamfer = float((source_to_output.mean() + output_to_source.mean()) / 2.0)
    hausdorff = float(max(source_to_output.max(), output_to_source.max()))
    extent_drift = np.abs(_mesh_extents(output) - _mesh_extents(source))
    centroid_drift = float(np.linalg.norm(_mesh_centroid(output) - _mesh_centroid(source)))

    failed: list[str] = []
    max_extent = float(extent_drift.max())
    if max_extent > float(policy["max_extent_drift_mm"]):
        failed.append("max_extent_drift_mm")
    if centroid_drift > float(policy["max_centroid_drift_mm"]):
        failed.append("max_centroid_drift_mm")
    if chamfer > float(policy["max_sampled_vertex_chamfer_mm"]):
        failed.append("max_sampled_vertex_chamfer_mm")
    if hausdorff > float(policy["max_sampled_vertex_hausdorff_mm"]):
        failed.append("max_sampled_vertex_hausdorff_mm")

    return {
        "extent_drift_mm": {
            "x": float(extent_drift[0]),
            "y": float(extent_drift[1]),
            "z": float(extent_drift[2]),
            "max": max_extent,
        },
        "centroid_drift_mm": centroid_drift,
        "sampled_vertex_chamfer_mm": chamfer,
        "sampled_vertex_hausdorff_mm": hausdorff,
        "sample_count": actual_samples,
        "pass": not failed,
        "failed_thresholds": failed,
    }


def _validate_backend_mesh(result: BackendMesh) -> trimesh.Trimesh:
    vertices = np.asarray(result.vertices, dtype=np.float64)
    faces = np.asarray(result.faces, dtype=np.int64)
    if vertices.ndim != 2 or vertices.shape[1] != 3 or len(vertices) == 0:
        raise ValueError("robust repair backend returned invalid vertex array")
    if faces.ndim != 2 or faces.shape[1] != 3 or len(faces) == 0:
        raise ValueError("robust repair backend returned invalid face array")
    if not np.isfinite(vertices).all():
        raise ValueError("robust repair backend returned non-finite vertices")
    if faces.min() < 0 or faces.max() >= len(vertices):
        raise ValueError("robust repair backend returned out-of-range face indexes")
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def _topology_is_valid(metrics: dict[str, Any]) -> bool:
    return bool(
        metrics["watertight"]
        and metrics["boundary_edge_count"] == 0
        and metrics["nonmanifold_edge_count"] == 0
        and metrics["winding_consistent"]
    )


def robust_repair(
    mesh: trimesh.Trimesh,
    *,
    backend: RobustRepairBackend,
    quality_tier: str,
    fidelity_policy: dict[str, float | int],
    report_id: str,
    request_id: str,
    project_id: str,
    source_mesh_artifact_id: str,
    source_sha256: str,
    created_at: str,
) -> tuple[trimesh.Trimesh | None, dict[str, Any]]:
    resolution = resolution_budget_for_quality(quality_tier)
    source = mesh.copy()
    input_metrics = diagnose_mesh(source)
    provenance = _backend_provenance(backend)
    base_report: dict[str, Any] = {
        "schema_version": "0.1.0",
        "report_id": report_id,
        "request_id": request_id,
        "project_id": project_id,
        "source_mesh_artifact_id": source_mesh_artifact_id,
        "source_sha256": source_sha256,
        "output_sha256": None,
        "backend": provenance,
        "reconstruction_budget": {
            "quality_tier": quality_tier,
            "resolution_budget": resolution,
        },
        "input_metrics": input_metrics,
        "output_metrics": None,
        "fidelity": None,
        "appearance_rebake_required": True,
        "notes": [],
        "created_at": created_at,
    }

    try:
        result = backend.reconstruct(
            np.asarray(source.vertices, dtype=np.float64),
            np.asarray(source.faces, dtype=np.int64),
            quality_tier=quality_tier,
        )
        output = _validate_backend_mesh(result)
    except RobustRepairBackendUnavailable as exc:
        report = dict(base_report)
        report["status"] = "backend_unavailable"
        report["notes"] = [str(exc)]
        return None, report
    except Exception as exc:
        report = dict(base_report)
        report["status"] = "backend_error"
        report["notes"] = [f"{type(exc).__name__}: {exc}"]
        return None, report

    output_metrics = diagnose_mesh(output)
    fidelity = _fidelity_metrics(source, output, policy=fidelity_policy)
    report = dict(base_report)
    report["output_metrics"] = output_metrics
    report["fidelity"] = fidelity

    if not _topology_is_valid(output_metrics):
        report["status"] = "reconstruction_invalid"
        report["notes"] = ["Backend output failed CAD3MF topology re-validation."]
    elif not fidelity["pass"]:
        report["status"] = "rejected_fidelity"
        failed = ", ".join(fidelity["failed_thresholds"])
        report["notes"] = [f"Reconstruction exceeded fidelity thresholds: {failed}"]
    else:
        report["status"] = "reconstructed_topology_valid"
        report["notes"] = [
            "Global reconstruction replaced topology; original UV/PBR indexing is not authoritative."
        ]

    return output, report
