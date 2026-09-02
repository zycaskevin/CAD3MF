# CAD3MF M1 — Visual-to-Printable 3D Pipeline

Status: Proposed Canonical Contract  
Milestone: M1  
Date: 2026-09-02

## 1. Purpose

M1 extends CAD3MF from agent-native parametric CAD into a manufacturing compiler that can accept text, images, concepts, or structured design intent and produce validated printable products.

The product promise becomes:

> Natural language / image / concept -> canonical design state -> manufacturable geometry -> validated printable artifact.

M1 preserves every M0 safety and revision invariant. It does not replace CAD-IR 0.1 or the deterministic parametric path.

## 2. Non-negotiable architecture

CAD3MF owns two geometry paths:

1. **Parametric / Engineering Path** — CAD-IR -> compiler -> CadQuery/OpenCascade.
2. **Visual / Sculpt / Mesh Path** — Design Intent -> Visual Concept -> Turnaround Set -> provider adapter -> Asset-IR + referenced mesh artifact.

The visual front-end is generic. Figurines, characters, vehicles, tanks, and decorative product shells do not get separate visual runtimes. Geometry specialization happens behind later provider/productization boundaries.

Both geometry paths converge only through productization, Assembly-IR, manufacturing planning, validation, and slicer adapters.

```text
Text / Image / Concept
        |
        v
   Design Intent
        |
        v
  Visual Concept
        |
   confirmation gate
        |
        v
    Design Lock
        |
        v
  Turnaround Set
        |
        +-----------------------+
        |                       |
        v                       v
     CAD-IR                  Asset-IR
  engineering                mesh/sculpt
        |                       |
        +-----------+-----------+
                    |
                    v
               Assembly-IR
                    |
                    v
             Manufacturing-IR
                    |
                    v
         Geometry + Print Validation
                    |
                    v
              Slicer Adapter
                    |
                    v
             Bambu Project 3MF
```

## 3. Canonical authority

- Source images are evidence, not geometry truth.
- Design Intent owns observations, dimensions, assumptions, questions, and confirmed user intent.
- Visual Concept owns the reviewable visual proposal and its immutable image artifacts; it is not 3D geometry truth.
- Turnaround Set owns accepted view coverage and cross-view consistency evidence; it is not 3D geometry truth.
- Provider-specific mesh output is a derived artifact referenced by Asset-IR, not a provider-owned canonical record.
- CAD-IR remains authoritative for parametric parts.
- Asset-IR is authoritative for generic mesh-oriented asset semantics and provenance. Asset-IR is not figurine-specific.
- Assembly-IR is authoritative for product composition and interfaces.
- Manufacturing-IR is authoritative for manufacturing intent and printable material mapping.
- Slicer output is derived and must be reproducible from an accepted manufacturing revision plus pinned profiles.

## 4. Confirmation gates

A visual request must not silently cross from inference into manufacturing truth.

The pipeline must surface states such as:

- `needs_input`
- `needs_confirmation`
- `confirmed`
- `design_locked`
- `needs_review`

Missing dimensions, low-confidence hidden geometry, or unresolved functional choices are blocking when they materially affect manufacturability.

M1-002 requires explicit design lock before turnaround generation. Required concept decisions must be answered or explicitly waived. Confirmation creates immutable successor revisions rather than mutating earlier Design Intent or Visual Concept documents in place.

## 5. M1 canonical contracts

M1-001 introduces:

- `design-intent/0.1.0`
- `asset-ir/0.1.0`
- `assembly-ir/0.1.0`
- `manufacturing-ir/0.1.0`
- `job-manifest/0.1.0`
- `error/0.1.0`

M1-002 adds:

- `visual-concept/0.1.0`
- `turnaround-set/0.1.0`

All contracts use closed top-level objects. Unknown fields are rejected until introduced by a newer schema version.

Visual artifacts are digest-bound PNG/JPEG/WebP resources. Provider SDK objects, temporary provider URLs, arbitrary filesystem paths, and executable document formats are not canonical state.

## 6. Generic Visual Product Pipeline

M1-002 is deliberately product-neutral:

```text
Reference images + design prompt
        |
        v
Design Intent
        |
        v
Visual Concept
        |
 user answers decisions
        |
        v
Design Lock
        |
        v
Turnaround Set
        |
        v
M1-003 Geometry Provider Boundary
```

The architecture must prove two reference extremes with the same runtime and contracts:

- **REF-VIS-001 — Figurine:** human/character reference -> stylized collectible visual concept -> six-view turnaround.
- **REF-VIS-002 — Modular Tank:** vehicle/tank reference -> hard-surface modular concept -> minimum-four or six-view turnaround.

Product-specific prompts and review criteria are allowed. Separate figurine/tank stores, job models, canonical schemas, or MCP runtimes are not.

## 7. Visual Provider Boundary

Vision and image generation are replaceable capabilities, not canonical authorities.

```text
VisualProvider
  analyze(...)
  generateConcept(...)
  generateTurnaround(...)
```

Provider output is untrusted until normalized, hashed, persisted, and referenced by canonical documents.

M1-002 includes a `deterministic-test` provider only to verify orchestration and CI. It produces fixed fixture imagery and must never be represented as production-quality image analysis or generation.

