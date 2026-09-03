# M1-004-002 — Robust Topology Repair Backend

Status: In Development  
Milestone: CAD3MF M1  
Date: 2026-09-03  
Base: M1-004-001 COMPLETE / safe deterministic topology repair

## Goal

Add a replaceable **global reconstruction backend** for meshes that M1-004-001 correctly returns as `needs_robust_repair`.

This work package handles geometry that cannot be safely repaired with local deterministic edits, including:

- boundary loops larger than the safe triangle/quad limit;
- ambiguous or broken boundary graphs;
- remaining open shells;
- non-manifold topology;
- overlapping / self-intersecting triangle soup where local edits cannot recover a solid.

M1-004-002 does **not** weaken the conservative boundary from M1-004-001. The safe repair engine remains the first pass. Robust reconstruction is an explicit second-stage operation.

## Canonical pipeline

```text
Generated Mesh / Asset-IR
        |
        v
M1-004-001 Safe Repair
        |
        +-- valid / locally repaired --------------------+
        |                                                |
        +-- needs_robust_repair                          |
                 |                                       |
                 v                                       |
        Robust Repair Request                            |
                 |                                       |
                 v                                       |
        RobustRepairBackend                              |
                 |                                       |
                 v                                       |
        Global Watertight Reconstruction                 |
                 |                                       |
                 v                                       |
        Topology Re-validation                           |
                 |                                       |
                 v                                       |
        Shape Fidelity Gate                              |
                 |                                       |
                 v                                       |
        Robust Repair Report                             |
                 |                                       |
                 +---------------------------+-----------+
                                             |
                                             v
                                   M1-004-003 validation
```

## Backend boundary

Canonical interface:

```text
RobustRepairBackend
  backend_id
  algorithm_id
  version
  reconstruct(vertices_mm, faces, quality_tier)
       -> vertices_mm, faces, backend_metadata
```

Rules:

1. The backend receives millimeter geometry and must return the same coordinate system.
2. No backend-specific fields enter Asset-IR or Manufacturing-IR.
3. Unknown or unavailable backends fail closed.
4. There is no fallback to the M1-003 deterministic cube or to a silent alternate backend.
5. Global reconstruction always invalidates authoritative UV/PBR correspondence; material rebaking is required.

## First production candidate

### point-cloud-utils / Watertight Manifold reconstruction

First adapter: `point-cloud-utils` `make_mesh_watertight()`.

Selection rationale:

- current project license is MIT;
- explicitly exposes watertight reconstruction from arbitrary triangle meshes;
- algorithm is intended for triangle-soup / broken-mesh reconstruction;
- current releases removed prior GPL dependencies;
- Python API is NumPy-array based and can remain isolated behind the worker boundary.

Deployment caveat:

- PyPI currently publishes Linux x86_64 wheels and macOS ARM64 wheels, but not a Linux ARM64 wheel for the current release;
- therefore NVIDIA GB10/aarch64 deployment must use a **separate robust-repair runtime/source build**, not the existing SF3D venv;
- GB10 source-build validation is deferred to the real Figurine + Tank repair validation path rather than being assumed.

Rejected as default backends at this stage:

- PyMeshFix / MeshFix: GPL and/or separate commercial licensing requirement;
- MeshLab / PyMeshLab: GPL distribution boundary;
- MeshLib: current public license is non-commercial/education;
- Manifold3D: permissive Apache-2.0 and excellent manifold kernel, but arbitrary broken input is not its primary repair contract; it may be useful later as an output certification/geometry kernel, not the first robust reconstruction provider.

## Quality tiers

Canonical quality tiers map to backend reconstruction budgets inside the adapter:

| Tier | point-cloud-utils resolution budget |
| --- | ---: |
| `preview` | 5,000 |
| `standard` | 20,000 |
| `high` | 50,000 |
| `ultra` | 100,000 |

The numeric mapping is adapter policy, not canonical geometry truth.

## Topology gate

A successful robust reconstruction must re-enter the M1-004-001 diagnostics and satisfy all four currently authoritative topology checks:

- `watertight = true`
- `boundary_edge_count = 0`
- `nonmanifold_edge_count = 0`
- `winding_consistent = true`

A backend returning bytes/arrays is not enough. Geometry must pass CAD3MF diagnostics.

## Shape-fidelity gate

Global reconstruction can make a mesh watertight while destroying product identity or dimensions. Therefore M1-004-002 adds an explicit fidelity gate.

Required observations:

- max bounding-box extent drift in mm;
- centroid drift in mm;
- deterministic sampled-vertex Chamfer distance in mm;
- deterministic sampled-vertex Hausdorff distance in mm;
- sample count used for the comparison.

These are **geometry preservation observations**, not printability claims.

The request supplies maximum tolerances. If topology passes but fidelity exceeds any required tolerance, status is `rejected_fidelity`.

## Canonical statuses

- `reconstructed_topology_valid`
- `reconstruction_invalid`
- `rejected_fidelity`
- `backend_unavailable`
- `backend_error`

No status in M1-004-002 means fully printable. M1-004-003 still owns self-intersection, thickness and minimum-feature validation.

## Appearance boundary

Robust reconstruction is topology-replacing by definition.

Therefore:

- `appearance_rebake_required = true` whenever a reconstructed mesh exists;
- original UV indexing is not authoritative after reconstruction;
- original texture/PBR provenance must remain attached to the source artifact so later rebaking can project appearance onto the repaired geometry.

## Implemented artifacts

Planned contracts:

- `packages/printable-mesh/schemas/robust-repair-request-0.1.0.json`
- `packages/printable-mesh/schemas/robust-repair-report-0.1.0.json`

Planned engine:

- `services/mesh-worker/robust_repair.py`

Planned regressions:

- `tests/test_m1_004_002_robust_repair.py`
- production-candidate CI using the real `point-cloud-utils` adapter on Linux x86_64

## Acceptance criteria

M1-004-002 is COMPLETE only when:

- robust-repair request/report schemas validate under JSON Schema Draft 2020-12;
- contracts are closed to provider-specific shortcuts;
- backend interface is replaceable and fail-closed;
- point-cloud-utils adapter is lazy-loaded and reports exact backend/version/algorithm provenance;
- quality tiers map deterministically to reconstruction budgets;
- output geometry is always re-diagnosed by CAD3MF;
- topology failure returns `reconstruction_invalid`;
- unavailable backend returns `backend_unavailable` with no fallback;
- shape-fidelity thresholds can reject a watertight but distorted result;
- robust reconstruction always reports `appearance_rebake_required=true`;
- real point-cloud-utils CI repairs at least one deliberately broken triangle mesh to a watertight manifold result;
- all existing M0/M1 and M1-004-001 regressions remain green.

## Next work packages

### M1-004-003 — Self-Intersection, Thickness & Minimum Feature Analysis

Implement the remaining explicit validation checks and conservative manufacturing thresholds.

### M1-004-004 — Real Figurine + Tank Repair Validation

Deploy the chosen robust backend on the GB10-side repair runtime, run the two real M1-003P GLBs through safe + robust repair, record output hashes and fidelity/topology evidence, then hand validated geometry to Manufacturing-IR.
