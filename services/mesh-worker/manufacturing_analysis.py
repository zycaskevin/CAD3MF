from __future__ import annotations

import copy
from dataclasses import dataclass
from importlib import metadata
from typing import Any, Protocol

import numpy as np
import trimesh
from printable_mesh import diagnose_mesh


class AnalysisBackendUnavailable(RuntimeError):
    """Raised when a configured manufacturing-analysis backend is unavailable."""


class SelfIntersectionAnalyzer(Protocol):
    backend_id: str
    algorithm_id: str

    @property
    def version(self) -> str: ...

    def analyze(self, mesh: trimesh.Trimesh) -> dict[str, Any]: ...


class RayMeasurementAnalyzer(Protocol):
    backend_id: str
    algorithm_id: str

    @property
    def version(self) -> str: ...

    def analyze(
        self,
        mesh: trimesh.Trimesh,
        *,
        minimum_thickness_mm: float | None,
        minimum_feature_mm: float | None,
        max_face_samples: int,
    ) -> tuple[dict[str, Any], dict[str, Any]]: ...


@dataclass(frozen=True)
class _FaceBounds:
    minimum: np.ndarray
    maximum: np.ndarray


def _package_version(distribution: str) -> str:
    try:
        return metadata.version(distribution)
    except metadata.PackageNotFoundError:
        return "unavailable"


def _backend_provenance(
    backend: SelfIntersectionAnalyzer | RayMeasurementAnalyzer,
) -> dict[str, str]:
    return {
        "backend_id": str(backend.backend_id),
        "algorithm_id": str(backend.algorithm_id),
        "version": str(backend.version),
    }


def _face_bounds(vertices: np.ndarray, faces: np.ndarray) -> _FaceBounds:
    triangles = vertices[faces]
    return _FaceBounds(minimum=triangles.min(axis=1), maximum=triangles.max(axis=1))


def _candidate_face_pairs(
    vertices: np.ndarray,
    faces: np.ndarray,
    *,
    tolerance_mm: float,
):
    bounds = _face_bounds(vertices, faces)
    order = np.argsort(bounds.minimum[:, 0], kind="mergesort")
    active: list[int] = []

    for current_raw in order:
        current = int(current_raw)
        current_min = bounds.minimum[current]
        current_max = bounds.maximum[current]
        active = [
            other for other in active if bounds.maximum[other, 0] + tolerance_mm >= current_min[0]
        ]
        for other in active:
            if bounds.maximum[other, 1] + tolerance_mm < current_min[1]:
                continue
            if current_max[1] + tolerance_mm < bounds.minimum[other, 1]:
                continue
            if bounds.maximum[other, 2] + tolerance_mm < current_min[2]:
                continue
            if current_max[2] + tolerance_mm < bounds.minimum[other, 2]:
                continue
            yield (other, current)
        active.append(current)


def _cross2(left: np.ndarray, right: np.ndarray) -> float:
    return float(left[0] * right[1] - left[1] * right[0])


def _point_segment_distance(point: np.ndarray, start: np.ndarray, end: np.ndarray) -> float:
    edge = end - start
    length_sq = float(np.dot(edge, edge))
    if length_sq <= 0:
        return float(np.linalg.norm(point - start))
    parameter = float(np.dot(point - start, edge) / length_sq)
    parameter = min(1.0, max(0.0, parameter))
    closest = start + parameter * edge
    return float(np.linalg.norm(point - closest))


def _point_in_triangle_2d(
    point: np.ndarray,
    triangle: np.ndarray,
    tolerance: float,
) -> bool:
    a, b, c = triangle
    c1 = _cross2(b - a, point - a)
    c2 = _cross2(c - b, point - b)
    c3 = _cross2(a - c, point - c)
    has_negative = min(c1, c2, c3) < -tolerance
    has_positive = max(c1, c2, c3) > tolerance
    return not (has_negative and has_positive)


