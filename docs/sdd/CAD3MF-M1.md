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
2. **Visual / Sculpt / Mesh Path** — Design Intent -> provider adapter -> Asset-IR + referenced mesh artifact.

Both paths converge only through productization, Assembly-IR, manufacturing planning, validation, and slicer adapters.

```text
Text / Image / Concept
        |
        v
   Design Intent
        |
   confirmation gate
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
- Generated concept images are review artifacts, not geometry truth.
- Provider-specific mesh output is a derived artifact referenced by Asset-IR, not a provider-owned canonical record.
- CAD-IR remains authoritative for parametric parts.
- Asset-IR is authoritative for mesh-oriented asset semantics and provenance.
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

Missing dimensions, low-confidence hidden geometry, or unresolved functional choices are blocking when they materially affect manufacturability.

## 5. M1 canonical contracts

M1-001 introduces versioned JSON Schema contracts for:

- `design-intent/0.1.0`
- `asset-ir/0.1.0`
- `assembly-ir/0.1.0`
- `manufacturing-ir/0.1.0`
- `job-manifest/0.1.0`
- `error/0.1.0`

All contracts use closed top-level objects. Unknown fields are rejected until introduced by a newer schema version.

## 6. Productization boundary

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

## 7. Hybrid products

M1 explicitly supports mixed products. Example:

- tank chassis: CAD-IR
- replaceable turret shell: CAD-IR or Asset-IR
- character figurine: Asset-IR
- magnetic mount: CAD-IR
- display base: CAD-IR

Assembly-IR references immutable revisions/artifacts and describes the product-level interfaces between them.

## 8. Color semantics

Visual RGB/texture and printable filament color are distinct domains.

M1 prefers **color-region segmentation** for FDM: skin, hair, clothing, logo, base, and similar semantic regions map to printable regions or parts, then Manufacturing-IR assigns those regions to registered filament slots.

Texture-to-filament decomposition may be added behind the same manufacturing contract later.

## 9. Worker boundaries

### MCP server
Owns schemas/resources, authorization, jobs, revisions, and orchestration. It must not execute heavy mesh or slicer workloads inline.

### CAD worker
Owns CAD-IR compilation, parametric validation, and engineering artifacts.

### Mesh worker
Owns mesh-provider invocation, normalization, repair, segmentation, and mesh validation.

### Slicer worker
Owns isolated slicer execution against a closed, pinned printer/material/process profile registry.

## 10. Security invariants

M0 invariants remain mandatory. M1 additionally requires:

- no executable code, shell fragments, filesystem paths, or expressions from image/model output
- provider output treated as untrusted data
- closed schemas at every canonical boundary
- digest-bound input/output artifacts
- isolated slicer subprocess execution
- no arbitrary startup/end G-code generation
- external publishing separated from build/slice and requiring an explicit action boundary

## 11. M1 work packages

- **M1-001** — Canonical Contracts & Job Skeleton
- **M1-002** — Concept & Turnaround Pipeline
- **M1-003** — Provider-neutral Mesh Generation Adapter Layer
- **M1-004** — Printable Mesh Engine
- **M1-005** — Hybrid Assembly Support
- **M1-006** — Color-to-Filament Pipeline
- **M1-007** — Bambu E2E Pipeline
- **M1-008** — Physical Validation

## 12. M1-001 acceptance criteria

M1-001 is complete when:

1. all six canonical schemas exist and reject unknown top-level fields;
2. representative valid and invalid fixtures are tested;
3. schema versions and IDs are stable;
4. M0 CAD-IR 0.1 remains accepted unchanged;
5. the job/error contracts can represent blocked, failed, retried, and successful pipeline stages;
6. no provider-, slicer-, or UI-specific type becomes canonical authority.

M1-001 does **not** claim that image-to-3D, mesh repair, Bambu slicing, or physical print validation is implemented.