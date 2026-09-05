# CAD3MF

Agent-native parametric CAD and 3D-printing runtime.

## Product promise

Natural language becomes a **revisioned engineering asset**, not a one-shot mesh:

```text
User intent
    -> ChatGPT / Agent host
    -> CAD-IR
    -> CAD3MF MCP runtime
    -> Geometry Compiler
    -> CadQuery / OpenCascade
    -> Validation
    -> STEP + STL + 3MF + GLB preview
```

A later edit such as `magnet_diameter: 6.2 -> 8.0` changes a parameter and rebuilds the model as a new immutable revision instead of regenerating arbitrary CAD code.

## M0 status

### M0-A — Geometry Core: PASS

- versioned CAD-IR 0.1
- safe parameter references (`$name`; no `eval`, no arbitrary Python execution)
- deterministic CadQuery/OpenCascade compilation
- geometry validation
- STEP / STL / 3MF export
- GLB preview with TJS fallback
- golden Parametric Magnet Module r1/r2

### M0-B — MCP Project Runtime: PASS

- official MCP v2 modern protocol path
- six high-level tools:
  - `create_design`
  - `modify_design`
  - `inspect_design`
  - `render_design`
  - `validate_design`
  - `export_design`
- canonical CAD-IR schema resource: `caddesk://schema/cad-ir/0.1`
- SQLite project/revision persistence
- process-restart persistence
- MCP-boundary security regressions

`prepare_print` is intentionally absent until the slicing/Bambu milestone.

### M0-C — ChatGPT App Contract/Runtime: PASS

- Streamable HTTP MCP endpoint at `/mcp`
- controlled artifact gateway for GLB / STEP / STL / 3MF
- MCP App resource: `ui://caddesk/viewer/v1.html`
- `text/html;profile=mcp-app` single-file React + Three.js viewer
- parameter edits routed through `modify_design`; the browser never becomes a CAD engine
- validation/revision/parameter UI and export actions
- HTTP E2E with the official MCP client
- public HTTP tool outputs do not expose server filesystem paths

### M0-D — Live ChatGPT Deployment: PASS

- reachable HTTPS MCP origin at `https://cad3mf.nancyai.dev`
- CAD3MF tools callable directly from a normal ChatGPT conversation
- interactive viewer rendered in ChatGPT for `m0d-magnet-module-live` revision `r3`
- revisioned parameter edit proven through `r1 -> r2 -> r3`; `r3` uses a 4 mm magnet diameter
- geometry validation PASS for `r3` as one valid solid
- public 3MF artifact returned as `model/3mf` with sandbox-safe CORS
- remote `r3` 3MF SHA-256 matches the persisted server artifact exactly

### M0-E — Physical Acceptance Receipt Schema: PASS

- backend-neutral receipt model for real print evidence
- receipt binds project/revision to the exact exported 3MF SHA-256
- records printer, material, optional slicer profile, measured dimensions, tolerances, and fit result
- overall PASS is derived from measured evidence; the receipt never mutates CAD-IR

The remaining v0.1 release gate is **the physical print itself**: import the exported 3MF into the Bambu workflow, print it on the target printer/material profile, measure critical dimensions, and record the resulting receipt.

## Golden model

`tests/golden-models/magnet_module.v1.json`

- body: 60 x 40 x 8 mm
- 2 magnet pockets: diameter 6.2 mm, depth 3.2 mm
- right male dovetail
- left female dovetail with 0.25 mm clearance

`magnet_module.v2.json` changes only `magnet_diameter` to 8.0 mm and points to revision 1 as its parent.

## Repository layout

```text
apps/
  chatgpt-plugin/        # React + Three.js MCP App widget
services/
  mcp-server/            # stdio + Streamable HTTP MCP runtime
  cad-worker/            # compile / validate / export runtime
packages/
  cad-ir/                # canonical CAD intermediate representation
  cad-compiler/          # backend-neutral compiler contracts
  manufacturing/         # physical print receipts + later printability policy
  shared/
adapters/
  cadquery/              # M0 primary backend
tests/
  golden-models/
```

## Python / geometry development

Requires Python 3.11+. CAD3MF pins CadQuery 2.8.0 and CasADi 3.7.2 for reproducible development. Minimal headless Linux images may also need native `libGL` / `libX11` runtimes required by OpenCascade.

```bash
python -m pip install -r requirements-dev.txt
export PYTHONPATH="$PWD/packages/cad-ir/src:$PWD/packages/cad-compiler/src:$PWD/services/cad-worker/src:$PWD/adapters/cadquery/src"
pytest -q
python -m cad3mf_worker.cli build tests/golden-models/magnet_module.v1.json --out dist/magnet-v1
```

Expected geometry artifacts:

```text
model.step
model.stl
model.3mf
preview.glb   # or preview.tjs fallback
validation.json
build.json
```

## MCP runtime

```bash
cd services/mcp-server
npm install
CAD3MF_PYTHON=python npm run start:stdio
```

For HTTP/App development, build the widget first and start the HTTP server:

```bash
cd apps/chatgpt-plugin
npm install
npm run build

cd ../../services/mcp-server
npm install
CAD3MF_PYTHON=python \
CAD3MF_PUBLIC_BASE_URL=http://127.0.0.1:8787 \
npm run start:http
```

Endpoints:

- `/mcp` — MCP Streamable HTTP transport
- `/healthz` — health check
- `/artifacts/<project>/<revision>/<preview|step|stl|3mf>` — controlled immutable artifacts

A real ChatGPT connection requires exposing the MCP endpoint through a reachable HTTPS deployment.

## Security invariants

- The CAD worker **never executes arbitrary Python supplied by the model or user**.
- CAD-IR is schema-validated before compilation.
- CAD-IR 0.1 allows numeric literals and exact `$parameter` references, not arbitrary expressions.
- M0 `modify_design` supports only `set_parameter`.
- Project IDs are path-safe.
- Public HTTP output contains controlled artifact URLs rather than raw server paths.
- Artifact URL segments are resolved through persisted revision metadata rather than converted directly into filesystem paths.

## Deliberate limitations

M0 is single-body, millimeter-first, FDM-oriented parametric CAD. It does not yet include FreeCAD/OpenSCAD backends, assemblies, image-to-CAD, printability heuristics beyond current geometry checks, slicing, printer profiles, or Bambu project generation.
