# CAD3MF architecture

## M0 end-to-end path

```text
Natural-language user intent
          |
          v
ChatGPT / Agent host
  (intent -> CAD-IR)
          |
          v
MCP tools + CAD-IR schema
          |
          v
Project / Revision Runtime
       SQLite
          |
          v
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
   |-----------------------|
   v                       v
Geometry validation      Export
                           |-- STEP
                           |-- STL
                           |-- 3MF
                           `-- GLB/TJS preview
          |
          v
Controlled artifact HTTP gateway
          |
          v
MCP App React + Three.js viewer
```

Natural-language interpretation belongs to the host model. CAD3MF does not add a second ad-hoc NLP parser. The host uses the canonical CAD-IR schema; CAD3MF validates and deterministically executes the resulting design contract.

## Ownership boundaries

### `packages/cad-ir`

Canonical, backend-neutral design contract. It must not import CadQuery, OpenCascade, FreeCAD, slicers, MCP, or UI code.

### `packages/cad-compiler`

Backend-neutral compiler helpers and safe resolution rules. CAD-IR 0.1 permits numeric literals and exact `$parameter` references only.

### `packages/manufacturing`

Owns backend-neutral manufacturing evidence and later printability policy. M0-E includes only the physical print receipt schema: immutable 3MF hash binding, printer/material metadata, dimensional measurements, tolerances, fit result, and derived PASS/FAIL. A manufacturing receipt is evidence and never becomes CAD design authority.

### `adapters/cadquery`

Translates supported CAD-IR features into CadQuery operations. Backend-specific geometry code stays here.

### `services/cad-worker`

Owns compile → validate → export and revision helpers. It does not accept arbitrary Python source.

### `services/mcp-server`

Owns the Agent/project runtime boundary:

- MCP v2 stdio development transport
- Streamable HTTP `/mcp` transport for App deployment
- six high-level M0 tools
- CAD-IR schema resource
- ChatGPT viewer resource
- SQLite project/revision persistence
- controlled artifact HTTP gateway

M0 tools:

- `create_design`
- `modify_design`
- `inspect_design`
- `render_design`
- `validate_design`
- `export_design`

`prepare_print` is reserved until the Bambu/slicer milestone and is not exposed as a placeholder tool.

The service may know local artifact paths internally, but the HTTP/App public contract returns controlled artifact URLs instead of filesystem paths.

### `apps/chatgpt-plugin`

Owns the MCP App presentation layer:

- React 19
- Three.js GLB viewer
- MCP Apps host bridge
- parameter editing controls
- validation/revision display
- STEP/STL/3MF export actions

The widget never owns geometry generation. It keeps only draft UI input; any accepted parameter change must go through `modify_design`, create a server revision, and return a new authoritative snapshot.

## Revision authority

The canonical editable asset is CAD-IR plus persisted revision state, not the GLB/STL mesh.

```text
r1 CAD-IR
  -> compile
  -> artifacts

set_parameter
  -> r2 CAD-IR (parent r1)
  -> compile
  -> new artifacts
```

Preview and export files are derived assets. They can be regenerated from the authoritative revision.

## HTTP security boundary

The HTTP service enforces:

- allowed Host / Origin controls around the MCP endpoint
- path-safe project identifiers
- artifact lookup through persisted revision metadata
- no URL-segment-to-filesystem concatenation
- no raw server path in public App tool results
- immutable revision-scoped artifact URLs

The CAD execution boundary separately rejects arbitrary Python and arbitrary CAD expressions.

## M0 deliberate limitations

- one exported body per design
- millimeters only
- FDM manufacturing metadata only
- `modify_design` supports `set_parameter` only
- no assembly constraints
- no arbitrary formulas
- no FreeCAD/OpenSCAD backends
- no image-to-CAD
- no printability heuristics beyond current geometry validation
- no slicing or printer profiles
- no Bambu project generation

These are explicit product boundaries. Each later capability should expand behind the existing CAD-IR / revision / MCP contracts rather than bypass them.

## M0 completion boundary

The deterministic backend/runtime, ChatGPT App contract, public HTTPS deployment, and live ChatGPT tool/viewer path are proven. On 2026-09-05, ChatGPT directly inspected, rendered, validated, and exported `m0d-magnet-module-live` revision `r3` through the deployed CAD3MF MCP service. The returned public 3MF matched the persisted server artifact byte-for-byte by SHA-256.

The remaining v0.1 boundary is physical manufacturing acceptance: print a canonical revision on the target Bambu H2C / PETG workflow, measure the critical dimensions and fit, and record the result as a manufacturing receipt. This physical result is evidence about manufacturability; it does not replace CAD-IR as the design authority.
