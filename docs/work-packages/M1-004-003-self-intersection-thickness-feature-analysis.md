# M1-004-003 — Self-Intersection, Thickness & Minimum Feature Analysis

Status: COMPLETE pending closure-head CI  
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
        |      deterministic AABB sweep broad phase
        |      + FCL one-triangle BVHModel narrow phase
        |      + topology-aware legal adjacency filter
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

Final algorithm ID:

`sweep-aabb-plus-bvh-collision-with-topology-filter`

Algorithm:

1. compute one AABB per triangle;
2. deterministic sweep on the X axis to generate overlapping candidate pairs;
3. require overlap on Y/Z as well;
4. test **every** overlapping candidate pair through FCL;
5. represent each triangle as a one-triangle `BVHModel` because direct `TriangleP` ↔ `TriangleP` collision is not supported by the validated Python-FCL runtime;
6. for pairs with no shared topology, any FCL collision is a self-intersection;
7. for pairs sharing one vertex or one edge, classify the actual geometric triangle intersection;
8. accept adjacency only when the intersection is confined to the shared vertex or shared edge;
9. shared topology with overlap elsewhere remains a self-intersection.

A PASS requires exhaustive testing of every generated AABB candidate and zero illegal geometric intersections.

This avoids the earlier false-negative risk of skipping an entire face pair merely because the two faces share a vertex or edge.

The selected backend is `python-fcl 0.7.0.11`. The project is BSD-licensed, and the reviewed current release provides Linux aarch64 CPython 3.11 wheels, so this narrow-phase path is suitable for later GB10 deployment without a custom FCL build.

## Minimum thickness semantics

Canonical observation:

`inward_face_normal_chord`

For each analyzed triangle:

1. calculate the triangle centroid and outward face normal;
2. move the ray origin a small metric epsilon inside the solid;
3. cast along the inward normal;
4. measure the first opposite-surface intersection;
5. report the smallest observed material chord in millimeters.

A PASS requires:

- topology prerequisites (`watertight`, manifold edges, consistent winding);
- a supplied positive `minimum_thickness_mm` threshold;
- exhaustive face coverage;
- a valid inward hit for every sampled face;
- observed minimum chord >= threshold.

If a sub-threshold chord is found, the result may FAIL even when coverage is partial. A partial scan with no discovered violation is `unknown`, never PASS.

## Minimum feature semantics

Canonical M1-004-003 interpretation:

`outward_opposing_surface_clearance`

This detects **negative geometric features** such as narrow slots, gaps and channels. Positive thin members are governed by the minimum-thickness check.

For each analyzed triangle:

1. start just outside the surface;
2. cast along the outward face normal;
3. if another surface is hit, require the hit surface normal to oppose the source normal;
4. record the first opposing-surface clearance;
5. report the smallest observed clearance in millimeters.

A mesh with no opposing outward hit has no negative feature observed by this canonical facet-normal method and can PASS when the complete facet set was analyzed.

The result is deliberately scoped to discrete mesh facet normals. It is not presented as a continuous arbitrary-angle clearance or Hausdorff theorem.

## Native analysis runtime

Pinned runtime:

```text
numpy 1.26.4
trimesh 4.4.1
point-cloud-utils 0.34.0
python-fcl 0.7.0.11
```

Observed transitive runtime in CI also includes SciPy.

`point-cloud-utils` provides repeated ray/mesh queries through Intel Embree. `python-fcl` provides the BVH mesh collision narrow phase.

Both native backends are lazy-loaded. The general CAD3MF process can import the analyzer module without either package installed. A requested check with an unavailable backend fails closed as `backend_unavailable`.

Deployment caveat:

- `python-fcl 0.7.0.11` has a reviewed Linux aarch64 / CPython 3.11 wheel path;
- `point-cloud-utils 0.34.0` does **not** currently provide the required Linux ARM64 wheel for GB10;
- therefore PCU must still be source-built in the isolated GB10 manufacturing-analysis runtime during M1-004-004;
- the known-working SF3D venv must not be modified.

## Topology prerequisites

Thickness and minimum-feature ray analysis are not authoritative on an open or non-manifold mesh.

They run only when:

- `watertight = true`
- `nonmanifold_edge_count = 0`
- `winding_consistent = true`

Otherwise the result is `unknown` and the ray backend is not invoked.

Self-intersection analysis is independent and may run on broken/open triangle soup because it is itself part of deciding whether geometry is valid.

## Report boundary

Evidence contract:

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

No M1-004-003 status is a slicer-level print guarantee.

## Native regression evidence

The dedicated native suite now contains 10 contract tests plus 8 real native geometry fixtures.

Contract suite verifies:

- schema validity;
- all-pass mapping;
- self-intersection failure;
- thickness failure;
- minimum-feature failure;
- backend-unavailable behavior;
- invalid-topology ray blocking;
- mapping into existing Printable Mesh checks;
- missing threshold remains `unknown`;
- invalid sample limits are rejected.

Native FCL/Embree suite verifies:

1. two non-adjacent crossing triangles are detected as self-intersection;
2. a normal closed box has no self-intersection;
3. a legal coplanar shared edge is accepted;
4. faces sharing a vertex but intersecting elsewhere still FAIL;
5. faces sharing an edge but overlapping over extra coplanar area still FAIL;
6. a `20 x 30 x 40 mm` box reports minimum inward thickness of approximately `20 mm`;
7. a `0.6 mm` thin member fails a `0.8 mm` thickness requirement;
8. two solids separated by a `0.5 mm` exterior gap fail a `0.8 mm` minimum-feature requirement.

Latest pre-closure native run on functional head `49c2fc7c4064ef9c9b7ad68a08a3dffdcbac00bd`:

- manufacturing-analysis run `33771511474` (#11): **SUCCESS**
- 10 contract tests: PASS
- 8 native FCL/Embree tests: PASS
- Printable Mesh run `33771511457` (#22): **SUCCESS**
- Robust Repair run `33771511467` (#15): **SUCCESS**

Full repository CI run `33771511454` (#98) has already passed Python lint, complete geometry tests and M0 golden artifact generation at the time of canonical closure preparation; final widget/MCP completion is the remaining integration gate before closure-head freeze.

## Acceptance criteria

M1-004-003 is COMPLETE only when:

- the manufacturing analysis schema validates under JSON Schema Draft 2020-12;
- all overlapping self-intersection candidates receive a real FCL collision narrow-phase test;
- legal shared-vertex/shared-edge contact is distinguished from extra geometric overlap;
- thickness and feature checks refuse invalid topology;
- missing thresholds remain `unknown`, never PASS;
- partial thickness coverage cannot PASS without a discovered failure;
- all native regression fixtures pass with real FCL/PCU backends;
- analysis results map into existing Printable Mesh checks;
- existing M0/M1, M1-004-001 and M1-004-002 regressions remain green;
- closure-head manufacturing-analysis, Printable Mesh, Robust Repair and full repository CI are all SUCCESS.

## Next work package

### M1-004-004 — Real Figurine + Tank Repair & Manufacturing Validation

Deploy the validated analysis/repair runtimes on GB10 and run the two real M1-003P GLBs through:

```text
Safe Repair
  -> Robust Repair if required
  -> Self-Intersection Analysis
  -> Thickness Analysis
  -> Minimum Feature Analysis
  -> final geometry evidence
```

Record source/repaired hashes, bounding boxes, robust-repair fidelity evidence, manufacturing-analysis evidence and visual inspection before handing geometry to Manufacturing-IR.
