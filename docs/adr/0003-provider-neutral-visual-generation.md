# ADR 0003 — Provider-Neutral Visual Generation Boundary

Status: Accepted for M1  
Date: 2026-09-02

## Decision

CAD3MF will not make any image-generation or vision vendor part of canonical product state.

M1-002 defines a `VisualProvider` adapter boundary. The provider may analyze references or generate concept/turnaround images, but its outputs are treated as untrusted derived artifacts until normalized, hashed, stored, and referenced by canonical documents.

The canonical sequence is:

```text
provider request
    -> provider response
    -> normalize artifact
    -> SHA-256
    -> Visual Concept / Turnaround Set
    -> review gate
```

Provider SDK objects, request IDs, temporary URLs, prompt internals, and vendor-specific safety/result types must not leak into Design Intent, Visual Concept, Turnaround Set, Asset-IR, Assembly-IR, or Manufacturing-IR.

## Why

Figurines, vehicles, tanks, and decorative shells share visual understanding, concept approval, and multi-view generation. Splitting them by product category would duplicate image upload, revision, provider, provenance, and review infrastructure.

The provider is therefore a capability implementation, not a product boundary.

## Deterministic CI provider

M1-002 ships a deterministic provider that emits fixed PNG fixtures and provider-neutral metadata. It exists only to prove orchestration and persistence in CI.

It must identify itself as `deterministic-test` and must never be presented as a production image model.

## Production adapters

Production adapters may later include OpenAI or other image/vision providers. They must satisfy the same interface and artifact normalization requirements.

Adding a provider must not require a schema version bump unless canonical semantics actually change.

## Security

- No provider-returned path may be opened directly.
- No provider-returned URL is canonical.
- Remote retrieval requires a separately governed artifact-ingestion layer.
- SVG and executable document formats are not accepted as canonical generated image artifacts in M1-002.
- Canonical visual artifacts are PNG/JPEG/WebP only.
- Image metadata is not trusted as dimensional truth.

## Consequences

CAD3MF can change image/vision vendors without changing its product model. Visual workflows remain shared across organic and hard-surface product profiles, while M1-003 and later geometry adapters may specialize by geometry class.
