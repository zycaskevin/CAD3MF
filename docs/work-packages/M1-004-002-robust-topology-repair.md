# M1-004-002 — Robust Topology Repair Backend

Status: COMPLETE  
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
       -> vertices_mm, faces
```

Rules:

1. The backend receives millimeter geometry and must return the same coordinate system.
2. No backend-specific fields enter Asset-IR or Manufacturing-IR.
3. Unknown or unavailable backends fail closed.
4. There is no fallback to the M1-003 deterministic cube or to a silent alternate backend.
5. Global reconstruction invalidates authoritative UV/PBR correspondence; material rebaking is required.
6. Backend success is never authoritative. CAD3MF always re-validates returned topology.

## First production candidate

### point-cloud-utils / Watertight Manifold reconstruction

First adapter: `point-cloud-utils` `make_mesh_watertight()`.

Selection rationale:

- current project/release path is MIT;
- explicitly exposes watertight reconstruction from arbitrary triangle meshes;
- algorithm is intended for triangle-soup / broken-mesh reconstruction;
- current releases removed prior GPL dependencies;
- Python API is NumPy-array based and can remain isolated behind the worker boundary.

Deployment caveat:

- the validated CI artifact is Linux x86_64;
- the reviewed current PyPI artifacts do not provide the Linux ARM64 wheel required by NVIDIA GB10/aarch64;
- therefore GB10 deployment requires a **separate robust-repair runtime/source build**, not the existing SF3D venv;
- GB10 source-build validation is deferred to M1-004-004 rather than being assumed here.

Rejected as default backends at this stage:

- PyMeshFix / MeshFix: GPL and/or separate commercial licensing requirement;
- MeshLab / PyMeshLab: GPL distribution boundary;
- MeshLib: reviewed public license is non-commercial/education;
- Manifold3D: permissive Apache-2.0 and useful as a manifold kernel, but arbitrary broken input is not its primary reconstruction contract.

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

A backend returning arrays is not enough. Geometry must pass CAD3MF diagnostics.

## Shape-fidelity gate

Global reconstruction can make a mesh watertight while destroying product identity or dimensions. M1-004-002 therefore adds an explicit fidelity gate.

Required observations:

- max bounding-box extent drift in mm;
- centroid drift in mm;
- deterministic sampled-vertex Chamfer distance in mm;
- deterministic sampled-vertex Hausdorff distance in mm;
- sample count used for comparison.

These are **geometry-preservation observations**, not printability claims. The sampled metrics are point-set measurements over deterministic vertex samples and are not claimed to be continuous-surface Hausdorff/Chamfer values.

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

- reconstructed geometry requires appearance rebaking;
- original UV indexing is not authoritative after reconstruction;
- original texture/PBR provenance remains attached to the source artifact so later rebaking can project appearance onto repaired geometry.

## Implemented artifacts

Contracts:

- `packages/printable-mesh/schemas/robust-repair-request-0.1.0.json`
- `packages/printable-mesh/schemas/robust-repair-report-0.1.0.json`

Engine/runtime:

- `services/mesh-worker/robust_repair.py`
- `services/mesh-worker/requirements-robust-repair.txt`

Regression/integration:

- `tests/test_m1_004_002_robust_repair.py`
- `tests/test_m1_004_002_pcu_integration.py`
- `.github/workflows/m1-004-robust-repair.yml`

Evidence:

- `docs/evidence/M1-004-002-2026-09-03.md`

## Verification

Functional implementation head:

`f45241b23585730d03806ed8d6f44b7444512f49`

### Real robust-repair CI

Workflow: `m1-004-robust-repair`  
Run: `33766930962` (#2)  
Result: **SUCCESS**

Observed runtime:

- Python 3.11;
- `numpy 1.26.4`;
- `trimesh 4.4.1`;
- `point-cloud-utils 0.34.0`;
- observed transitive `scipy 1.17.1`.

Regression results:

```text
8 passed in 0.63s
1 passed in 1.24s
```

The first result validates contracts, provenance, deterministic quality mapping, fail-closed behavior, topology re-validation and fidelity rejection.

The second result uses the real `point-cloud-utils` adapter on a deliberately open `40 x 60 x 120 mm` box with three removed faces. `make_mesh_watertight()` reconstructs geometry which then passes CAD3MF with:

- `watertight = true`;
- `boundary_edge_count = 0`;
- `nonmanifold_edge_count = 0`;
- `winding_consistent = true`.

The real integration test uses deliberately generous fidelity thresholds to isolate topology reconstruction. It does not calibrate production fidelity tolerances.

### M1-004-001 regression

Workflow: `m1-004-printable-mesh`  
Run: `33766931002` (#9)  
Result: **SUCCESS**

### Full integration regression

Workflow: `ci`  
Run: `33766930970` (#85)  
Result: **SUCCESS**

Verified:

- Python lint/format: PASS;
- complete geometry test suite: PASS;
- M0 golden artifacts: PASS;
- ChatGPT widget build/check: PASS;
- TypeScript typecheck: PASS;
- MCP stdio E2E: PASS;
- MCP HTTP + ChatGPT App E2E: PASS;
- artifact uploads: PASS.

## Acceptance criteria

M1-004-002 is COMPLETE because:

- robust-repair request/report schemas validate under JSON Schema Draft 2020-12;
- contracts are closed to provider-specific shortcuts;
- backend interface is replaceable and fail-closed;
- point-cloud-utils adapter is lazy-loaded and reports backend/version/algorithm provenance;
- quality tiers map deterministically to reconstruction budgets;
- output geometry is always re-diagnosed by CAD3MF;
- topology failure returns `reconstruction_invalid`;
- unavailable backend returns `backend_unavailable` with no fallback;
- shape-fidelity thresholds reject a watertight but distorted fixture;
- robust reconstruction requires appearance rebaking;
- real point-cloud-utils CI repairs a deliberately broken triangle mesh to geometry that passes the CAD3MF manifold topology gate;
- all existing M0/M1 and M1-004-001 regressions remain green.

## Explicit non-claims

M1-004-002 does **not** claim:

- full printability;
- authoritative self-intersection clearance;
- minimum wall thickness;
- minimum feature size;
- calibrated production fidelity limits for characters or vehicles;
- GB10/aarch64 point-cloud-utils deployment;
- successful repair of the real Figurine/Tank assets yet.

## Next work packages

### M1-004-003 — Self-Intersection, Thickness & Minimum Feature Analysis

Implement the remaining explicit validation checks and conservative manufacturing thresholds.

### M1-004-004 — Real Figurine + Tank Repair Validation

Build/deploy the isolated robust-repair runtime on the GB10/aarch64 side, run the two real M1-003P GLBs through safe + robust repair, record output hashes and topology/fidelity evidence, then hand validated geometry to Manufacturing-IR.
