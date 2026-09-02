export type MeshFormat = "glb" | "obj" | "ply";
export type MeshAssetKind =
  | "figurine"
  | "character"
  | "vehicle_shell"
  | "hard_surface_shell"
  | "product_shell"
  | "decorative_part"
  | "other";

export interface MeshGenerationRequest {
  projectId: string;
  turnaroundRevisionId: string;
  assetKind: MeshAssetKind;
  qualityTier: "preview" | "standard" | "high";
  outputFormat: MeshFormat;
  texturePolicy: "none" | "vertex_color" | "pbr";
  targetTriangleCount?: number | null;
}

export interface MeshInputView {
  view: string;
  sha256: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
}

export interface MeshProviderContext {
  request: MeshGenerationRequest;
  turnaround: Record<string, unknown>;
  views: MeshInputView[];
}

export interface MeshProviderOutput {
  bytes: Uint8Array;
  format: MeshFormat;
  mediaType: "model/gltf-binary" | "model/obj" | "model/ply";
  vertexCount: number;
  triangleCount: number;
  boundingBoxMm: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  topology: {
    watertight: boolean | null;
    manifold: boolean | null;
    selfIntersectionsDetected: boolean | null;
    notes: string[];
  };
  /** Canonical turnaround view names actually consumed by this provider. */
  consumedViews: string[];
}

export interface MeshProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelVersion: string | null;
  generate(context: MeshProviderContext): Promise<MeshProviderOutput>;
}
