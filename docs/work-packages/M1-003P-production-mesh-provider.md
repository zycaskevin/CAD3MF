# M1-003P — Production Mesh Provider Benchmark & Integration

Status: In Development  
Milestone: CAD3MF M1  
Date: 2026-09-02

## Goal

Replace the deterministic CI-only mesh provider with at least one real image-to-3D provider behind the existing `MeshProvider` boundary, then run two real benchmark generations:

1. stylized figurine reference -> 3D mesh;
2. futuristic tank / vehicle reference -> 3D mesh.

M1-003P must not change canonical product semantics merely to fit a provider.

## Provider decision — first integration

The first production adapter targets **Microsoft TRELLIS.2**.

Reasons:

- upstream repository code is MIT licensed;
- official inference path exports textured PBR GLB;
- provider is designed for high-fidelity image-to-3D and complex topology;
- Linux + NVIDIA GPU is a good fit for the CAD3MF worker architecture;
- the provider can remain fully local when deployed on a compatible GPU worker.

Important limitation: the public TRELLIS.2 image-to-3D pipeline is single-image conditioned. CAD3MF therefore treats it as a **single-view provider behind a multi-view canonical pipeline**. The adapter selects one canonical turnaround view according to explicit policy and records exactly which input digest was consumed. It must not claim all six turnaround views were used.

## Hunyuan benchmark position

Tencent Hunyuan3D remains a second candidate, particularly for lower-memory shape generation and future multi-view evaluation. It is not the default production provider for M1-003P because the current 2.1 license carries territory/commercial obligations and the publicly available 2.1 multi-view path has unresolved usability concerns.

## Runtime boundary

```text
CAD3MF MeshRuntime
      |
      v
MeshProvider
      |
      +-- deterministic-mesh-ci (CI only)
      |
      +-- trellis2-http (production adapter)
                  |
                  v
          mesh-worker / TRELLIS.2
                  |
                  v
               GLB bytes
```

The Node MCP process does not import CUDA/PyTorch. Heavy model execution belongs in a separate GPU worker.

## TRELLIS.2 worker contract

The adapter sends one canonical image as multipart/form-data to a worker endpoint and expects:

- GLB bytes;
- provider/model/version metadata in response headers;
- optional topology/mesh statistics in response headers or a sidecar JSON endpoint.

The worker must validate image media type and size, isolate temporary files, and never accept arbitrary filesystem paths from callers.

## View selection

Initial policy:

1. `three_quarter_front` if available;
2. `front`;
3. first available canonical view.

The selected view name and SHA-256 are recorded in provider output metadata and become the only provider input digests in Mesh Artifact / Asset-IR provenance.

## Production environment

`CAD3MF_MESH_PROVIDER=trellis2-http`

`CAD3MF_TRELLIS2_URL=http://127.0.0.1:8791`

Optional:

- `CAD3MF_TRELLIS2_TIMEOUT_MS`
- `CAD3MF_TRELLIS2_API_TOKEN`

Default provider remains deterministic in CI unless explicitly selected.

## Benchmark acceptance

M1-003P is complete only after:

- TRELLIS.2 adapter compiles and passes contract tests;
- worker health contract is documented;
- one figurine image and one tank image have actually completed real model inference;
- resulting GLB files can be parsed and basic mesh stats recorded;
- input digest provenance matches the view actually consumed;
- failures do not silently fall back to deterministic mesh;
- M0/M1 regression remains green.

A successful adapter implementation without a real inference run is **integration-ready**, not benchmark-complete.
