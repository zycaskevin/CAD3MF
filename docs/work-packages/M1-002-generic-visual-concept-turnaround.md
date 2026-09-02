# M1-002 — Generic Visual Concept & Turnaround Pipeline

Status: In Development  
Milestone: CAD3MF M1  
Date: 2026-09-02

## Goal

Create one provider-neutral visual workflow that works for both organic products (figurines/characters) and hard-surface products (vehicles/tanks/product shells).

The work package must prove that CAD3MF does not fork its architecture by product category.

```text
Reference images + prompt
        |
        v
Design Intent
        |
        v
Visual Concept
        |
   user confirmation
        |
        v
Design Lock
        |
        v
Turnaround Set
        |
        v
M1-003 geometry provider boundary
```

## Canonical boundary

- Source images remain evidence.
- Design Intent records observations, assumptions, dimensions, and unanswered questions.
- Visual Concept records the approved visual proposal and its derived image artifacts.
- Turnaround Set records view coverage and cross-view consistency.
- None of these documents are 3D geometry truth.
- Mesh generation remains M1-003.

## Generic requirement

The same contracts and orchestration must support at least:

1. `REF-VIS-001` — human reference -> stylized figurine concept.
2. `REF-VIS-002` — vehicle/tank reference -> modular hard-surface concept.

Product-specific logic may alter prompts or review criteria, but must not create separate figurine/tank runtimes.

## New contracts

- `visual-concept/0.1.0`
- `turnaround-set/0.1.0`

Both contracts are closed JSON Schema documents with digest-bound image artifacts and provider provenance.

## ChatGPT image input

`analyze_visual_input` supports the ChatGPT Plugin file-parameter contract through top-level `source_files` and `_meta["openai/fileParams"]`.

The model/widget supplies file references containing the documented `download_url` and `file_id` fields. CAD3MF, not the model, performs ingestion:

```text
ChatGPT file reference
    -> HTTPS download boundary
    -> SSRF / private-network rejection
    -> bounded download
    -> PNG/JPEG/WebP magic-byte validation
    -> SHA-256
    -> immutable source artifact
    -> Design Intent evidence reference
```

`download_url` is transient transport metadata and is never canonical state. Source image bytes and server filesystem paths are also excluded from canonical JSON documents; providers receive bytes only through the internal adapter context.

The advanced `source_assets` input remains available for reuse of already-ingested CAD3MF artifacts and deterministic tests.

## MCP workflow

M1-002 exposes:

- `analyze_visual_input`
- `generate_concept`
- `confirm_design`
- `generate_turnaround`
- `get_visual_job`

The first implementation includes a deterministic provider for CI. It proves orchestration, persistence, revisions, artifact delivery, and security boundaries without claiming generative image quality.

A production image/vision provider must implement the same adapter interface and may be enabled later without changing canonical contracts.

## Confirmation gate

`generate_turnaround` is forbidden until the visual concept has been explicitly design-locked.

Confirmation creates immutable successor revisions rather than mutating the prior concept or Design Intent in place.

Required unresolved decisions block design lock.

## Turnaround policy

Two policies are allowed:

- `minimum_four_view`: front, left or right, back, plus a three-quarter view.
- `full_six_view`: front, left, right, back, three-quarter front, three-quarter back.

Runtime validation additionally rejects duplicate camera roles even though JSON Schema cannot express array-wide uniqueness by object property.

## Artifact policy

- Source and derived visual artifacts are immutable and SHA-256 bound once ingested.
- Provider calls after a runtime restart reload and re-hash persisted image bytes instead of depending on expired external download URLs.
- Derived concept images are available as normalized inputs to a future turnaround provider.
- Public image delivery resolves artifact IDs through the visual store; URL paths never become filesystem paths.
- Public visual delivery recomputes the stored SHA-256 before sending bytes.
- Provider output is untrusted data.
- Production adapters must normalize to PNG/JPEG/WebP before canonical registration.

## Network security

M1-002 file ingestion treats file download URLs as untrusted transport input even when ChatGPT normally supplies them.

The application boundary requires:

- HTTPS only;
- no URL credentials;
- bounded redirect count with every redirect revalidated;
- rejection of loopback, private, link-local, multicast, and other non-public IP ranges;
- bounded payload size;
- content-type determination from image magic bytes, not filename or header alone.

Production deployment should additionally enforce outbound network/egress policy because application-level DNS checks cannot by themselves provide a complete defense against every DNS-rebinding scenario.

## Explicit non-goals

M1-002 does not implement:

- image-to-3D mesh generation
- mesh repair
- hard-surface CAD reconstruction
- face identity guarantees
- Bambu slicing
- physical validation

The deterministic provider also does not constitute production visual understanding, concept generation, or turnaround quality.

## Acceptance criteria

M1-002 is complete at the infrastructure/orchestration layer when:

1. both new JSON Schemas validate and reject unknown fields;
2. one workflow handles figurine and modular-tank golden cases;
3. concept generation produces immutable digest-bound image artifacts;
4. required decisions block design lock until answered or explicitly waived;
5. turnaround generation requires a locked concept;
6. turnaround coverage and duplicate-view validation are enforced;
7. workflow state and ingested source bytes survive MCP runtime restart;
8. ChatGPT file parameter metadata/schema matches the documented file contract;
9. source-file ingestion rejects obvious SSRF/private-network targets and unsupported image formats;
10. HTTP artifact delivery does not expose raw filesystem paths and verifies digest before serving;
11. all M0 and M1-001 regression tests remain green;
12. CI deterministic provider is clearly identified as non-production and no claim of generative image quality is made.
