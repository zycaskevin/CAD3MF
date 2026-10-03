# CAD3MF v0.2 — AI Geometry Engineering Bridge

Status: In Development  
Branch: `feat/v0.2-engineering-bridge`  
Baseline: `38bd978af5cca3d8a2aed4cf0919d6d8652c9feb`

## Product direction

CAD3MF v0.2 is not a general-purpose generative 3D modeller.

Its role is to turn externally generated or authored geometry into engineering-authoritative, manufacturable product geometry.

Canonical split:

```text
Generative geometry (Meshy / other provider / artist)
        ↓
CAD3MF reference import
        ↓
Engineering constraints
        ↓
Assembly + interface definition
        ↓
Fit / interference / manufacturing validation
        ↓
STEP / STL / 3MF handoff
```

## Non-goals

- Do not replace Meshy, Blender, or other generative/artistic modelling systems.
- Do not infer safety-critical dimensions when a measured/user dimension is required.
- Do not treat watertightness alone as proof of printability.
- Do not embed arbitrary Python/G-code in user-facing IRs.
- Do not make slicer or printer control part of the first v0.2 slice.

## Workstream

### V02-001 — Baseline normalization
- Use the latest stacked M1-004 Tank/Figurine validation head as the v0.2 engineering baseline.
- Preserve M0 parametric CAD and M1 visual/mesh contracts.
- Do not restart from `main`, which does not contain the active implementation history.

Acceptance:
- v0.2 branch starts from the current M1-004 validation head.
- Existing CAD / visual / mesh contracts remain addressable.

### V02-002 — Reference Geometry Import
Goal: ingest externally generated GLB/OBJ as a canonical CAD3MF asset.

First vertical slice:
- `import_reference_asset` MCP tool.
- GLB + OBJ support.
- HTTPS-only retrieval.
- reject localhost/private-network targets.
- redirect limit.
- bounded download size.
- magic/content validation.
- SHA-256 binding.
- immutable artifact persistence.
- explicit external provenance.
- emit Asset-IR 0.2 without inventing a fake design-intent revision.
- persist an auditable `geometry_import` job.

Later extension:
- STL.
- STEP as engineering reference/BREP route.
- 3MF reference import where needed.

Acceptance:
- an external GLB/OBJ can be imported without a prior turnaround pipeline.
- imported bytes are digest-bound and restart-persistent.
- imported content is never called printable merely because import succeeded.
- malicious/private-network URL inputs fail closed.

### V02-003 — Engineering Envelope / Keep-out IR
Goal: define physical volumes that generated shells may not occupy.

Required primitives:
- box.
- cylinder.
- optional mesh envelope later.

Canonical uses:
- battery.
- PCB.
- motors.
- camera.
- ToF.
- speaker.
- wiring/service volume.
- motion swept volume.

Acceptance:
- envelopes use mm.
- coordinate frame is explicit.
- keep-out vs required-contact semantics are explicit.
- no envelope requires decorative mesh generation.

### V02-004 — Assembly Constraints + Interfaces
Build on existing Assembly-IR instead of inventing a parallel assembly model.

Required:
- parent/child part placement.
- fixed transform.
- datum/alignment intent.
- magnetic mount.
- snap fit.
- peg/socket.
- screw.
- press fit.
- dovetail.
- free placement.
- interface clearance/tolerance policy.

Acceptance:
- interface definitions remain declarative.
- no arbitrary executable payload.
- AI Tank chassis + shell + turret can be represented.

### V02-005 — Manufacturing Profiles
Goal: move repeated fit/tolerance decisions into reusable policy.

Profile dimensions:
- process.
- material.
- nozzle.
- target fit class.
- minimum wall.
- minimum feature.
- default clearance.
- snap-fit allowance.
- pilot-hole policy.
- build volume.

Initial profile target:
- Bambu-class FDM.
- PETG.
- 0.4 mm nozzle.

Acceptance:
- profile values are data, not hidden prompt assumptions.
- per-project overrides remain explicit.
- profile application is reproducible.

### V02-006 — Fit / Interference Validation
Goal: validate whether parts can coexist and interfaces are geometrically plausible.

First checks:
- AABB / envelope collision.
- keep-out violation.
- minimum requested clearance.
- assembly reference integrity.
- required part presence.

Later:
- exact mesh/BREP collision.
- screw-wall thickness.
- camera FOV obstruction.
- service/removal direction.
- moving swept-volume checks.

Acceptance:
- PASS/FAIL/UNKNOWN are distinct.
- no approximate check is reported as exact.
- report contains the offending part/envelope pair and measured overlap/clearance where available.

### V02-007 — Meshy → CAD3MF Handoff
Goal: make Meshy one supported upstream geometry provider, not a hard dependency.

Contract:
- provider-neutral external asset import.
- provenance records provider/model/job/file digest.
- Meshy output can enter the same path as artist/manual/provider output.
- CAD3MF owns engineering constraints after import.

Acceptance:
- no Meshy-specific geometry assumptions in core IR.
- Meshy can be swapped without changing Assembly/Manufacturing contracts.

### V02-008 — Export / Preview Integration
Goal: preserve visible, usable artifacts throughout engineering.

Required:
- reference mesh preview.
- engineering overlays for envelopes/interfaces.
- STL/3MF manufacturing handoff.
- STEP remains authoritative for parametric/BREP CAD where available.
- provenance remains attached to exported revision evidence.

### V02-009 — AI Tank Real UAT
Golden product:
- Pocket AI / AI Tank around 160 mm longest extent.

Required representation:
- external/generative outer shell.
- chassis engineering body.
- motor volumes.
- battery keep-out.
- PCB keep-out.
- camera/ToF apertures.
- turret/interface.
- at least one removable service interface.

UAT success:
1. import real tank shell.
2. apply 160 mm target scale/reference.
3. add engineering envelopes.
4. define assembly interfaces.
5. detect at least one intentional negative-control interference.
6. fix it.
7. generate a clean validation report.
8. export a printable handoff artifact.
9. keep evidence showing the exact revision and hashes.

## Development cell / evidence gate

Every slice follows:

Builder → Independent Reviewer → Verifier/QA → Real UAT → Evidence Gate

A slice is not complete because code exists. Completion requires:
- contract tests.
- negative controls.
- regression tests.
- runtime evidence.
- user-visible artifact or report where applicable.

## Immediate implementation order

1. V02-002 reference geometry import.
2. V02-003 envelope/keep-out schema + runtime.
3. V02-006 approximate interference validator.
4. V02-004 assembly runtime wiring.
5. V02-005 manufacturing profiles.
6. V02-007 direct Meshy handoff acceptance.
7. V02-009 AI Tank real UAT.

This order deliberately creates a usable vertical slice before expanding precision.