def _unique_points(points: list[np.ndarray], tolerance: float) -> list[np.ndarray]:
    unique: list[np.ndarray] = []
    for point in points:
        if not any(float(np.linalg.norm(point - existing)) <= tolerance for existing in unique):
            unique.append(np.asarray(point, dtype=np.float64))
    return unique


def _segment_intersections_2d(
    a0: np.ndarray,
    a1: np.ndarray,
    b0: np.ndarray,
    b1: np.ndarray,
    tolerance: float,
) -> list[np.ndarray]:
    direction_a = a1 - a0
    direction_b = b1 - b0
    denominator = _cross2(direction_a, direction_b)
    delta = b0 - a0

    if abs(denominator) <= tolerance:
        if abs(_cross2(delta, direction_a)) > tolerance:
            return []
        candidates = [a0, a1, b0, b1]
        return _unique_points(
            [
                point
                for point in candidates
                if _point_segment_distance(point, a0, a1) <= tolerance
                and _point_segment_distance(point, b0, b1) <= tolerance
            ],
            tolerance,
        )

    t = _cross2(delta, direction_b) / denominator
    u = _cross2(delta, direction_a) / denominator
    if -tolerance <= t <= 1.0 + tolerance and -tolerance <= u <= 1.0 + tolerance:
        return [a0 + t * direction_a]
    return []


def _coplanar_intersection_points(
    left: np.ndarray,
    right: np.ndarray,
    normal: np.ndarray,
    tolerance: float,
) -> list[np.ndarray]:
    drop_axis = int(np.argmax(np.abs(normal)))
    left_2d = np.delete(left, drop_axis, axis=1)
    right_2d = np.delete(right, drop_axis, axis=1)
    points: list[np.ndarray] = []

    for point in left_2d:
        if _point_in_triangle_2d(point, right_2d, tolerance):
            points.append(point)
    for point in right_2d:
        if _point_in_triangle_2d(point, left_2d, tolerance):
            points.append(point)

    edges = ((0, 1), (1, 2), (2, 0))
    for a0_index, a1_index in edges:
        for b0_index, b1_index in edges:
            points.extend(
                _segment_intersections_2d(
                    left_2d[a0_index],
                    left_2d[a1_index],
                    right_2d[b0_index],
                    right_2d[b1_index],
                    tolerance,
                )
            )
    return _unique_points(points, tolerance)


