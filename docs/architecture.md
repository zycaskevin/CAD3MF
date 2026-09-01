# CAD3MF architecture

## M0 execution path

```text
CAD-IR JSON
   |
   v
Pydantic schema validation
   |
   v
Safe parameter resolver
   |
   v
CadQuery adapter
   |
   v
OpenCascade solid
   |--------------------|
   v                    v
Geometry validation   Export
                        |-- STEP
                        |-- STL
                        |-- 3MF
                        `-- GLB/TJS preview
```

## Ownership boundaries

### `packages/cad-ir`

Canonical, backend-neutral design contract. It must not import CadQuery, OpenCascade, FreeCAD, slicers, or UI code.

### `packages/cad-compiler`

Backend-neutral compiler helpers and safe resolution rules. CAD-IR 0.1 permits numeric literals and exact `$parameter` references only.

### `adapters/cadquery`

Translates supported CAD-IR features into CadQuery operations. Backend-specific geometry code stays here.

### `services/cad-worker`

Owns orchestration of compile -> validate -> export and revision helpers. It does not accept arbitrary Python source.

### `services/mcp-server`

Post-M0 Agent-facing API. Its public surface remains seven high-level tools:

- `create_design`
- `modify_design`
- `inspect_design`
- `render_design`
- `validate_design`
- `export_design`
- `prepare_print`

`prepare_print` is reserved until the Bambu/slicer milestone.

### `apps/chatgpt-plugin`

Post-M0 Apps SDK + React/Three.js viewer. It consumes project/revision/validation/artifact contracts; it does not own geometry generation.

## M0 deliberate limitations

- one exported body per design
- millimeters only
- FDM manufacturing metadata only
- no assembly constraints
- no arbitrary formulas
- no FreeCAD/OpenSCAD backends
- no printability heuristics beyond geometry validity
- no slicing or printer profiles

These are product boundaries, not hidden implementation gaps. Each expands in later milestones behind stable contracts.
