# M1-003P — Production Mesh Provider Benchmark & Integration

Status: COMPLETE  
Milestone: CAD3MF M1  
Date: 2026-09-03

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
- Stability AI Community License provides a limited commercial path subject to its terms;
- materially simpler hardware target than the 24 GB minimum documented for TRELLIS.2.

Important limitation: SF3D is single-image conditioned. CAD3MF therefore keeps the canonical multi-view Turnaround Set, but the adapter selects one canonical view and records exactly which view digest it consumed.

### Research / quality benchmark — TRELLIS.2

Microsoft TRELLIS.2 remains a high-quality benchmark candidate because it exports high-fidelity PBR GLB and handles complex topology. However, although TRELLIS.2 itself is MIT licensed, its current official stack includes NVIDIA dependencies whose published terms restrict use to non-commercial research/evaluation. CAD3MF must not present that stack as the default commercial production path without separate licensing review.

### Secondary candidate — Hunyuan3D

Tencent Hunyuan3D remains a benchmark candidate for future provider comparison. Provider-specific terms remain outside canonical CAD3MF contracts.

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

The selected view name and SHA-256 become provider-consumed provenance. CAD3MF must not claim that all turnaround views were consumed.

## SF3D worker contract

`POST /v1/generate`

Request: `multipart/form-data`

- `image`: PNG/JPEG/WebP bytes selected from the canonical turnaround;
- `view_name`: canonical camera role;
- `quality_tier`: preview / standard / high;
- `target_triangle_count`: optional;
- `texture_policy`: PBR for the current SF3D worker;
- `scale_policy`: `longest_extent`;
- `scale_dimension_name`: trusted dimension semantic name;
- `target_extent_mm`: trusted metric extent.

Response:

- body: binary GLB (`model/gltf-binary`);
- `x-cad3mf-mesh-stats`: base64url JSON containing vertex count, triangle count, bounding box and topology observations;
- `x-cad3mf-used-view`: canonical view name;
- `x-cad3mf-provider`: `stable-fast-3d`;
- `x-cad3mf-model`: `stabilityai/stable-fast-3d`.

The worker bounds input/output sizes, rejects path-based inputs, uses isolated temporary files, and never silently substitutes deterministic output.

## Metric scale governance

SF3D reconstructs normalized shape but does not provide trustworthy physical millimeter scale.

CAD3MF therefore requires a Design Intent dimension whose source is `user` or `measured_reference` before production inference. `inferred` and `default` dimensions do not qualify.

Current scaling policy is uniform `longest_extent` scaling:

- figurine / character: prefer confirmed height;
- vehicle / tank: prefer confirmed length;
- if the preferred semantic dimension is unavailable, use another explicitly supplied/measured mm dimension.

The worker scales actual mesh vertices and measures the resulting bounding box after scaling. It does not relabel normalized model units as millimeters.

## GB10 physical validation

The first physical validation completed on 2026-09-03 on an NVIDIA GB10 / Linux aarch64 host.

Validated runtime:

- NVIDIA driver `595.84`;
- system CUDA runtime `13.2`;
- Python `3.11.15`;
- PyTorch `2.12.0+cu130`;
- torchvision `0.27.0+cu130`;
- compute capability `12.1`;
- `texture_baker` native CUDA extension: PASS;
- `uv_unwrapper` native extension: PASS;
- gated Hugging Face access: PASS;
- real `SF3D.from_pretrained(...)` CUDA model load: PASS.

### REF-VIS-001 — Figurine

- target longest extent: `120 mm`;
- output SHA-256: `4295be7ce155b6192eb86c53f55349b5a733227753fba429f7848f7115257644`;
- bounding-box extents: `78.6759 x 120.0 x 47.4976 mm`;
- vertices: `11,431`;
- triangles: `19,168`;
- peak PyTorch CUDA allocation: `6.044 GiB`;
- elapsed generation: `6.16 s`;
- watertight observation: `false`.

Result: **PASS — real SF3D GLB generated.**

### REF-VIS-002 — Tank

- target longest extent: `160 mm`;
- output SHA-256: `26489a7c9b05b74feda910f3b27d5f63922fd5e9ed7d9858393aa992b36c843b`;
- bounding-box extents: `160.0 x 105.1153 x 80.6691 mm`;
- vertices: `11,000`;
- triangles: `17,652`;
- peak PyTorch CUDA allocation: `6.044 GiB`;
- elapsed generation: `5.59 s`;
- watertight observation: `false`.

Result: **PASS — real SF3D GLB generated.**

Full execution evidence is recorded in `docs/evidence/M1-003P-GB10-2026-09-03.md`.

## GB10 packaging findings

The real deployment discovered and documented three upstream packaging constraints:

1. `texture_baker` and `uv_unwrapper` need `--no-build-isolation` because their setup imports the already-installed CUDA PyTorch package.
2. `gpytoolbox` and `pynanoinstantmeshes` did not build cleanly on the validated aarch64 host.
3. SF3D imports those remesh-only dependencies at module import time; CAD3MF now supplies `services/mesh-worker/patch_sf3d_optional_remesh.py` to make them lazy for the `remesh=none` production path.

These constraints do not change canonical MeshProvider semantics and do not introduce a CPU or deterministic fallback.

## Prior remote execution evidence

Before GB10 validation, the official public SF3D ZeroGPU Space was tested from GitHub Actions. Network, API discovery, upload and preprocessing passed, but the public Space failed inside its model-generation endpoint and returned no GLB.

That failure remains useful evidence that the public ZeroGPU Space is not accepted as CAD3MF's production backend.

## Acceptance criteria

M1-003P acceptance status:

- [x] SF3D adapter compiles and passes contract tests;
- [x] provider selection is explicit and never silently falls back;
- [x] worker health and generate contracts are implemented;
- [x] provider output records exactly which turnaround view was consumed;
- [x] trusted metric scale is required before production inference;
- [x] one figurine reference completed real model inference and GLB export;
- [x] one tank reference completed real model inference and GLB export;
- [x] SHA-256, mesh statistics, metric bounds and topology observations were recorded;
- [x] M0/M1 regression CI remained green before physical validation.

## Manufacturing boundary

M1-003P is now **COMPLETE**.

Neither reference mesh is watertight. That is intentionally not repaired inside M1-003P.

M1-004 owns printable-mesh repair and validation, including watertightness, manifoldness, self-intersections, minimum feature/thickness policy and later print preparation.
