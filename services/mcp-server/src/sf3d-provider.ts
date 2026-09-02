import type {
  MeshInputView,
  MeshProvider,
  MeshProviderContext,
  MeshProviderOutput,
} from "./mesh-types.js";

const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;

interface Sf3dStats {
  vertex_count: number;
  triangle_count: number;
  bounding_box_mm: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  topology: {
    watertight: boolean | null;
    manifold: boolean | null;
    self_intersections_detected: boolean | null;
    notes?: string[];
  };
}

export interface Sf3dHttpMeshProviderOptions {
  baseUrl?: string;
  timeoutMs?: number;
  apiToken?: string | null;
}

function selectSingleView(views: MeshInputView[]): MeshInputView {
  if (views.length === 0) throw new Error("SF3D requires at least one turnaround view");
  return (
    views.find((view) => view.view === "three_quarter_front") ??
    views.find((view) => view.view === "front") ??
    views[0]!
  );
}

function extension(mediaType: MeshInputView["mediaType"]): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  return "webp";
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`SF3D worker returned invalid ${label}`);
  }
  return value;
}

function parsePoint(value: unknown, label: string): { x: number; y: number; z: number } {
  if (typeof value !== "object" || value === null) {
    throw new Error(`SF3D worker returned invalid ${label}`);
  }
  const point = value as Record<string, unknown>;
  return {
    x: requireFiniteNumber(point.x, `${label}.x`),
    y: requireFiniteNumber(point.y, `${label}.y`),
    z: requireFiniteNumber(point.z, `${label}.z`),
  };
}

function nullableBoolean(value: unknown, label: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") throw new Error(`SF3D worker returned invalid ${label}`);
  return value;
}

function parseStats(header: string | null): Sf3dStats {
  if (!header) throw new Error("SF3D worker response is missing x-cad3mf-mesh-stats");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    throw new Error("SF3D worker returned malformed x-cad3mf-mesh-stats");
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("SF3D worker returned invalid mesh stats object");
  }
  const stats = decoded as Record<string, unknown>;
  const bbox = stats.bounding_box_mm;
  const topology = stats.topology;
  if (typeof bbox !== "object" || bbox === null) throw new Error("SF3D worker returned invalid bounding box");
  if (typeof topology !== "object" || topology === null) throw new Error("SF3D worker returned invalid topology");
  const bboxRecord = bbox as Record<string, unknown>;
  const topologyRecord = topology as Record<string, unknown>;
  const notes = topologyRecord.notes;
  if (notes !== undefined && (!Array.isArray(notes) || notes.some((note) => typeof note !== "string"))) {
    throw new Error("SF3D worker returned invalid topology notes");
  }
  const vertexCount = requireFiniteNumber(stats.vertex_count, "vertex_count");
  const triangleCount = requireFiniteNumber(stats.triangle_count, "triangle_count");
  if (!Number.isInteger(vertexCount) || vertexCount < 0) throw new Error("SF3D worker returned invalid vertex_count");
  if (!Number.isInteger(triangleCount) || triangleCount < 0) throw new Error("SF3D worker returned invalid triangle_count");
  return {
    vertex_count: vertexCount,
    triangle_count: triangleCount,
    bounding_box_mm: {
      min: parsePoint(bboxRecord.min, "bounding_box_mm.min"),
      max: parsePoint(bboxRecord.max, "bounding_box_mm.max"),
    },
    topology: {
      watertight: nullableBoolean(topologyRecord.watertight, "topology.watertight"),
      manifold: nullableBoolean(topologyRecord.manifold, "topology.manifold"),
      self_intersections_detected: nullableBoolean(
        topologyRecord.self_intersections_detected,
        "topology.self_intersections_detected",
      ),
      notes: Array.isArray(notes) ? [...notes] : [],
    },
  };
}

export class Sf3dHttpMeshProvider implements MeshProvider {
  readonly providerId = "sf3d-http";
  readonly modelId = "stabilityai/stable-fast-3d";
  readonly modelVersion: string | null = null;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #apiToken: string | null;

  constructor(options: Sf3dHttpMeshProviderOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? process.env.CAD3MF_SF3D_URL ?? "http://127.0.0.1:8791").replace(/\/$/, "");
    this.#timeoutMs = options.timeoutMs ?? Number(process.env.CAD3MF_SF3D_TIMEOUT_MS ?? "180000");
    this.#apiToken = options.apiToken ?? process.env.CAD3MF_SF3D_API_TOKEN ?? null;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs < 1000 || this.#timeoutMs > 900000) {
      throw new Error("CAD3MF_SF3D_TIMEOUT_MS must be between 1000 and 900000");
    }
  }

  async generate(context: MeshProviderContext): Promise<MeshProviderOutput> {
    if (context.request.outputFormat !== "glb") {
      throw new Error("SF3D production provider currently supports only GLB output");
    }
    const selected = selectSingleView(context.views);
    const form = new FormData();
    form.append(
      "image",
      new Blob([selected.bytes], { type: selected.mediaType }),
      `turnaround-${selected.view}.${extension(selected.mediaType)}`,
    );
    form.append("view_name", selected.view);
    form.append("quality_tier", context.request.qualityTier);
    form.append("texture_policy", context.request.texturePolicy);
    if (context.request.targetTriangleCount != null) {
      form.append("target_triangle_count", String(context.request.targetTriangleCount));
    }

    const headers: Record<string, string> = {};
    if (this.#apiToken) headers.authorization = `Bearer ${this.#apiToken}`;
    const response = await fetch(`${this.#baseUrl}/v1/generate`, {
      method: "POST",
      body: form,
      headers,
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 2000);
      throw new Error(`SF3D worker failed with HTTP ${response.status}: ${text}`);
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim();
    if (contentType !== "model/gltf-binary") {
      throw new Error(`SF3D worker returned unexpected content-type ${contentType || "<missing>"}`);
    }
    const length = response.headers.get("content-length");
    if (length && Number(length) > MAX_OUTPUT_BYTES) {
      throw new Error(`SF3D worker output exceeds ${MAX_OUTPUT_BYTES} bytes`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_OUTPUT_BYTES) {
      throw new Error("SF3D worker returned empty or oversized GLB");
    }
    if (bytes.byteLength < 12 || new TextDecoder().decode(bytes.slice(0, 4)) !== "glTF") {
      throw new Error("SF3D worker returned invalid GLB header");
    }
    const usedView = response.headers.get("x-cad3mf-used-view");
    if (usedView !== selected.view) {
      throw new Error("SF3D worker used-view acknowledgement does not match requested canonical view");
    }
    const provider = response.headers.get("x-cad3mf-provider");
    if (provider && provider !== "stable-fast-3d") {
      throw new Error(`unexpected SF3D worker provider identity ${provider}`);
    }
    const stats = parseStats(response.headers.get("x-cad3mf-mesh-stats"));
    return {
      bytes,
      format: "glb",
      mediaType: "model/gltf-binary",
      vertexCount: stats.vertex_count,
      triangleCount: stats.triangle_count,
      boundingBoxMm: stats.bounding_box_mm,
      topology: {
        watertight: stats.topology.watertight,
        manifold: stats.topology.manifold,
        selfIntersectionsDetected: stats.topology.self_intersections_detected,
        notes: stats.topology.notes ?? [],
      },
      consumedViews: [selected.view],
    };
  }
}
