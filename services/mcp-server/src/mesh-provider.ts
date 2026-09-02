import type { MeshProvider, MeshProviderContext, MeshProviderOutput } from "./mesh-types.js";

function cubePly(): Uint8Array {
  const text = `ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\nelement face 12\nproperty list uchar int vertex_indices\nend_header\n-10 -10 0\n10 -10 0\n10 10 0\n-10 10 0\n-10 -10 20\n10 -10 20\n10 10 20\n-10 10 20\n3 0 1 2\n3 0 2 3\n3 4 6 5\n3 4 7 6\n3 0 4 5\n3 0 5 1\n3 1 5 6\n3 1 6 2\n3 2 6 7\n3 2 7 3\n3 3 7 4\n3 3 4 0\n`;
  return new TextEncoder().encode(text);
}

export class DeterministicMeshProvider implements MeshProvider {
  readonly providerId = "deterministic-mesh-ci";
  readonly modelId = "cube-fixture";
  readonly modelVersion = "1";

  async generate(context: MeshProviderContext): Promise<MeshProviderOutput> {
    if (context.views.length < 4) throw new Error("mesh generation requires at least four turnaround views");
    if (context.request.outputFormat !== "ply") {
      throw new Error("deterministic CI mesh provider supports only PLY");
    }
    return {
      bytes: cubePly(),
      format: "ply",
      mediaType: "model/ply",
      vertexCount: 8,
      triangleCount: 12,
      boundingBoxMm: {
        min: { x: -10, y: -10, z: 0 },
        max: { x: 10, y: 10, z: 20 },
      },
      topology: {
        watertight: true,
        manifold: true,
        selfIntersectionsDetected: false,
        notes: ["Deterministic cube fixture for CI only; not a production reconstruction."],
      },
      consumedViews: context.views.map((view) => view.view),
    };
  }
}
