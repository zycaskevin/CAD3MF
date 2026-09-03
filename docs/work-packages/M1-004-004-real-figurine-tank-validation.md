# M1-004-004 — Real Figurine + Tank Repair & Manufacturing Validation

Status: In Development  
Milestone: CAD3MF M1  
Date: 2026-09-04  
Base: M1-004-003 COMPLETE / manufacturing geometry analysis

## Goal

Run the two real M1-003P Stable Fast 3D artifacts through the complete M1-004 geometry pipeline on NVIDIA GB10 and produce auditable repaired/validated outputs.

Golden real inputs:

1. `REF-VIS-001-FIGURINE-GB10`
   - source: `/home/zycas/cad3mf-sf3d/benchmarks/figurine/figurine-120mm.glb`
   - source SHA256: `4295be7ce155b6192eb86c53f55349b5a733227753fba429f7848f7115257644`
   - target longest extent: `120 mm`
   - source topology observation: `watertight=false`

2. `REF-VIS-002-TANK-GB10`
   - source: `/home/zycas/cad3mf-sf3d/benchmarks/tank/tank-160mm.glb`
   - source SHA256: `26489a7c9b05b74feda910f3b27d5f63922fd5e9ed7d9858393aa992b36c843b`
   - target longest extent: `160 mm`
   - source topology observation: `watertight=false`

## Canonical execution pipeline

```text
Real SF3D GLB
    |
    v
M1-004-001 Safe Repair
    |
    +-- topology valid ----------------------+
    |                                        |
    +-- needs_robust_repair                  |
             |                               |
             v                               |
    M1-004-002 Robust Reconstruction         |
             |                               |
             v                               |
    Topology + Fidelity Gate                 |
             +-------------------------------+
             |
             v
M1-004-003 Manufacturing Geometry Analysis
    - self-intersection
    - minimum thickness
    - minimum negative feature / clearance
             |
             v
Final Geometry Evidence
             |
             v
Visual inspection
             |
             v
Manufacturing-IR handoff candidate
```

## Runtime boundary

The known-working Stable Fast 3D environment must remain untouched:

`~/cad3mf-sf3d/.venv`

M1-004-004 uses a separate runtime, recommended path:

`~/cad3mf-manufacturing/.venv`

Required runtime components:

- Python 3.11
- NumPy 1.26.4
- trimesh 4.4.1
- python-fcl 0.7.0.11
- point-cloud-utils 0.34.0
- SciPy as required by point-cloud-utils

Deployment rule:

- `python-fcl` may use the reviewed Linux aarch64 CPython 3.11 wheel if available on GB10.
- `point-cloud-utils` must not be assumed to have a Linux aarch64 wheel. If no compatible wheel is available, source-build it inside the isolated M1-004 runtime.
- Do not install these dependencies into the SF3D venv.

## Repair policy

### Stage A — Safe repair

Run M1-004-001 first. Record:

- input topology metrics;
- operations applied;
- output topology metrics;
- metric-scale drift;
- `appearance_rebake_required`.

If safe repair returns topology-valid geometry, robust repair must not run.

### Stage B — Robust repair

If safe repair returns `needs_robust_repair`, invoke the M1-004-002 `point-cloud-utils make_mesh_watertight()` adapter.

Robust output acceptance requires:

- watertight true;
- zero boundary edges;
- zero non-manifold edges;
- consistent winding;
- fidelity gate within explicit tolerances.

Robust reconstruction always marks appearance/UV correspondence non-authoritative and requires later appearance rebake.

## Fidelity policy for first real validation

This work package must record, not hide, reconstruction distortion.

Initial acceptance policy:

- longest-extent target remains authoritative: 120 mm Figurine / 160 mm Tank;
- max bounding-box extent drift after final scale normalization: `<= 0.25 mm`;
- max centroid drift: `<= 2.0 mm`;
- sampled-vertex Chamfer and Hausdorff observations must be recorded;
- no hard Chamfer/Hausdorff production threshold is frozen until both real artifacts are observed.

If topology succeeds but visual/product identity is clearly destroyed, the result is rejected regardless of topology PASS.

## Manufacturing geometry policy

M1-004-003 thresholds used for this first real-artifact validation are explicit test policies, not universal Bambu defaults.

Initial validation thresholds:

### Figurine

- minimum thickness: `1.2 mm`
- minimum negative feature clearance: `0.8 mm`

### Tank

- minimum thickness: `1.2 mm`
- minimum negative feature clearance: `0.8 mm`

These thresholds are conservative geometry gates for the first physical-product path. Printer/profile-specific policy remains downstream.

## Evidence required per artifact

Each artifact must record:

- source GLB path;
- source SHA256;
- source vertices / triangles / bbox;
- safe repair status + operations;
- robust repair status if invoked;
- repaired GLB path + SHA256;
- repaired vertices / triangles / bbox;
- watertight / boundary / non-manifold / winding status;
- fidelity observations;
- self-intersection result + backend provenance;
- minimum thickness observation + threshold;
- minimum feature observation + threshold;
- exact package/runtime versions;
- wall-clock duration;
- final decision;
- visual inspection note or screenshot evidence.

## Canonical final decisions

Per artifact:

- `manufacturing_geometry_valid`
- `repair_failed`
- `rejected_fidelity`
- `self_intersection_failed`
- `minimum_thickness_failed`
- `minimum_feature_failed`
- `analysis_unknown`
- `runtime_unavailable`

No decision in M1-004-004 implies successful slicing or successful physical print.

## Acceptance criteria

M1-004-004 is COMPLETE only when:

- an isolated GB10 manufacturing runtime is validated;
- real `python-fcl` self-intersection analysis works on GB10;
- real `point-cloud-utils` ray/reconstruction path works on GB10;
- Figurine source hash matches the M1-003P evidence;
- Tank source hash matches the M1-003P evidence;
- both artifacts run through Safe Repair;
- robust repair runs only when required;
- every accepted repaired output passes authoritative topology checks;
- self-intersection, thickness and minimum-feature evidence is recorded for both artifacts;
- repaired output hashes and dimensions are recorded;
- real visual inspection is completed;
- no artifact is called printable merely because it became watertight;
- repository evidence and regressions are green.

## Non-goals

M1-004-004 does not yet:

- choose Bambu nozzle/profile parameters;
- generate supports;
- choose print orientation;
- slice G-code;
- certify a physical print;
- perform texture/material rebaking.

Those belong to later Manufacturing/Bambu pipeline stages.

## Next stage

After both real artifacts have accepted geometry evidence, proceed to Manufacturing-IR integration and the Bambu preparation path.
