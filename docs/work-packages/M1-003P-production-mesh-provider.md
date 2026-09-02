# M1-003P — Production Mesh Provider Benchmark & Integration

Status: In Development  
Milestone: CAD3MF M1  
Date: 2026-09-02

## Goal

Replace the deterministic CI-only mesh provider with at least one real image-to-3D provider behind the existing `MeshProvider` boundary, then run two real benchmark generations:

1. stylized figurine reference -> 3D mesh;
2. futuristic tank / vehicle reference -> 3D mesh.

M1-003P must not change canonical product semantics merely to fit a provider.

## Provider decision

### Primary production-path adapter — Stable Fast 3D

The first product-oriented adapter targets **Stability AI Stable Fast 3D (SF3D)**.

Reasons:

- direct single-image -> textured UV-unwrapped GLB output;
- roughly 6 GB VRAM for a single image with the documented default path;
- Linux/CUDA deployment fits the CAD3MF mesh-worker architecture;
- Stability AI Community License explicitly provides a limited commercial path subject to its registration/revenue terms;
- materially simpler hardware target than the 24 GB minimum documented for TRELLIS.2.

Important limitation: SF3D is single-image conditioned. CAD3MF therefore keeps the canonical multi-view Turnaround Set, but the adapter selects one canonical view and records exactly which view digest it consumed.

### Research / quality benchmark — TRELLIS.2

Microsoft TRELLIS.2 remains a high-quality benchmark candidate because it exports high-fidelity PBR GLB and handles complex topology. However, although TRELLIS.2 itself is MIT licensed, its official stack depends on NVIDIA `nvdiffrast` and `nvdiffrec`, whose published licenses restrict use to non-commercial research/evaluation. CAD3MF must therefore not present the current upstream TRELLIS.2 stack as the default commercial production path without separate licensing review.

### Secondary candidate — Hunyuan3D

Tencent Hunyuan3D remains a benchmark candidate, particularly for lower-memory shape generation and future multi-view evaluation. Its community license has territory/commercial obligations, and Hunyuan3D 2.1's public multi-view path has unresolved usability concerns. Provider-specific terms remain outside canonical CAD3MF contracts.

## Runtime boundary

```text
CAD3MF MeshRuntime
      |
      v
MeshProvider
      |
      +-- deterministic-mesh-ci (CI only)
      |
      +-- sf3d-http (first production-path adapter)
      |           |
      |           v
      |      mesh-worker / SF3D
      |           |
      |           v
      |        GLB bytes
      |
      +-- trellis2-http (research/quality adapter target)
```

The Node MCP process never imports CUDA/PyTorch. Heavy inference belongs in a separate GPU worker.

## Single-view selection policy

For SF3D and other single-view providers:

1. `three_quarter_front` if available;
2. `front`;
3. first available canonical view.

The selected view name and SHA-256 are returned by the provider adapter and become the provider-consumed provenance. CAD3MF must not claim that all turnaround views were consumed.

## SF3D worker contract

`POST /v1/generate`

Request: `multipart/form-data`

- `image`: PNG/JPEG/WebP bytes selected from the canonical turnaround;
- `view_name`: canonical camera role;
- `quality_tier`: preview / standard / high;
- `target_triangle_count`: optional;
- `texture_policy`: none / vertex_color / pbr.

Response:

- body: binary GLB (`model/gltf-binary`);
- `x-cad3mf-mesh-stats`: base64url JSON containing vertex count, triangle count, bounding box and topology observations;
- `x-cad3mf-used-view`: canonical view name;
- `x-cad3mf-provider`: `stable-fast-3d`;
- `x-cad3mf-model`: `stabilityai/stable-fast-3d`.

The worker must bound input/output sizes, reject path-based inputs, use isolated temporary files, and never silently substitute deterministic output.

## Production environment

```text
CAD3MF_MESH_PROVIDER=sf3d-http
CAD3MF_SF3D_URL=http://127.0.0.1:8791
```

Optional:

```text
CAD3MF_SF3D_TIMEOUT_MS=180000
CAD3MF_SF3D_API_TOKEN=...
```

CI leaves `CAD3MF_MESH_PROVIDER` unset and therefore keeps the deterministic provider.

## Benchmark execution status

The repository integration can be completed in ChatGPT/GitHub, but a real inference requires a reachable GPU runtime plus accepted/gated model weights.

Current execution attempts from this development session:

- Hugging Face Jobs: blocked with HTTP 402 Payment Required before job creation;
- local execution container: no external DNS/network and no usable GPU;
- no installed third-party 3D-generation plugin is available in the current ChatGPT environment.

Therefore the first real figurine/tank inference must run on a connected GPU worker such as the user's GB10 or another authorized GPU host. Until one real output is captured, M1-003P status is **integration-ready**, not benchmark-complete.

## Acceptance criteria

M1-003P is complete only after:

- SF3D adapter compiles and passes contract tests;
- provider selection is explicit and never silently falls back;
- worker health and generate contracts are implemented;
- provider output records exactly which turnaround view was consumed;
- one figurine and one tank reference have actually completed real model inference;
- resulting GLB files can be parsed and basic mesh stats recorded;
- M0/M1 regression remains green.
