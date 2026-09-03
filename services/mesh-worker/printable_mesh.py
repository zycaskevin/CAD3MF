from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

import numpy as np
import trimesh

TOPOLOGY_CHECKS = (
    "watertight",
    "closed_boundary",
    "manifold_edges",
    "winding_consistent",
)
ALL_CHECKS = TOPOLOGY_CHECKS + (
    "self_intersections",
    "minimum_thickness",
    "minimum_feature",
)


def _vec3(values: np.ndarray) -> dict[str, float]:
    return {
        "x": float(values[0]),
        "y": float(values[1]),
        "z": float(values[2]),
    }


def _bounding_box(mesh: trimesh.Trimesh) -> dict[str, dict[str, float]]:
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if len(mesh.vertices) == 0 or len(faces) == 0:
        zero = np.zeros(3, dtype=np.float64)
        return {"min": _vec3(zero), "max": _vec3(zero), "extents": _vec3(zero)}
    referenced = np.unique(faces.reshape(-1))
    vertices = np.asarray(mesh.vertices, dtype=np.float64)[referenced]
    lower = vertices.min(axis=0)
    upper = vertices.max(axis=0)
    extents = upper - lower
    return {
        "min": _vec3(lower),
        "max": _vec3(upper),
        "extents": _vec3(extents),
    }


def _edge_incidence(faces: np.ndarray) -> tuple[int, int]:
    if len(faces) == 0:
        return 0, 0
    edges = np.vstack((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]))
    edges = np.sort(edges, axis=1)
    _unique, counts = np.unique(edges, axis=0, return_counts=True)
    boundary = int(np.count_nonzero(counts == 1))
    nonmanifold = int(np.count_nonzero(counts > 2))
    return boundary, nonmanifold


def _face_component_count(faces: np.ndarray) -> int:
    face_count = len(faces)
    if face_count == 0:
        return 0

    parent = np.arange(face_count, dtype=np.int64)
    rank = np.zeros(face_count, dtype=np.int8)

    def find(index: int) -> int:
        root = index
        while parent[root] != root:
            root = int(parent[root])
        while parent[index] != index:
            next_index = int(parent[index])
            parent[index] = root
            index = next_index
        return root

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root == right_root:
            return
        if rank[left_root] < rank[right_root]:
            parent[left_root] = right_root
        elif rank[left_root] > rank[right_root]:
            parent[right_root] = left_root
        else:
            parent[right_root] = left_root
            rank[left_root] += 1

    edge_owner: dict[tuple[int, int], int] = {}
    for face_index, face in enumerate(faces):
        a, b, c = (int(face[0]), int(face[1]), int(face[2]))
        for start, end in ((a, b), (b, c), (c, a)):
            edge = (start, end) if start < end else (end, start)
            owner = edge_owner.get(edge)
            if owner is None:
                edge_owner[edge] = face_index
            else:
                union(face_index, owner)

    return len({find(index) for index in range(face_count)})


def _duplicate_face_count(faces: np.ndarray) -> int:
    if len(faces) == 0:
        return 0
    canonical = np.sort(faces, axis=1)
    return int(len(canonical) - len(np.unique(canonical, axis=0)))


def _degenerate_face_count(mesh: trimesh.Trimesh, tolerance: float = 1e-12) -> int:
    if len(mesh.faces) == 0:
        return 0
    triangles = np.asarray(mesh.vertices)[np.asarray(mesh.faces)]
    cross = np.cross(
        triangles[:, 1] - triangles[:, 0],
        triangles[:, 2] - triangles[:, 0],
    )
    double_area = np.linalg.norm(cross, axis=1)
    return int(np.count_nonzero(double_area <= tolerance))


def _unreferenced_vertex_count(mesh: trimesh.Trimesh) -> int:
    if len(mesh.vertices) == 0:
        return 0
    if len(mesh.faces) == 0:
        return int(len(mesh.vertices))
    referenced = np.unique(np.asarray(mesh.faces).reshape(-1))
    return int(len(mesh.vertices) - len(referenced))