def _project_point_for_triangle(
    point: np.ndarray, triangle: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
    drop_axis = int(np.argmax(np.abs(normal)))
    return np.delete(point, drop_axis), np.delete(triangle, drop_axis, axis=1)


def _segment_triangle_plane_point(
    start: np.ndarray,
    end: np.ndarray,
    triangle: np.ndarray,
    tolerance: float,
) -> np.ndarray | None:
    normal = np.cross(triangle[1] - triangle[0], triangle[2] - triangle[0])
    normal_length = float(np.linalg.norm(normal))
    if normal_length <= tolerance:
        return None
    unit_normal = normal / normal_length
    start_distance = float(np.dot(start - triangle[0], unit_normal))
    end_distance = float(np.dot(end - triangle[0], unit_normal))

    if start_distance > tolerance and end_distance > tolerance:
        return None
    if start_distance < -tolerance and end_distance < -tolerance:
        return None

    denominator = start_distance - end_distance
    if abs(denominator) <= tolerance:
        candidates = []
        for point, distance in ((start, start_distance), (end, end_distance)):
            if abs(distance) <= tolerance:
                projected_point, projected_triangle = _project_point_for_triangle(point, triangle)
                if _point_in_triangle_2d(projected_point, projected_triangle, tolerance):
                    candidates.append(point)
        return candidates[0] if candidates else None

    parameter = start_distance / denominator
    if parameter < -tolerance or parameter > 1.0 + tolerance:
        return None
    point = start + parameter * (end - start)
    projected_point, projected_triangle = _project_point_for_triangle(point, triangle)
    if _point_in_triangle_2d(projected_point, projected_triangle, tolerance):
        return point
    return None


def _noncoplanar_intersection_points(
    left: np.ndarray,
    right: np.ndarray,
    tolerance: float,
) -> list[np.ndarray]:
    points: list[np.ndarray] = []
    edges = ((0, 1), (1, 2), (2, 0))
    for start_index, end_index in edges:
        point = _segment_triangle_plane_point(
            left[start_index],
            left[end_index],
            right,
            tolerance,
        )
        if point is not None:
            points.append(point)
        point = _segment_triangle_plane_point(
            right[start_index],
            right[end_index],
            left,
            tolerance,
        )
        if point is not None:
            points.append(point)
    return _unique_points(points, tolerance)


def _adjacent_collision_is_legal(
    left: np.ndarray,
    right: np.ndarray,
    shared_points: np.ndarray,
    tolerance: float,
) -> bool:
    shared_count = len(shared_points)
    if shared_count == 0:
        return False
    if shared_count >= 3:
        return False

    normal_left = np.cross(left[1] - left[0], left[2] - left[0])
    normal_right = np.cross(right[1] - right[0], right[2] - right[0])
    left_length = float(np.linalg.norm(normal_left))
    right_length = float(np.linalg.norm(normal_right))
    if left_length <= tolerance or right_length <= tolerance:
        return False

    unit_left = normal_left / left_length
    unit_right = normal_right / right_length
    planes_parallel = float(np.linalg.norm(np.cross(unit_left, unit_right))) <= 1e-8
    plane_distance = max(abs(float(np.dot(point - left[0], unit_left))) for point in right)
    coplanar = planes_parallel and plane_distance <= tolerance

    if coplanar:
        drop_axis = int(np.argmax(np.abs(unit_left)))
        intersection = _coplanar_intersection_points(left, right, unit_left, tolerance)
        shared = np.delete(shared_points, drop_axis, axis=1)
    else:
        intersection = _noncoplanar_intersection_points(left, right, tolerance)
        shared = shared_points

    if not intersection:
        return False

    legal_tolerance = tolerance * 10.0
    if shared_count == 1:
        return all(
            float(np.linalg.norm(point - shared[0])) <= legal_tolerance for point in intersection
        )

    return all(
        _point_segment_distance(point, shared[0], shared[1]) <= legal_tolerance
        for point in intersection
    )


class FclSelfIntersectionAnalyzer:
    """AABB broad phase plus FCL BVH mesh collision for triangle-pair narrow phase."""

    backend_id = "python-fcl"
    algorithm_id = "sweep-aabb-plus-bvh-collision-with-topology-filter"

    @property
    def version(self) -> str:
        return _package_version("python-fcl")

    def analyze(self, mesh: trimesh.Trimesh) -> dict[str, Any]:
        try:
            import fcl
        except ImportError as exc:
            raise AnalysisBackendUnavailable(
                "python-fcl is not installed in this manufacturing-analysis runtime"
            ) from exc

        vertices = np.asarray(mesh.vertices, dtype=np.float64)
        faces = np.asarray(mesh.faces, dtype=np.int64)
        if len(vertices) == 0 or len(faces) == 0:
            return {
                "status": "pass",
                "has_intersections": False,
                "candidate_pair_count": 0,
                "tested_pair_count": 0,
                "intersecting_pair_count": 0,
                "exhaustive": True,
                "notes": [],
            }

        diagonal = float(np.linalg.norm(vertices.max(axis=0) - vertices.min(axis=0)))
        tolerance = max(diagonal * 1e-9, 1e-8)
        objects: dict[int, Any] = {}

        def collision_object(face_index: int):
            cached = objects.get(face_index)
            if cached is not None:
                return cached
            triangle = np.ascontiguousarray(vertices[faces[face_index]], dtype=np.float64)
            local_faces = np.array([[0, 1, 2]], dtype=np.int32)
            geometry = fcl.BVHModel()
            geometry.beginModel(len(triangle), len(local_faces))
            geometry.addSubModel(triangle, local_faces)
            geometry.endModel()
            obj = fcl.CollisionObject(geometry)
            objects[face_index] = obj
            return obj

        candidate_count = 0
        tested_count = 0
        intersection_count = 0
        request = fcl.CollisionRequest(num_max_contacts=1, enable_contact=False)

        for left_index, right_index in _candidate_face_pairs(
            vertices,
            faces,
            tolerance_mm=tolerance,
        ):
            candidate_count += 1
            result = fcl.CollisionResult()
            contacts = fcl.collide(
                collision_object(left_index),
                collision_object(right_index),
                request,
                result,
            )
            tested_count += 1
            if int(contacts) <= 0 and not bool(result.is_collision):
                continue

            left_face = faces[left_index]
            right_face = faces[right_index]
            shared_indexes = np.intersect1d(left_face, right_face, assume_unique=False)
            if len(shared_indexes) == 0:
                intersection_count += 1
                continue

            if not _adjacent_collision_is_legal(
                vertices[left_face],
                vertices[right_face],
                vertices[shared_indexes],
                tolerance,
            ):
                intersection_count += 1

        has_intersections = intersection_count > 0
        return {
            "status": "fail" if has_intersections else "pass",
            "has_intersections": has_intersections,
            "candidate_pair_count": candidate_count,
            "tested_pair_count": tested_count,
            "intersecting_pair_count": intersection_count,
            "exhaustive": True,
            "notes": [
                "All overlapping AABB face pairs are tested.",
                "Adjacent collisions pass only when confined to the shared vertex or edge.",
            ],
        }


def _face_centers_and_normals(
    vertices: np.ndarray,
    faces: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    triangles = vertices[faces]
    centers = triangles.mean(axis=1)
    cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    lengths = np.linalg.norm(cross, axis=1)
    valid = lengths > 1e-14
    normals = np.zeros_like(cross, dtype=np.float64)
    normals[valid] = cross[valid] / lengths[valid, None]
    return centers, normals, valid


def _sample_face_indexes(total: int, maximum: int) -> np.ndarray:
    if maximum <= 0:
        raise ValueError("max_face_samples must be positive")
    if total <= maximum:
        return np.arange(total, dtype=np.int64)
    return np.unique(np.linspace(0, total - 1, num=maximum, dtype=np.int64))


def _ray_measurement_status(
    *,
    threshold_mm: float | None,
    observed_min_mm: float | None,
    exhaustive: bool,
) -> str:
    if threshold_mm is None:
        return "unknown"
    if observed_min_mm is not None and observed_min_mm < threshold_mm:
        return "fail"
    if exhaustive:
        return "pass"
    return "unknown"


class PcuRayMeasurementAnalyzer:
    """Face-normal wall/gap observations backed by PCU's Embree ray intersector."""

    backend_id = "point-cloud-utils"
    algorithm_id = "embree-face-normal-ray-measurement"

    @property
    def version(self) -> str:
        return _package_version("point-cloud-utils")

    def analyze(
        self,
        mesh: trimesh.Trimesh,
        *,
        minimum_thickness_mm: float | None,
        minimum_feature_mm: float | None,
        max_face_samples: int,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        try:
            import point_cloud_utils as pcu
        except ImportError as exc:
            raise AnalysisBackendUnavailable(
                "point-cloud-utils is not installed in this manufacturing-analysis runtime"
            ) from exc

        vertices = np.ascontiguousarray(np.asarray(mesh.vertices, dtype=np.float64))
        faces = np.ascontiguousarray(np.asarray(mesh.faces, dtype=np.int32))
        total_faces = len(faces)
        indexes = _sample_face_indexes(total_faces, max_face_samples)
        centers, normals, valid_normals = _face_centers_and_normals(vertices, faces)
        selected_valid = valid_normals[indexes]
        valid_indexes = indexes[selected_valid]
        selected_centers = centers[valid_indexes]
        selected_normals = normals[valid_indexes]

        sampled_count = int(len(valid_indexes))
        all_faces_sampled = len(indexes) == total_faces and bool(np.all(selected_valid))
        diagonal = float(np.linalg.norm(vertices.max(axis=0) - vertices.min(axis=0)))
        epsilon = max(diagonal * 1e-9, 1e-6)

        if sampled_count == 0:
            base = {
                "status": "unknown",
                "threshold_mm": None,
                "observed_min_mm": None,
                "sampled_face_count": 0,
                "total_face_count": total_faces,
                "hit_count": 0,
                "exhaustive": False,
                "notes": ["No non-degenerate face normals were available for ray measurement."],
            }
            thickness = dict(base)
            thickness["threshold_mm"] = minimum_thickness_mm
            thickness["method_scope"] = "inward_face_normal_chord"
            feature = dict(base)
            feature["threshold_mm"] = minimum_feature_mm
            feature["method_scope"] = "outward_opposing_surface_clearance"
            return thickness, feature

        intersector = pcu.RayMeshIntersector(vertices, faces)

        inward_origins = np.ascontiguousarray(selected_centers - selected_normals * epsilon)
        inward_directions = np.ascontiguousarray(-selected_normals)
        inward_face, _inward_bc, inward_t = intersector.intersect_rays(
            inward_origins,
            inward_directions,
        )
        inward_face = np.asarray(inward_face, dtype=np.int64)
        inward_t = np.asarray(inward_t, dtype=np.float64)
        inward_valid = (
            (inward_face >= 0)
            & (inward_face != valid_indexes)
            & np.isfinite(inward_t)
            & (inward_t > 0)
        )
        inward_distances = inward_t[inward_valid] + epsilon
        thickness_min = float(inward_distances.min()) if len(inward_distances) > 0 else None
        thickness_exhaustive = all_faces_sampled and bool(np.all(inward_valid))
        thickness = {
            "status": _ray_measurement_status(
                threshold_mm=minimum_thickness_mm,
                observed_min_mm=thickness_min,
                exhaustive=thickness_exhaustive,
            ),
            "threshold_mm": minimum_thickness_mm,
            "observed_min_mm": thickness_min,
            "sampled_face_count": sampled_count,
            "total_face_count": total_faces,
            "hit_count": int(np.count_nonzero(inward_valid)),
            "exhaustive": thickness_exhaustive,
            "method_scope": "inward_face_normal_chord",
            "notes": [
                "Observed local material chord along inward facet normals.",
                "No slicer profile is used.",
            ],
        }

        outward_origins = np.ascontiguousarray(selected_centers + selected_normals * epsilon)
        outward_directions = np.ascontiguousarray(selected_normals)
        outward_face, _outward_bc, outward_t = intersector.intersect_rays(
            outward_origins,
            outward_directions,
        )
        outward_face = np.asarray(outward_face, dtype=np.int64)
        outward_t = np.asarray(outward_t, dtype=np.float64)
        outward_valid = (
            (outward_face >= 0)
            & (outward_face != valid_indexes)
            & np.isfinite(outward_t)
            & (outward_t > 0)
        )
        opposing = np.zeros(sampled_count, dtype=bool)
        valid_out_positions = np.flatnonzero(outward_valid)
        if len(valid_out_positions) > 0:
            hit_normals = normals[outward_face[valid_out_positions]]
            source_normals = selected_normals[valid_out_positions]
            opposing[valid_out_positions] = (
                np.einsum("ij,ij->i", source_normals, hit_normals) < -0.25
            )
        gap_valid = outward_valid & opposing
        gap_distances = outward_t[gap_valid] + epsilon
        feature_min = float(gap_distances.min()) if len(gap_distances) > 0 else None
        feature_exhaustive = all_faces_sampled
        feature = {
            "status": _ray_measurement_status(
                threshold_mm=minimum_feature_mm,
                observed_min_mm=feature_min,
                exhaustive=feature_exhaustive,
            ),
            "threshold_mm": minimum_feature_mm,
            "observed_min_mm": feature_min,
            "sampled_face_count": sampled_count,
            "total_face_count": total_faces,
            "hit_count": int(np.count_nonzero(gap_valid)),
            "exhaustive": feature_exhaustive,
            "method_scope": "outward_opposing_surface_clearance",
            "notes": [
                "Negative-feature clearance uses the first opposing outward-normal hit.",
                "Positive thin members are governed by the minimum-thickness check.",
            ],
        }
        return thickness, feature


def _unknown_self_intersection(note: str, status: str = "unknown") -> dict[str, Any]:
    return {
        "status": status,
        "has_intersections": None,
        "candidate_pair_count": 0,
        "tested_pair_count": 0,
        "intersecting_pair_count": None,
        "exhaustive": False,
        "notes": [note],
    }


def _unknown_ray_measurement(
    *,
    threshold_mm: float | None,
    total_faces: int,
    method_scope: str,
    note: str,
    status: str = "unknown",
) -> dict[str, Any]:
    return {
        "status": status,
        "threshold_mm": threshold_mm,
        "observed_min_mm": None,
        "sampled_face_count": 0,
        "total_face_count": total_faces,
        "hit_count": 0,
        "exhaustive": False,
        "method_scope": method_scope,
        "notes": [note],
    }


def _overall_status(
    required_checks: set[str],
    self_intersections: dict[str, Any],
    thickness: dict[str, Any],
    feature: dict[str, Any],
) -> str:
    statuses: list[str] = []
    if "self_intersections" in required_checks:
        statuses.append(str(self_intersections["status"]))
    if "minimum_thickness" in required_checks:
        statuses.append(str(thickness["status"]))
    if "minimum_feature" in required_checks:
        statuses.append(str(feature["status"]))

    if not statuses:
        return "pass"
    if "error" in statuses:
        return "error"
    if "fail" in statuses:
        return "fail"
    if "backend_unavailable" in statuses:
        return "backend_unavailable"
    if "unknown" in statuses:
        return "unknown"
    return "pass"


def analyze_manufacturing_geometry(
    mesh: trimesh.Trimesh,
    *,
    required_checks: set[str],
    minimum_thickness_mm: float | None,
    minimum_feature_mm: float | None,
    self_intersection_backend: SelfIntersectionAnalyzer,
    ray_backend: RayMeasurementAnalyzer,
    max_face_samples: int = 100_000,
    analysis_id: str,
    project_id: str,
    source_mesh_artifact_id: str,
    source_sha256: str,
    created_at: str,
) -> dict[str, Any]:
    metrics = diagnose_mesh(mesh)
    prerequisites = {
        "watertight": bool(metrics["watertight"]),
        "manifold_edges": metrics["nonmanifold_edge_count"] == 0,
        "winding_consistent": bool(metrics["winding_consistent"]),
    }
    total_faces = int(metrics["triangle_count"])

    self_result = _unknown_self_intersection("Self-intersection analysis was not requested.")
    if "self_intersections" in required_checks:
        try:
            self_result = self_intersection_backend.analyze(mesh)
        except AnalysisBackendUnavailable as exc:
            self_result = _unknown_self_intersection(str(exc), "backend_unavailable")
        except Exception as exc:
            self_result = _unknown_self_intersection(
                f"{type(exc).__name__}: {exc}",
                "error",
            )

    thickness = _unknown_ray_measurement(
        threshold_mm=minimum_thickness_mm,
        total_faces=total_faces,
        method_scope="inward_face_normal_chord",
        note="Minimum-thickness analysis was not requested.",
    )
    feature = _unknown_ray_measurement(
        threshold_mm=minimum_feature_mm,
        total_faces=total_faces,
        method_scope="outward_opposing_surface_clearance",
        note="Minimum-feature analysis was not requested.",
    )

    ray_required = bool({"minimum_thickness", "minimum_feature"} & required_checks)
    topology_ready = all(prerequisites.values())
    if ray_required and not topology_ready:
        note = "Thickness/feature analysis requires valid closed-manifold topology."
        if "minimum_thickness" in required_checks:
            thickness = _unknown_ray_measurement(
                threshold_mm=minimum_thickness_mm,
                total_faces=total_faces,
                method_scope="inward_face_normal_chord",
                note=note,
            )
        if "minimum_feature" in required_checks:
            feature = _unknown_ray_measurement(
                threshold_mm=minimum_feature_mm,
                total_faces=total_faces,
                method_scope="outward_opposing_surface_clearance",
                note=note,
            )
    elif ray_required:
        try:
            measured_thickness, measured_feature = ray_backend.analyze(
                mesh,
                minimum_thickness_mm=minimum_thickness_mm,
                minimum_feature_mm=minimum_feature_mm,
                max_face_samples=max_face_samples,
            )
            if "minimum_thickness" in required_checks:
                thickness = measured_thickness
            if "minimum_feature" in required_checks:
                feature = measured_feature
        except AnalysisBackendUnavailable as exc:
            if "minimum_thickness" in required_checks:
                thickness = _unknown_ray_measurement(
                    threshold_mm=minimum_thickness_mm,
                    total_faces=total_faces,
                    method_scope="inward_face_normal_chord",
                    note=str(exc),
                    status="backend_unavailable",
                )
            if "minimum_feature" in required_checks:
                feature = _unknown_ray_measurement(
                    threshold_mm=minimum_feature_mm,
                    total_faces=total_faces,
                    method_scope="outward_opposing_surface_clearance",
                    note=str(exc),
                    status="backend_unavailable",
                )
        except Exception as exc:
            note = f"{type(exc).__name__}: {exc}"
            if "minimum_thickness" in required_checks:
                thickness = _unknown_ray_measurement(
                    threshold_mm=minimum_thickness_mm,
                    total_faces=total_faces,
                    method_scope="inward_face_normal_chord",
                    note=note,
                    status="error",
                )
            if "minimum_feature" in required_checks:
                feature = _unknown_ray_measurement(
                    threshold_mm=minimum_feature_mm,
                    total_faces=total_faces,
                    method_scope="outward_opposing_surface_clearance",
                    note=note,
                    status="error",
                )

    return {
        "schema_version": "0.1.0",
        "analysis_id": analysis_id,
        "project_id": project_id,
        "source_mesh_artifact_id": source_mesh_artifact_id,
        "source_sha256": source_sha256,
        "backends": {
            "self_intersection": _backend_provenance(self_intersection_backend),
            "ray_measurement": _backend_provenance(ray_backend),
        },
        "prerequisites": prerequisites,
        "self_intersections": self_result,
        "minimum_thickness": thickness,
        "minimum_feature": feature,
        "overall_status": _overall_status(
            required_checks,
            self_result,
            thickness,
            feature,
        ),
        "notes": ["M1-004-003 is geometry-only; printer/slicer policy is outside this report."],
        "created_at": created_at,
    }


def apply_analysis_to_printable_checks(
    checks: dict[str, dict[str, Any]],
    analysis: dict[str, Any],
    *,
    required_checks: set[str],
) -> dict[str, dict[str, Any]]:
    merged = copy.deepcopy(checks)

    self_result = analysis["self_intersections"]
    merged["self_intersections"] = {
        "status": self_result["status"],
        "required": "self_intersections" in required_checks,
        "value": self_result["has_intersections"],
        "unit": "boolean",
        "notes": list(self_result["notes"]),
    }

    thickness = analysis["minimum_thickness"]
    merged["minimum_thickness"] = {
        "status": thickness["status"],
        "required": "minimum_thickness" in required_checks,
        "value": thickness["observed_min_mm"],
        "unit": "mm",
        "notes": list(thickness["notes"]),
    }

    feature = analysis["minimum_feature"]
    merged["minimum_feature"] = {
        "status": feature["status"],
        "required": "minimum_feature" in required_checks,
        "value": feature["observed_min_mm"],
        "unit": "mm",
        "notes": list(feature["notes"]),
    }
    return merged
