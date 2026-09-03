# M1-004-001 — Printable Mesh Contract & Topology Repair Baseline

Status: In Development  
Milestone: CAD3MF M1  
Date: 2026-09-03  
Base: M1-003P COMPLETE / real SF3D Figurine + Tank GLBs on NVIDIA GB10

## Goal

Create the first canonical boundary between **generated 3D mesh** and **manufacturing-ready geometry**.

M1-003P proves CAD3MF can produce real textured GLB meshes from visual input. Both first physical benchmark meshes were observed as `watertight=false`, so M1-004 must make geometry quality explicit and repairable rather than treating model generation as printability.

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

Checks 5–7 are already represented in the contract but remain `not_run` until later M1-004 work packages provide authoritative implementations. If any such check is required by the request, the report status must be `needs_additional_validation`; it must not claim geometric validity.

## Safe repair baseline

M1-004-001 may apply only auditable local operations:

- remove duplicate faces;
- remove degenerate faces;
- remove unreferenced vertices;
- merge coincident vertices;
- fix winding / normals;
- fill small triangle or quad holes when the local repair backend can do so safely.

This baseline deliberately does **not** perform voxel remeshing, aggressive decimation, non-uniform scaling, semantic part deletion, component pruning, shape completion, or AI hallucination.

Meshes that remain open or non-manifold after safe repair become `needs_robust_repair`.

## Metric-scale invariant

M1-003P established trusted millimeter scaling before M1-004. Repair must therefore preserve metric dimensions.

Rules:

- no non-uniform scale is allowed;
- no implicit unit conversion is allowed;
- bounding boxes are measured from vertices actually referenced by faces, so orphaned vertex-buffer garbage cannot fake scale drift;
- input/output geometry extents are compared against an explicit mm tolerance;
- scale drift beyond tolerance rejects the repair result.

## Appearance boundary

SF3D outputs PBR/UV data. Topology repair can invalidate UV correspondence even when geometry is repaired correctly.

Therefore every report contains `appearance_rebake_required`.

If a topology-changing repair is applied, M1-004-001 marks appearance rebaking as required. It does not silently claim that the original texture remains authoritative.

## Manufacturing boundary

Printable Mesh owns **geometry validity**.

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

## Acceptance criteria

M1-004-001 is COMPLETE only when:

- both schemas validate under JSON Schema Draft 2020-12;
- contracts are closed to provider-specific or shortcut `printable` fields;
- a closed metric cube returns `valid_no_repair`;
- a small repairable hole is filled and returns `repaired_topology_valid`;
- duplicate faces and orphaned vertices are audited and removed without metric-scale drift;
- an unimplemented required check blocks validity via `needs_additional_validation`;
- no non-uniform scaling is performed;
- topology-changing repair surfaces `appearance_rebake_required=true`;
- all existing M0/M1 regression remains green.

## Next work packages

### M1-004-002 — Robust Topology Repair Backend

Handle holes / shells / non-manifold topology that deterministic local repair cannot safely resolve. Backend remains replaceable behind the same contract.

### M1-004-003 — Self-Intersection, Thickness & Minimum Feature Analysis

Implement the currently explicit `not_run` checks and define conservative thresholds independent from any specific slicer.

### M1-004-004 — Real Figurine + Tank Repair Validation

Run the two M1-003P GB10 GLBs through the complete Printable Mesh engine, record repaired artifact hashes, geometry reports, screenshots, and hand off validated geometry to Manufacturing-IR.