def diagnose_mesh(mesh: trimesh.Trimesh) -> dict[str, Any]:
    faces = np.asarray(mesh.faces, dtype=np.int64)
    boundary_edges, nonmanifold_edges = _edge_incidence(faces)
    return {
        "vertex_count": int(len(mesh.vertices)),
        "triangle_count": int(len(mesh.faces)),
        "component_count": _face_component_count(faces),
        "boundary_edge_count": boundary_edges,
        "nonmanifold_edge_count": nonmanifold_edges,
        "duplicate_face_count": _duplicate_face_count(faces),
        "degenerate_face_count": _degenerate_face_count(mesh),
        "unreferenced_vertex_count": _unreferenced_vertex_count(mesh),
        "watertight": bool(mesh.is_watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
        "bounding_box_mm": _bounding_box(mesh),
    }


def _check(
    status: str,
    required: bool,
    value: bool | int | float | None,
    unit: str,
) -> dict[str, Any]:
    return {
        "status": status,
        "required": required,
        "value": value,
        "unit": unit,
        "notes": [],
    }


def build_checks(
    metrics: dict[str, Any], required_checks: Iterable[str]
) -> dict[str, dict[str, Any]]:
    required = set(required_checks)
    invalid = required.difference(ALL_CHECKS)
    if invalid:
        raise ValueError(f"unsupported printable-mesh checks: {sorted(invalid)}")

    checks = {
        "watertight": _check(
            "pass" if metrics["watertight"] else "fail",
            "watertight" in required,
            metrics["watertight"],
            "boolean",
        ),
        "closed_boundary": _check(
            "pass" if metrics["boundary_edge_count"] == 0 else "fail",
            "closed_boundary" in required,
            metrics["boundary_edge_count"],
            "count",
        ),
        "manifold_edges": _check(
            "pass" if metrics["nonmanifold_edge_count"] == 0 else "fail",
            "manifold_edges" in required,
            metrics["nonmanifold_edge_count"],
            "count",
        ),
        "winding_consistent": _check(
            "pass" if metrics["winding_consistent"] else "fail",
            "winding_consistent" in required,
            metrics["winding_consistent"],
            "boolean",
        ),
    }
    for name in ("self_intersections", "minimum_thickness", "minimum_feature"):
        unit = "mm" if name != "self_intersections" else "boolean"
        checks[name] = _check("not_run", name in required, None, unit)
    return checks


def _operation(
    operation: str,
    status: str,
    changed_count: int | None,
    changes_topology: bool,
    note: str | None = None,
) -> dict[str, Any]:
    return {
        "operation": operation,
        "status": status,
        "changed_count": changed_count,
        "changes_topology": changes_topology,
        "note": note,
    }


def _remove_duplicate_faces(mesh: trimesh.Trimesh) -> int:
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if len(faces) == 0:
        return 0
    canonical = np.sort(faces, axis=1)
    _unique, indices = np.unique(canonical, axis=0, return_index=True)
    if len(indices) == len(faces):
        return 0
    keep = np.zeros(len(faces), dtype=bool)
    keep[np.sort(indices)] = True
    removed = int(len(faces) - np.count_nonzero(keep))
    mesh.update_faces(keep)
    return removed


def _remove_degenerate_faces(mesh: trimesh.Trimesh) -> int:
    if len(mesh.faces) == 0:
        return 0
    keep = mesh.nondegenerate_faces(height=1e-9)
    removed = int(len(mesh.faces) - np.count_nonzero(keep))
    if removed:
        mesh.update_faces(keep)
    return removed


def _extents(metrics: dict[str, Any]) -> np.ndarray:
    extents = metrics["bounding_box_mm"]["extents"]
    values = [extents["x"], extents["y"], extents["z"]]
    return np.asarray(values, dtype=np.float64)


def repair_topology(
    mesh: trimesh.Trimesh,
    *,
    required_checks: Iterable[str] = TOPOLOGY_CHECKS,
    repair_policy: dict[str, bool] | None = None,
    metric_scale_tolerance_mm: float = 0.001,
    report_id: str = "printable-mesh-report",
    project_id: str = "unknown-project",
    source_mesh_artifact_id: str = "unknown-mesh",
    source_sha256: str = "0" * 64,
    created_at: str | None = None,
) -> tuple[trimesh.Trimesh, dict[str, Any]]:
    if metric_scale_tolerance_mm < 0:
        raise ValueError("metric_scale_tolerance_mm must be non-negative")

    policy = {
        "preserve_metric_scale": True,
        "merge_vertices": True,
        "remove_duplicate_faces": True,
        "remove_degenerate_faces": True,
        "remove_unreferenced_vertices": True,
        "fix_normals": True,
        "fill_small_holes": True,
    }
    if repair_policy is not None:
        policy.update(repair_policy)
    if policy.get("preserve_metric_scale") is not True:
        raise ValueError("Printable Mesh repair requires preserve_metric_scale=true")

    required = tuple(required_checks)
    work = mesh.copy()
    input_metrics = diagnose_mesh(work)
    operations: list[dict[str, Any]] = []

    if policy["remove_duplicate_faces"]:
        changed = _remove_duplicate_faces(work)
        operations.append(
            _operation(
                "remove_duplicate_faces",
                "applied" if changed else "no_change",
                changed,
                True,
            )
        )
    else:
        operations.append(_operation("remove_duplicate_faces", "skipped", 0, True))

    if policy["remove_degenerate_faces"]:
        changed = _remove_degenerate_faces(work)
        operations.append(
            _operation(
                "remove_degenerate_faces",
                "applied" if changed else "no_change",
                changed,
                True,
            )
        )
    else:
        operations.append(_operation("remove_degenerate_faces", "skipped", 0, True))

    if policy["remove_unreferenced_vertices"]:
        before = len(work.vertices)
        work.remove_unreferenced_vertices()
        changed = int(before - len(work.vertices))
        operations.append(
            _operation(
                "remove_unreferenced_vertices",
                "applied" if changed else "no_change",
                changed,
                True,
            )
        )
    else:
        operations.append(_operation("remove_unreferenced_vertices", "skipped", 0, True))

    if policy["merge_vertices"]:
        before = len(work.vertices)
        work.merge_vertices()
        changed = int(before - len(work.vertices))
        operations.append(
            _operation(
                "merge_vertices",
                "applied" if changed else "no_change",
                changed,
                True,
            )
        )
    else:
        operations.append(_operation("merge_vertices", "skipped", 0, True))

    if policy["fix_normals"]:
        before = bool(work.is_winding_consistent)
        trimesh.repair.fix_normals(work, multibody=True)
        after = bool(work.is_winding_consistent)
        changed = int(before != after)
        status = "applied" if changed else "no_change"
        operations.append(_operation("fix_normals", status, changed, False))
    else:
        operations.append(_operation("fix_normals", "skipped", 0, False))

    if policy["fill_small_holes"]:
        before_faces = len(work.faces)
        before_boundary = diagnose_mesh(work)["boundary_edge_count"]
        try:
            result = bool(trimesh.repair.fill_holes(work))
            added = int(max(0, len(work.faces) - before_faces))
            after_boundary = diagnose_mesh(work)["boundary_edge_count"]
            changed = added > 0 or after_boundary < before_boundary
            note = None if result or changed else "No fillable triangle/quad holes found"
            operations.append(
                _operation(
                    "fill_small_holes",
                    "applied" if changed else "no_change",
                    added,
                    True,
                    note,
                )
            )
        except Exception as exc:
            note = f"{type(exc).__name__}: {exc}"
            operations.append(_operation("fill_small_holes", "failed", None, True, note))
    else:
        operations.append(_operation("fill_small_holes", "skipped", 0, True))

    output_metrics = diagnose_mesh(work)
    output_checks = build_checks(output_metrics, required)
    input_extents = _extents(input_metrics)
    output_extents = _extents(output_metrics)
    max_drift = float(np.max(np.abs(output_extents - input_extents)))
    metric_preserved = max_drift <= metric_scale_tolerance_mm

    topology_valid = all(output_checks[name]["status"] == "pass" for name in TOPOLOGY_CHECKS)
    topology_changed = any(
        op["changes_topology"] and op["status"] == "applied" for op in operations
    )
    unresolved_required = [
        name
        for name, check in output_checks.items()
        if check["required"] and check["status"] != "pass"
    ]

    if not metric_preserved:
        status = "rejected"
    elif not topology_valid:
        status = "needs_robust_repair"
    elif unresolved_required:
        status = "needs_additional_validation"
    elif topology_changed:
        status = "repaired_topology_valid"
    else:
        status = "valid_no_repair"

    notes = []
    if unresolved_required:
        notes.append(f"Required checks not PASS: {', '.join(unresolved_required)}")
    if topology_changed:
        notes.append("Topology changed; PBR/UV material rebaking may be required.")

    timestamp = created_at or datetime.now(UTC).isoformat().replace("+00:00", "Z")
    report = {
        "schema_version": "0.1.0",
        "report_id": report_id,
        "project_id": project_id,
        "source_mesh_artifact_id": source_mesh_artifact_id,
        "source_sha256": source_sha256,
        "output_sha256": None,
        "input_metrics": input_metrics,
        "output_metrics": output_metrics,
        "checks": output_checks,
        "repair_operations": operations,
        "metric_invariant": {
            "preserved": metric_preserved,
            "tolerance_mm": float(metric_scale_tolerance_mm),
            "max_extent_drift_mm": max_drift,
            "non_uniform_scale_applied": False,
        },
        "appearance_rebake_required": topology_changed,
        "status": status,
        "notes": notes,
        "created_at": timestamp,
    }
    return work, report
