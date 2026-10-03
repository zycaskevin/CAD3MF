# CAD3MF v0.2 — Real Tank Engineering Bridge UAT

Status: **PASS**  
Date: 2026-10-04  
Branch: `feat/v0.2-engineering-bridge`  
Runtime host: NVIDIA GB10  
UAT code baseline: `1c6063bf32d6c1419c1045f9643887d58733a7f9`

## Goal

Prove that the CAD3MF v0.2 engineering bridge can ingest a **real previously generated Tank GLB**, bind it to immutable Asset-IR provenance, apply engineering keep-out/occupied volumes, detect an intentional interference, create a corrected revision that passes the declared envelope policy, validate an Assembly-IR graph, and resolve a reusable manufacturing fit policy.

This is a real-model UAT, not a synthetic geometry fixture.

## Real source artifact

Source:

`/home/zycas/cad3mf-sf3d/benchmarks/tank/tank-160mm.glb`

Observed:

- bytes: `638656`
- SHA-256: `26489a7c9b05b74feda910f3b27d5f63922fd5e9ed7d9858393aa992b36c843b`
- vertices: `11000`
- faces: `17652`
- extents: `160.0 × 105.11532592773438 × 80.66909599304199 mm`
- watertight: `false`

The source digest exactly matches the earlier M1-003P GB10 evidence for `REF-VIS-002-TANK-GB10`.

## V02-002 — Reference import

Imported through the v0.2 `MeshRuntime.importReferenceAsset` path using the real GLB bytes.

Result:

- project: `uat-real-tank-v02`
- Asset-IR revision: `asset-r1`
- status: `reference_imported`
- geometry SHA-256: `26489a7c9b05b74feda910f3b27d5f63922fd5e9ed7d9858393aa992b36c843b`
- declared target: `target_length = 160 mm`
- restart persistence: PASS; latest persisted revision remained `asset-r1`

No Design-Intent or turnaround revision was fabricated for this external reference.

## V02-003 / V02-006 — Engineering envelope negative control

### Deliberately invalid revision

Revision: `envelopes-r1`

The PCB occupied volume was intentionally placed inside the battery keep-out region.

Result: **FAIL**

Detected pair:

- `battery-clearance`
- `pcb`
- policy: `occupied_vs_keep_out`
- overlap: `43.5 × 30 × 4 mm`
- overlap volume: `5220 mm³`
- approximate: `false` for this box-vs-box AABB check

This proves that the v0.2 gate does not always return PASS.

### Corrected revision

Revision: `envelopes-r2`

The PCB was moved away from the battery keep-out region and two declared motor volumes were added.

Result: **PASS**

Summary:

- pass: `6`
- fail: `0`
- unknown: `0`

This PASS applies to the **declared v0.2 engineering-envelope policy only**. It is not exact mesh/BREP interference proof.

## V02-004 — Assembly runtime

Assembly revision: `assembly-r1`

Required product graph:

- chassis — CAD reference
- shell — real imported Asset-IR / real Tank SHA
- electronics module — CAD reference

Interfaces:

- chassis ↔ shell: `M2` screw
- chassis ↔ electronics: `M2` screw

Validation result: **PASS**

Summary:

- pass: `5`
- fail: `0`
- unknown: `0`

## V02-005 — Manufacturing profile

Profile:

`bambu-class-petg-0.4-starter@0.1.0`

Resolved starter policies:

- default clearance: `0.25 mm`
- snap-fit allowance: `0.3 mm`

Both results preserved:

- `calibration_required = true`
- `evidence_status = unverified`
- `authoritative_for_machine = false`

These values are CAD3MF starter project policy, **not Bambu official specifications and not universal FDM truth**.

## Viewer / HTTP evidence

The same v0.2 branch has passing CI for:

- immutable `/mesh-artifacts/:project/:artifact` HTTP serving with SHA verification
- `render_engineering_view`
- engineering Viewer mode
- Z-up engineering → Y-up Three.js visual mapping
- visual-only longest-extent normalization
- engineering envelope overlays
- interference and assembly status display
- hostile Host rejection
- MCP stdio E2E
- MCP HTTP + ChatGPT App E2E
- strict TypeScript
- ChatGPT widget build/check

The Viewer visual normalization is explicitly **non-authoritative**. It does not replace geometry validation.

## Manufacturing boundary

The real Tank remains `watertight=false`.

Therefore this UAT does **not** claim:

- printable geometry
- exact BREP clearance
- successful slicing
- successful physical print
- calibrated snap-fit behavior
- validated screw pilot-hole diameter
- Meshy-specific generation success

Existing M1-004 repair / topology / manufacturing-analysis stages remain responsible for printability evidence.

## Decision

**PASS — CAD3MF v0.2 has crossed the first real-model engineering-bridge milestone.**

The real Tank can now enter the provider-neutral external geometry path, retain immutable provenance, participate in engineering volume validation and Assembly-IR, and consume explicit manufacturing policies.

## Remaining v0.2 milestones

1. Run the same provider-neutral import against an actual Meshy-generated asset when a Meshy artifact is available to the execution environment.
2. Add exact mesh/BREP collision behind the existing PASS/FAIL/UNKNOWN contract.
3. Link fit-policy resolution directly into interface creation without hiding profile provenance.
4. Add real engineering overlay visual acceptance in the deployed ChatGPT App.
5. Produce a final 3MF/STEP manufacturing handoff only after topology/repair gates pass.
