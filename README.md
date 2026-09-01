# CAD3MF

Agent-native parametric CAD and 3D-printing runtime.

## Product promise

Natural language should become a **revisioned engineering asset**, not a one-shot mesh:

```text
Design Intent
    -> CAD-IR
    -> Geometry Compiler
    -> CadQuery / OpenCascade
    -> Validation
    -> STEP + STL + 3MF + Preview
```

A later edit such as `magnet_diameter: 6.2 -> 8.0` changes a parameter and rebuilds the model as a new revision instead of regenerating arbitrary CAD code.

## M0 scope

M0 intentionally proves only the geometry pipeline:

- versioned CAD-IR
- safe parameter references (`$name`; no `eval`, no arbitrary Python execution)
- deterministic CadQuery compilation
- basic solid validation
- STEP / STL / 3MF export
- GLB preview when available, TJS fallback
- immutable revision example
- one golden model: Parametric Magnet Module

Not in M0: FreeCAD, Bambu slicing, image-to-CAD, assemblies, cloud persistence, or the ChatGPT widget.

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
  chatgpt-plugin/        # Apps SDK UI (post-M0)
services/
  mcp-server/            # seven high-level MCP tools (post-M0 shell)
  cad-worker/            # build / validate / export runtime
packages/
  cad-ir/                # canonical CAD intermediate representation
  cad-compiler/          # backend-neutral compiler contracts
  manufacturing/         # printability rules (post-M0)
  shared/
adapters/
  cadquery/              # M0 primary backend
tests/
  golden-models/
```

## Development

Requires Python 3.11+.

```bash
python -m pip install -r requirements-dev.txt
export PYTHONPATH="$PWD/packages/cad-ir/src:$PWD/packages/cad-compiler/src:$PWD/services/cad-worker/src:$PWD/adapters/cadquery/src"
pytest -q
python -m cad3mf_worker.cli build tests/golden-models/magnet_module.v1.json --out dist/magnet-v1
```

Expected build artifacts:

```text
model.step
model.stl
model.3mf
preview.glb   # or preview.tjs fallback
validation.json
build.json
```

## M0 acceptance

M0 passes only when CI demonstrates:

1. CAD-IR validates without executing user code.
2. Revision 1 compiles into one valid solid.
3. Revision 2 is produced by a parameter change (`6.2 -> 8.0`) and rebuilds.
4. Bounding box and volume are inspected.
5. STEP, STL, and 3MF are non-empty artifacts.
6. A web-viewable preview artifact is produced.
7. The full golden test is deterministic and green.

## Security invariant

The CAD worker **must never execute arbitrary Python supplied by the model or user**. CAD-IR values are schema-validated and parameter references are resolved by a deliberately tiny resolver.
