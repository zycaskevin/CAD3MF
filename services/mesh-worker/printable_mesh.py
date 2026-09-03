from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable

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
    if len(mesh.vertices) == 0:
        zero = np.zeros(3, dtype=np.float64)
        return {"min": _vec3(zero), "max": _vec3(zero), "extents": _vec3(zero)}
    bounds = np.asarray(mesh.bounds, dtype=np.float64)
    extents = bounds[1] - bounds[0]
    return {
        "min": _vec3(bounds[0]),
        "max": _vec3(bounds[1]),
        "extents": _vec3(extents),
    }


def _edge_incidence(faces: np.ndarray) -> tuple[int, int]:
    if len(faces) == 0:
        return 0, 0
    edges = np.vstack((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]))
    edges = np.sort(edges, axis=1)
    _unique, counts = np.unique(edges, axis=0, return_counts=True)
    return int(np.count_nonzero(counts == 1)), int(np.count_nonzero(counts > 2))


def _duplicate_face_count(faces: np.ndarray) -> int:
    if len(faces) == 0:
        return 0
    canonical = np.sort(faces, axis=1)
    return int(len(canonical) - len(np.unique(canonical, axis=0)))


def _degenerate_face_count(mesh: trimesh.Trimesh, tolerance: float = 1e-12) -> int:
    if len(mesh.faces) == 0:
        return 0
    triangles = np.asarray(mesh.vertices)[np.asarray(mesh.faces)]
    cross = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
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
    component_count = 0
    if len(faces) > 0:
        component_count = len(mesh.split(only_watertight=False))
    return {
        "vertex_count": int(len(mesh.vertices)),
        "triangle_count": int(len(mesh.faces)),
        "component_count": int(component_count),
        "boundary_edge_count": boundary_edges,
        "nonmanifold_edge_count": nonmanifold_edges,
        "duplicate_face_count": _duplicate_face_count(faces),
        "degenerate_face_count": _degenerate_face_count(mesh),
        "unreferenced_vertex_count": _unreferenced_vertex_count(mesh),
        "watertight": bool(mesh.is_watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
        "bounding_box_mm": _bounding_box(mesh),
    }


def _check(status: str, required: bool, value: bool | int | float | None) -> dict[str, Any]:
    return {
        "status": status,
        "required": required,
        "value": value,
        "unit": "boolean" if isinstance(value, bool) else "count" if isinstance(value, int) else "none",
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
        ),
        "closed_boundary": _check(
            "pass" if metrics["boundary_edge_count"] == 0 else "fail",
            "closed_boundary" in required,
            metrics["boundary_edge_count"],
        ),
        "manifold_edges": _check(
            "pass" if metrics["nonmanifold_edge_count"] == 0 else "fail",
            "manifold_edges" in required,
            metrics["nonmanifold_edge_count"],
        ),
        "winding_consistent": _check(
            "pass" if metrics["winding_consistent"] else "fail",
            "winding_consistent" in required,
            metrics["winding_consistent"],
        ),
    }
    for name in ("self_intersections", "minimum_thickness", "minimum_feature"):
        checks[name] = _check("not_run", name in required, None)
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
    return np.asarray([extents["x"], extents["y"], extents["z"]], dtype=np.float64)


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
    input_checks = build_checks(input_metrics, required)
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
        operations.append(
            _operation("fix_normals", "applied" if changed else "no_change", changed, False)
        )
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
            operations.append(
                _operation("fill_small_holes", "failed", None, True, f"{type(exc).__name__}: {exc}")
            )
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
    if not metric_preserved:
        status = "rejected"
    elif topology_valid and topology_changed:
        status = "repaired_topology_valid"
    elif topology_valid:
        status = "valid_no_repair"
    else:
        status = "needs_robust_repair"

    unresolved_required = [
        name
        for name, check in output_checks.items()
        if check["required"] and check["status"] != "pass"
    ]
    notes = []
    if unresolved_required:
        notes.append(f"Required checks not PASS: {', '.join(unresolved_required)}")
    if topology_changed:
        notes.append("Topology changed; PBR/UV material rebaking may be required.")

    timestamp = created_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
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