A production OpenAI or other provider adapter may later implement the same interface without changing canonical contracts unless the semantics themselves change.

## 8. Turnaround Policy

M1-002 supports:

- `minimum_four_view`: front, back, one side, one three-quarter view.
- `full_six_view`: front, left, right, back, three-quarter front, three-quarter back.

Runtime validation rejects duplicate camera roles and incomplete semantic coverage. Cross-view consistency is recorded separately from image-generation provenance.

A generated Turnaround Set starts in `needs_review`; M1-002 does not automatically convert it into geometry truth.

## 9. Productization boundary

A visually attractive mesh is not a printable product. Productization may perform or request:

- watertight/manifold repair
- self-intersection handling
- minimum-thickness correction
- minimum-feature enlargement
- base/contact stabilization
- part segmentation
- connector insertion
- color-region segmentation
- build-volume and orientation analysis

A provider adapter cannot declare a model printable by itself.

## 10. Hybrid products

M1 explicitly supports mixed products. Example:

- tank chassis: CAD-IR
- replaceable turret shell: CAD-IR or Asset-IR
- character figurine: Asset-IR
- magnetic mount: CAD-IR
- display base: CAD-IR

Assembly-IR references immutable revisions/artifacts and describes the product-level interfaces between them.

This allows a visually generated tank exterior to later acquire parametric shafts, magnet pockets, snap fits, standardized sockets, and manufacturing tolerances without forcing the exterior styling itself into a parametric feature tree.

## 11. Color semantics

Visual RGB/texture and printable filament color are distinct domains.

M1 prefers **color-region segmentation** for FDM: skin, hair, clothing, logo, base, armor panels, vehicle accents, and similar semantic regions map to printable regions or parts, then Manufacturing-IR assigns those regions to registered filament slots.

Texture-to-filament decomposition may be added behind the same manufacturing contract later.

## 12. Worker boundaries

### MCP server
Owns schemas/resources, authorization, jobs, revisions, confirmation gates, and orchestration. It must not execute heavy mesh or slicer workloads inline.

### Visual provider adapter
Owns provider-specific vision/image requests and response normalization. It does not own canonical Design Intent, Visual Concept, or Turnaround Set state.

### CAD worker
Owns CAD-IR compilation, parametric validation, and engineering artifacts.

### Mesh worker
Owns mesh-provider invocation, normalization, repair, segmentation, and mesh validation.

### Slicer worker
Owns isolated slicer execution against a closed, pinned printer/material/process profile registry.

## 13. Security invariants

M0 invariants remain mandatory. M1 additionally requires:

- no executable code, shell fragments, filesystem paths, or expressions from image/model output
- provider output treated as untrusted data
- closed schemas at every canonical boundary
- digest-bound input/output artifacts
- visual artifact URLs resolved through persisted artifact identity, never URL-to-filesystem concatenation
- visual HTTP delivery recomputes/validates stored artifact digest before serving
- isolated slicer subprocess execution
- no arbitrary startup/end G-code generation
- external publishing separated from build/slice and requiring an explicit action boundary

## 14. M1 work packages

- **M1-001** — Canonical Contracts & Job Skeleton
- **M1-002** — Generic Visual Concept & Turnaround Pipeline
- **M1-003** — Provider-neutral Mesh Generation Adapter Layer
- **M1-004** — Printable Mesh Engine
- **M1-005** — Hybrid Assembly Support
- **M1-006** — Color-to-Filament Pipeline
- **M1-007** — Bambu E2E Pipeline
- **M1-008** — Physical Validation

## 15. M1-001 acceptance criteria

M1-001 is complete when:

1. all six canonical schemas exist and reject unknown top-level fields;
2. representative valid and invalid fixtures are tested;
3. schema versions and IDs are stable;
4. M0 CAD-IR 0.1 remains accepted unchanged;
5. the job/error contracts can represent blocked, failed, retried, and successful pipeline stages;
6. no provider-, slicer-, or UI-specific type becomes canonical authority.

M1-001 does **not** claim that image-to-3D, mesh repair, Bambu slicing, or physical print validation is implemented.

## 16. M1-002 acceptance criteria

M1-002 is complete at the infrastructure/orchestration layer when:

1. Visual Concept and Turnaround Set schemas are versioned, closed, and tested;
2. REF-VIS-001 figurine and REF-VIS-002 modular-tank cases run through the same VisualRuntime;
3. concept images and turnaround views are immutable SHA-256-bound artifacts;
4. required visual decisions block design lock until answered or explicitly waived;
5. turnaround generation rejects any concept that is not design-locked;
6. minimum-four and full-six turnaround coverage are validated, including duplicate-view rejection;
7. visual documents and jobs survive MCP/runtime restart through persistent storage;
8. public visual artifact delivery exposes controlled URLs, not filesystem paths, and validates artifact digest before serving;
9. all M0 and M1-001 regression tests remain green;
10. the deterministic CI provider remains explicitly non-production.

Passing M1-002 does **not** mean that production photo understanding, photoreal identity preservation, high-quality concept generation, image-to-3D geometry, or physical printing has been validated. Those require production provider adapters and later M1 work packages.
