# M1-004-001 — Printable Mesh Contract & Topology Repair Baseline

Status: COMPLETE  
Milestone: CAD3MF M1  
Date: 2026-09-03  
Base: M1-003P COMPLETE / real SF3D Figurine + Tank GLBs on NVIDIA GB10

## Goal

Create the first canonical boundary between **generated 3D mesh** and **manufacturing-ready geometry**.

M1-003P proves CAD3MF can produce real textured GLB meshes from visual input. Both first physical benchmark meshes were observed as `watertight=false`, so M1-004 makes geometry quality explicit and repairable rather than treating model generation as printability.

## Canonical pipeline

```text
Mesh Artifact / Asset-IR
        |
        v
Printable Mesh Request
        |
        v
Pre-repair Diagnostics
        |
        v
Deterministic Safe Repair
        |
        v
Post-repair Diagnostics
        |
        v
Metric Invariant Gate
        |
        v
Printable Mesh Report
        |
        +-- valid_no_repair
        +-- repaired_topology_valid
        +-- needs_additional_validation
        +-- needs_robust_repair
        +-- rejected
        +-- error
```

## Geometry checks

The canonical geometry checks are:

1. `watertight`
2. `closed_boundary`
3. `manifold_edges`
4. `winding_consistent`
5. `self_intersections`
6. `minimum_thickness`
7. `minimum_feature`

M1-004-001 executes checks 1–4.

Checks 5–7 are already represented in the contract but remain `not_run` until later M1-004 work packages provide authoritative implementations. If any such check is required by the request, the report status is `needs_additional_validation`; it cannot claim geometric validity.

## Safe repair baseline

M1-004-001 applies only auditable local operations:

- remove duplicate faces;
- remove degenerate faces;
- remove unreferenced vertices;
- merge coincident vertices;
- repair face winding and orient closed components deterministically;
- fill only unambiguous triangle or quad boundary loops.

The core topology path is implemented without hidden `networkx` or `scipy` graph-engine requirements. Face components, adjacency, winding propagation, and small boundary loops are handled directly by CAD3MF using deterministic NumPy/Python logic.

This baseline deliberately does **not** perform voxel remeshing, aggressive decimation, non-uniform scaling, semantic part deletion, component pruning, shape completion, or AI hallucination.

Meshes that remain open or non-manifold after safe repair become `needs_robust_repair`. Boundary loops larger than four vertices are deliberately not guessed or triangulated in M1-004-001.

## Metric-scale invariant

M1-003P established trusted millimeter scaling before M1-004. Repair therefore preserves metric dimensions.

Rules:

- no non-uniform scale is allowed;
- no implicit unit conversion is allowed;
- bounding boxes are measured from vertices actually referenced by faces, so orphaned vertex-buffer garbage cannot fake scale drift;
- input/output geometry extents are compared against an explicit mm tolerance;
- scale drift beyond tolerance rejects the repair result.

## Appearance boundary

SF3D outputs PBR/UV data. Topology repair can invalidate UV correspondence even when geometry is repaired correctly.

Every report therefore contains `appearance_rebake_required`.

- topology-changing repair -> `appearance_rebake_required=true`;
- winding-only correction -> geometry is repaired but connectivity is unchanged, so rebake is not forced by this baseline.

M1-004-001 never silently claims that original texture correspondence remains authoritative after topology changes.

## Manufacturing boundary

Printable Mesh owns **geometry diagnostics and repair**.

It does not own:

- printer profile selection;
- filament assignment;
- orientation on a specific build plate;
- support generation;
- brim/infill/wall-loop policy;
- Bambu slicing;
- build-volume checks.

Those remain Manufacturing-IR / Slicer responsibilities.

## Implemented artifacts

Contracts:

- `packages/printable-mesh/schemas/printable-mesh-request-0.1.0.json`
- `packages/printable-mesh/schemas/printable-mesh-report-0.1.0.json`

Engine:

- `services/mesh-worker/printable_mesh.py`

Regression:

- `tests/test_m1_004_printable_mesh.py`

Production-matched CI:

- `.github/workflows/m1-004-printable-mesh.yml`
- geometry runtime: `numpy==1.26.4`, `trimesh==4.4.1`

## Acceptance closure

All M1-004-001 acceptance criteria are satisfied:

- JSON Schema Draft 2020-12 contracts: PASS;
- contracts reject shortcut `printable` fields: PASS;
- closed metric cube -> `valid_no_repair`: PASS;
- triangle-hole local repair -> `repaired_topology_valid`: PASS;
- duplicate face + orphan vertex audit/cleanup: PASS;
- metric-scale preservation: PASS;
- multi-component counting without graph soft dependencies: PASS;
- local winding flip repair: PASS;
- large boundary loop is conservatively left for robust repair: PASS;
- required unimplemented checks -> `needs_additional_validation`: PASS;
- topology repair -> explicit appearance rebake disclosure: PASS;
- existing M0/M1 geometry, golden, widget and MCP E2E regressions: PASS.

Verification on code head `bdea33e4dd822dc1402de70faf61195767435e37`:

- M1-004 production-matched CI run `33731087765` (#5): **SUCCESS**;
- main integration CI run `33731087774` (#81): **SUCCESS**.

## Next work packages

### M1-004-002 — Robust Topology Repair Backend

Handle holes / shells / non-manifold topology that deterministic local repair cannot safely resolve. Backend remains replaceable behind the same contract.

### M1-004-003 — Self-Intersection, Thickness & Minimum Feature Analysis

Implement the currently explicit `not_run` checks and define conservative thresholds independent from any specific slicer.

### M1-004-004 — Real Figurine + Tank Repair Validation

Run the two M1-003P GB10 GLBs through the complete Printable Mesh engine, record repaired artifact hashes, geometry reports, screenshots, and hand off validated geometry to Manufacturing-IR.
