# CAD3MF Printable Mesh

`printable-mesh` owns geometry diagnostics and geometry-preserving repair between generated mesh assets and manufacturing planning.

It does **not** own printer profiles, slicing, supports, filament assignment, build-volume placement, or Bambu project generation. Those remain Manufacturing / Slicer concerns.

## Canonical boundary

```text
Mesh Artifact / Asset-IR
        |
        v
Printable Mesh Request
        |
        v
Diagnostics
        |
        +-- watertight
        +-- closed boundary
        +-- non-manifold edges
        +-- winding consistency
        +-- self intersections
        +-- minimum thickness
        +-- minimum feature
        |
        v
Repair Operations
        |
        v
Printable Mesh Report
        |
        v
Repaired Mesh Candidate
        |
        v
Manufacturing-IR
```

A generated mesh is never considered printable merely because it can be loaded or exported.

M1-004-001 implements the topology baseline: deterministic diagnostics, safe local topology cleanup, small-hole filling, winding repair, and metric-scale invariants. Self-intersection, thickness, and minimum-feature checks remain explicit `not_run` until later M1-004 work packages implement them.

## Non-negotiable invariants

- no silent non-uniform scaling;
- no printer or slicer policy inside Printable Mesh;
- no `printable=true` shortcut;
- required but unimplemented checks remain `not_run`, never implicitly PASS;
- topology-changing repairs must disclose that texture/material rebaking may be required;
- failure to achieve a closed topology is reported as `needs_robust_repair`, not hidden.
