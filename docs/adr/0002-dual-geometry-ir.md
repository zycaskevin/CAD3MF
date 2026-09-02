# ADR 0002 — Separate Parametric CAD and Visual Mesh Canonical Paths

Status: Accepted for M1 implementation  
Date: 2026-09-02

## Context

CAD3MF M0 models revisioned engineering geometry through CAD-IR and a deterministic CadQuery/OpenCascade compiler. M1 adds visual products such as figurines, characters, sculpted shells, and decorative assets.

Forcing organic/generated geometry into parametric feature history would either lose useful detail or introduce arbitrary executable geometry logic into the trusted CAD compiler boundary.

Conversely, treating every engineering part as an opaque mesh would discard the deterministic parameter/revision model that M0 already proves.

## Decision

CAD3MF will maintain two canonical geometry paths:

- CAD-IR for parametric/engineering geometry.
- Asset-IR for mesh/sculpt asset semantics, immutable geometry-artifact references, semantic regions, constraints, and provenance.

A third contract, Assembly-IR, composes immutable CAD and Asset revisions into products. Manufacturing-IR then maps the accepted product to a printer/material/process plan.

Generated mesh bytes are derived artifacts. They are never allowed to inject code into CAD-IR or the CAD worker.

## Consequences

### Positive

- preserves deterministic M0 behavior;
- allows provider-neutral image-to-3D adoption;
- keeps organic geometry out of the trusted parametric compiler;
- supports hybrid products such as chassis + sculpted shell + figurine;
- creates an explicit productization/validation boundary before slicing.

### Costs

- separate mesh worker and mesh-validation stack are required;
- revisions must track both semantic IR and immutable binary artifacts;
- assembly and manufacturing contracts become first-class concepts.

## Rejected alternatives

### Convert every mesh into CAD-IR

Rejected because feature-history reconstruction from arbitrary organic meshes is lossy, unstable, and incompatible with the M0 closed execution contract.

### Make GLB/OBJ/3MF the canonical editable asset

Rejected because binary mesh files do not capture user intent, assumptions, semantic regions, revision provenance, interfaces, or manufacturing decisions.

### Let each image-to-3D provider define its own contract

Rejected because provider switching would change product truth and leak vendor-specific semantics into CAD3MF.