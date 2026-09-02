# M1-003 — Provider-Neutral 3D Mesh Generation

Status: In Development  
Milestone: CAD3MF M1  
Date: 2026-09-02

## Goal

Convert an approved, consistency-checked Turnaround Set into a provider-generated 3D mesh artifact and bind that artifact into canonical Asset-IR without claiming the result is printable.

```text
Design-locked Visual Concept
        |
        v
Accepted / consistency-passed Turnaround Set
        |
        v
Mesh Generation Request
        |
        v
Mesh Provider Adapter
        |
        v
Mesh Artifact
        |
        v
Asset-IR
        |
        v
M1-004 Printable Mesh Engine
```

## Boundary

M1-003 owns:

- provider-neutral mesh generation requests;
- provider invocation;
- deterministic artifact normalization/registration;
- immutable SHA-256 binding;
- basic mesh artifact metadata;
- Asset-IR creation;
- persistence and job lifecycle.

M1-003 does **not** own:

- watertight repair;
- minimum wall-thickness correction;
- overhang/support planning;
- printability certification;
- part segmentation for manufacturing;
- Bambu slicing.

Those remain M1-004 and later.

## Canonical contracts

M1-003 introduces:

- `mesh-generation-request/0.1.0`
- `mesh-artifact/0.1.0`

and extends `asset-ir/0.1.0` to represent hard-surface outputs such as `vehicle_shell`, `hard_surface_shell`, and `product_shell`.

The Mesh Artifact contract deliberately has no `printable` or `print_quality` field. Topology fields are observations only.

## Provider contract

All real providers must implement one adapter boundary:

```text
MeshProvider.generate(
  request,
  turnaround metadata,
  normalized image bytes
)
  -> mesh bytes
  -> format/media type
  -> vertex/triangle counts
  -> bounding box
  -> topology observations
```

Provider-specific prompts, SDK response objects, credentials, temporary URLs, and model-private metadata never become canonical state.

## Supported artifact formats

Canonical M1-003 formats:

- GLB
- OBJ
- PLY

The deterministic CI provider intentionally emits a tiny PLY cube and is **not** a production 3D reconstruction model.

## Generic requirement

The same `generate_mesh` pipeline must support:

1. `REF-MESH-001` — figurine turnaround -> `asset_type=figurine`.
2. `REF-MESH-002` — modular tank / vehicle turnaround -> `asset_type=vehicle_shell`.

No separate figurine runtime or tank runtime is allowed.

## MCP tools

- `generate_mesh`
- `get_mesh_asset`
- `get_mesh_job`

Schemas are exposed as MCP resources:

- `caddesk://schema/mesh-generation-request/0.1.0`
- `caddesk://schema/mesh-artifact/0.1.0`
- `caddesk://schema/asset-ir/0.1.0`

## Validation gates

`generate_mesh` requires:

- at least four turnaround views;
- a turnaround state eligible for downstream generation;
- `consistency.pass=true`;
- immutable input images whose current SHA-256 matches stored metadata;
- non-empty provider output;
- format signature compatible with the declared output format;
- non-negative integer vertex/triangle counts.

A provider cannot bypass these gates.

## Production provider strategy

The initial implementation is deliberately adapter-first. Candidate production backends may include TRELLIS-family, Hunyuan3D-family, or future multi-view/image-to-3D systems, but none is canonical.

The selection of a production provider should be benchmarked separately for:

- organic identity/style retention;
- hard-surface silhouette and symmetry;
- multi-view consistency;
- topology quality;
- texture/material output;
- latency and GPU memory;
- licensing/deployment constraints.

## Acceptance criteria

M1-003 infrastructure/orchestration is complete when:

1. request and artifact JSON Schemas are closed and regression-tested;
2. Asset-IR accepts organic and hard-surface visual products;
3. provider adapter accepts persisted turnaround image bytes;
4. generated mesh bytes are digest-bound and persisted independently of visual artifacts;
5. Asset-IR references the immutable mesh artifact;
6. figurine and modular-tank cases use the same runtime;
7. failed turnaround consistency blocks mesh generation;
8. state survives runtime restart;
9. MCP tools/resources are visible through actual descriptors;
10. all M0, M1-001, and M1-002 regressions remain green;
11. the deterministic provider is clearly marked CI-only;
12. no code or contract claims the generated mesh is printable.
