# M1-004-003 — Self-Intersection, Thickness & Minimum Feature Analysis

Status: In Development  
Milestone: CAD3MF M1  
Date: 2026-09-03  
Base: M1-004-002 COMPLETE / robust topology reconstruction

## Goal

Turn the three explicit M1-004 checks that were previously `not_run` into auditable geometry analysis:

1. `self_intersections`
2. `minimum_thickness`
3. `minimum_feature`

This work package does **not** select printer profiles or slicer settings. Thresholds are explicit millimeter constraints supplied by design/manufacturing intent.

## Canonical pipeline

```text
Topology-valid Mesh
        |
        v
Manufacturing Geometry Analysis
        |
        +-- Self-Intersection Analyzer
        |      sweep AABB broad phase
        |      + FCL TriangleP narrow phase
        |
        +-- Thickness Analyzer
        |      inward face-normal rays
        |      + PCU / Intel Embree
        |
        +-- Minimum Feature Analyzer
               outward face-normal rays
               + opposing-surface clearance
               + PCU / Intel Embree
        |
        v
Manufacturing Geometry Analysis Report
        |
        v
Printable Mesh checks
```

## Self-intersection semantics

Backend: `python-fcl` / FCL.

Algorithm:

1. compute one AABB per triangle;
2. deterministic sweep on the X axis to generate overlapping candidate pairs;
3. require overlap on Y/Z as well;
4. exclude face pairs that share a mesh vertex because legal mesh adjacency touches at a vertex/edge by design;
5. use FCL `TriangleP` collision as the narrow-phase test for every remaining candidate pair.

A PASS requires exhaustive testing of all generated non-adjacent AABB candidates and zero colliding triangle pairs.

The first selected backend is `python-fcl 0.7.0.11` because the project is BSD-licensed and the current release provides Linux aarch64 CPython 3.11 wheels, making the same path deployable on NVIDIA GB10.

## Minimum thickness semantics

Canonical observation:

`inward_face_normal_chord`

For each analyzed triangle:

1. calculate the triangle centroid and outward face normal;
2. move the origin a tiny metric epsilon inside the solid;
3. cast a ray along the inward normal;
4. measure the first opposite surface intersection;
5. report the smallest observed chord in millimeters.

A PASS requires:

- topology prerequisites (`watertight`, manifold edges, consistent winding);
- a supplied positive `minimum_thickness_mm` threshold;
- exhaustive face coverage;
- a valid inward hit for every sampled face;
- observed minimum chord >= threshold.

If a sub-threshold chord is found, the result can FAIL even when face coverage is not exhaustive. A partial scan with no violation is `unknown`, never PASS.

## Minimum feature semantics

Canonical M1-004-003 interpretation:

`outward_opposing_surface_clearance`

This detects **negative geometric features** such as narrow slots, gaps and channels. Positive thin members are governed by the minimum-thickness check.

For each analyzed triangle:

1. start just outside the surface;
2. cast along the outward face normal;
3. if another mesh surface is hit, require the hit surface normal to oppose the source normal;
4. record the first opposing-surface clearance;
5. report the smallest observed clearance in millimeters.

A mesh with no opposing outward hit has no negative feature observed by this canonical facet-normal method and can PASS when the full facet set was analyzed.

The result is explicitly scoped to the discrete mesh facet normals. It is not presented as a continuous arbitrary-angle Hausdorff/clearance theorem.

## Native analysis backend

Pinned runtime:

```text
numpy 1.26.4
trimesh 4.4.1
point-cloud-utils 0.34.0
python-fcl 0.7.0.11
```

`point-cloud-utils` provides repeated ray/mesh queries through Intel Embree. FCL provides triangle collision narrow phase.

Both native backends are lazy-loaded. The general CAD3MF process can import the analyzer module without either package installed. A requested check with an unavailable backend fails closed as `backend_unavailable`.

## Topology prerequisites

Thickness and minimum-feature ray analysis are not authoritative on an open or non-manifold mesh.

They run only when:

- `watertight = true`
- `nonmanifold_edge_count = 0`
- `winding_consistent = true`

Otherwise the result is `unknown` and the native ray backend is not invoked.

Self-intersection analysis is independent and may run on broken/open triangle soup because it is itself part of deciding whether geometry is valid.

## Report boundary

New evidence contract:

- `packages/printable-mesh/schemas/manufacturing-geometry-analysis-report-0.1.0.json`

The report records:

- exact backend/version/algorithm provenance;
- topology prerequisites;
- self-intersection candidate/test/intersection pair counts;
- thickness threshold, minimum observation, face/hit coverage and method scope;
- minimum-feature threshold, minimum opposing clearance, coverage and method scope;
- fail-closed overall status.

`apply_analysis_to_printable_checks()` maps the three observations back into the existing Printable Mesh Report check structure without changing its 0.1.0 schema.

## Status rules

For every required check:

- `pass`: authoritative for the declared method and complete required coverage;
- `fail`: a violation was observed;
- `unknown`: prerequisites, threshold or coverage are insufficient;
- `backend_unavailable`: required native backend is absent;
- `error`: analyzer execution failed.

Overall precedence:

```text
error
  > fail
  > backend_unavailable
  > unknown
  > pass
```

No M1-004-003 status is a slicer-level guarantee.

## Native regression fixtures

Dedicated CI must prove all of the following with real backends:

1. two non-adjacent triangles that geometrically cross are detected by real FCL;
2. a normal closed box has no self-intersection;
3. a `20 x 30 x 40 mm` box reports minimum inward thickness of `20 mm`;
4. a `0.6 mm` thin member fails a `0.8 mm` minimum-thickness requirement;
5. two solids separated by a `0.5 mm` exterior gap fail a `0.8 mm` minimum-feature requirement.

## Acceptance criteria

M1-004-003 is COMPLETE only when:

- the manufacturing analysis schema validates under JSON Schema Draft 2020-12;
- self-intersection uses exhaustive non-adjacent candidate testing and a real collision narrow phase;
- legal face adjacency is excluded from self-intersection failures;
- thickness and feature checks refuse invalid topology;
- missing thresholds remain `unknown`, never PASS;
- partial thickness coverage cannot PASS without a discovered failure;
- all native regression fixtures pass with real FCL/PCU backends;
- analysis results map into existing Printable Mesh checks;
- existing M0/M1, M1-004-001 and M1-004-002 regressions remain green.

## Next work package

### M1-004-004 — Real Figurine + Tank Repair & Manufacturing Validation

Deploy the validated analysis/repair runtimes on GB10, run the two real M1-003P GLBs through:

```text
Safe Repair
  -> Robust Repair if required
  -> Self-Intersection Analysis
  -> Thickness Analysis
  -> Minimum Feature Analysis
  -> final geometry evidence
```

Record hashes, repaired artifacts, dimension/fidelity evidence and visual inspection before handing geometry to Manufacturing-IR.
