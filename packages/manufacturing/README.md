# Manufacturing

CAD3MF manufacturing support is split into two boundaries.

## M0-E — physical acceptance receipt

The package contains a small backend-neutral receipt schema for binding a real print back to an immutable 3MF artifact. A receipt records:

- project and revision
- exact 3MF SHA-256
- printer, material, and optional slicer profile
- measured critical dimensions and tolerances
- fit result
- overall PASS/FAIL derived from the evidence

A physical receipt is manufacturing evidence. It does not mutate CAD-IR and never becomes design authority.

## M2 — printability policy (reserved)

Later work may add minimum wall thickness, clearance and hole rules, overhang/bridge policy, build-volume checks, orientation hints, material profiles, and printer profiles.

M0 geometry validity does not by itself claim manufacturing/printability PASS.
