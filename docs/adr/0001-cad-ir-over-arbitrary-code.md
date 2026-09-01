# ADR-0001: CAD-IR instead of arbitrary model-generated code

Status: Accepted for v0.1 / M0

## Context

A language model can generate CadQuery Python directly, but executing model-generated Python makes security, validation, revisioning, deterministic rebuilds, backend portability, and product support materially harder.

## Decision

CAD3MF treats CAD-IR as the canonical editable asset. The Agent may propose or modify CAD-IR, but the geometry worker compiles only schema-supported features.

CAD-IR 0.1 scalar resolution is deliberately tiny:

- numeric literals are accepted;
- exact references such as `$width` are accepted;
- arbitrary expressions, templates, imports, function calls, and Python source are rejected.

The first compiler backend is CadQuery/OpenCascade.

## Consequences

Positive:

- revisions are data diffs rather than source-code rewrites;
- inputs can be validated before geometry execution;
- feature support is explicit and testable;
- a later OpenSCAD or FreeCAD compiler can consume the same higher-level contract;
- arbitrary user/model Python is outside the trusted computing base.

Trade-offs:

- CAD-IR must grow intentionally as product requirements grow;
- formula/constraint semantics need a future safe expression representation rather than Python `eval`;
- not every CadQuery operation is immediately available.

## Non-goal

This ADR does not prohibit trusted, repository-owned Python inside backend adapters. It prohibits executing Python supplied dynamically through the design payload.
