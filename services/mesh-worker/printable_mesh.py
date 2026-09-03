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

EdgeRecord = tuple[int, int, int]


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


def _edge_records(faces: np.ndarray) -> dict[tuple[int, int], list[EdgeRecord]]:
    records: dict[tuple[int, int], list[EdgeRecord]] = {}
    for face_index, face in enumerate(faces):
        a, b, c = (int(face[0]), int(face[1]), int(face[2]))
        for start, end in ((a, b), (b, c), (c, a)):
            key = (start, end) if start < end else (end, start)
            records.setdefault(key, []).append((face_index, start, end))
    return records


def _edge_incidence(faces: np.ndarray) -> tuple[int, int]:
    records = _edge_records(faces)
    boundary = sum(1 for owners in records.values() if len(owners) == 1)
    nonmanifold = sum(1 for owners in records.values() if len(owners) > 2)
    return boundary, nonmanifold


def _face_components(faces: np.ndarray) -> list[np.ndarray]:
    face_count = len(faces)
    if face_count == 0:
        return []

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

    for owners in _edge_records(faces).values():
        if len(owners) < 2:
            continue
        first = owners[0][0]
        for owner in owners[1:]:
            union(first, owner[0])

    grouped: dict[int, list[int]] = {}
    for index in range(face_count):
        grouped.setdefault(find(index), []).append(index)
    return [np.asarray(indices, dtype=np.int64) for indices in grouped.values()]


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
        "component_count": len(_face_components(faces)),
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


def _boundary_cycles(faces: np.ndarray) -> tuple[list[list[int]], int]:
    boundary_records = [
        owners[0]
        for owners in _edge_records(faces).values()
        if len(owners) == 1
    ]
    if not boundary_records:
        return [], 0

    adjacency: dict[int, set[int]] = {}
    for _face_index, start, end in boundary_records:
        adjacency.setdefault(start, set()).add(end)
        adjacency.setdefault(end, set()).add(start)

    unseen = set(adjacency)
    cycles: list[list[int]] = []
    unsafe_components = 0
    while unseen:
        seed = min(unseen)
        stack = [seed]
        component: set[int] = set()
        while stack:
            vertex = stack.pop()
            if vertex in component:
                continue
            component.add(vertex)
            unseen.discard(vertex)
            stack.extend(adjacency[vertex].difference(component))

        if any(len(adjacency[vertex]) != 2 for vertex in component):
            unsafe_components += 1
            continue

        start = min(component)
        cycle = [start]
        previous: int | None = None
        current = start
        while True:
            choices = sorted(adjacency[current])
            next_vertex = choices[0] if choices[0] != previous else choices[1]
            if next_vertex == start:
                break
            if next_vertex in cycle:
                cycle = []
                break
            cycle.append(next_vertex)
            previous, current = current, next_vertex

        if cycle and set(cycle) == component:
            cycles.append(cycle)
        else:
            unsafe_components += 1

    return cycles, unsafe_components


def _fill_small_holes(mesh: trimesh.Trimesh) -> tuple[int, int, int]:
    faces = np.asarray(mesh.faces, dtype=np.int64)
    cycles, unsafe = _boundary_cycles(faces)
    new_faces: list[list[int]] = []
    skipped_large = 0
    for cycle in cycles:
        if len(cycle) == 3:
            new_faces.append([cycle[0], cycle[1], cycle[2]])
        elif len(cycle) == 4:
            new_faces.append([cycle[0], cycle[1], cycle[2]])
            new_faces.append([cycle[0], cycle[2], cycle[3]])
        else:
            skipped_large += 1

    if new_faces:
        mesh.faces = np.vstack((faces, np.asarray(new_faces, dtype=np.int64)))
    return len(new_faces), skipped_large, unsafe


def _repair_winding(mesh: trimesh.Trimesh) -> tuple[int, int]:
    faces = np.asarray(mesh.faces, dtype=np.int64).copy()
    if len(faces) == 0:
        return 0, 0

    adjacency: list[list[tuple[int, bool]]] = [[] for _ in range(len(faces))]
    for owners in _edge_records(faces).values():
        if len(owners) != 2:
            continue
        left, right = owners
        same_direction = left[1] == right[1] and left[2] == right[2]
        adjacency[left[0]].append((right[0], same_direction))
        adjacency[right[0]].append((left[0], same_direction))

    flip_state = np.full(len(faces), -1, dtype=np.int8)
    conflicts = 0
    for seed in range(len(faces)):
        if flip_state[seed] != -1:
            continue
        flip_state[seed] = 0
        stack = [seed]
        while stack:
            face_index = stack.pop()
            for neighbor, must_differ in adjacency[face_index]:
                expected = int(flip_state[face_index]) ^ int(must_differ)
                if flip_state[neighbor] == -1:
                    flip_state[neighbor] = expected
                    stack.append(neighbor)
                elif int(flip_state[neighbor]) != expected:
                    conflicts += 1

    flip_mask = flip_state == 1
    flipped = int(np.count_nonzero(flip_mask))
    if flipped:
        faces[flip_mask] = faces[flip_mask][:, ::-1]

    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    for component in _face_components(faces):
        component_faces = faces[component]
        boundary, nonmanifold = _edge_incidence(component_faces)
        if boundary != 0 or nonmanifold != 0:
            continue
        triangles = vertices[component_faces]
        signed_volume = float(
            np.einsum(
                "ij,ij->i",
                triangles[:, 0],
                np.cross(triangles[:, 1], triangles[:, 2]),
            ).sum()
            / 6.0
        )
        if signed_volume < 0:
            faces[component] = faces[component][:, ::-1]
            flipped += int(len(component))

    mesh.faces = faces
    return flipped, conflicts


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

    if policy["fill_small_holes"]:
        added, skipped_large, unsafe = _fill_small_holes(work)
        note_parts = []
        if skipped_large:
            note_parts.append(f"{skipped_large} boundary loop(s) exceed 4 vertices")
        if unsafe:
            note_parts.append(f"{unsafe} ambiguous boundary component(s) skipped")
        note = "; ".join(note_parts) or None
        operations.append(
            _operation(
                "fill_small_holes",
                "applied" if added else "no_change",
                added,
                True,
                note,
            )
        )
    else:
        operations.append(_operation("fill_small_holes", "skipped", 0, True))

    if policy["fix_normals"]:
        flipped, conflicts = _repair_winding(work)
        note = f"{conflicts} winding constraint conflict(s)" if conflicts else None
        status = "failed" if conflicts else "applied" if flipped else "no_change"
        operations.append(_operation("fix_normals", status, flipped, False, note))
    else:
        operations.append(_operation("fix_normals", "skipped", 0, False))

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
