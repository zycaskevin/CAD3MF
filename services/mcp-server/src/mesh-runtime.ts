import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createM1Job, failM1Job, startM1Job, succeedM1Job, type M1ArtifactRef, type M1JobManifest } from "./jobs.js";
import { DeterministicMeshProvider } from "./mesh-provider.js";
import { MeshStore, type StoredMeshArtifact } from "./mesh-store.js";
import type { MeshAssetKind, MeshFormat, MeshGenerationRequest, MeshProvider } from "./mesh-types.js";
import { VisualStore } from "./visual-store.js";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface MeshRuntimeOptions {
  dataDir?: string;
  meshStore?: MeshStore;
  visualStore?: VisualStore;
  provider?: MeshProvider;
}

export interface GenerateMeshInput {
  projectId: string;
  turnaroundRevisionId?: string;
  assetKind: MeshAssetKind;
  qualityTier?: "preview" | "standard" | "high";
  outputFormat?: MeshFormat;
  texturePolicy?: "none" | "vertex_color" | "pbr";
  targetTriangleCount?: number | null;
}

function requireProjectId(value: string): string {
  if (!PROJECT_ID.test(value)) throw new Error("invalid project_id");
  return value;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function extension(format: MeshFormat): string {
  return format;
}

function validateMeshBytes(format: MeshFormat, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) throw new Error("mesh provider returned empty artifact");
  if (format === "glb") {
    if (bytes.byteLength < 12 || new TextDecoder().decode(bytes.slice(0, 4)) !== "glTF") {
      throw new Error("mesh provider returned invalid GLB header");
    }
    return;
  }
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 128)));
  if (format === "ply" && !prefix.startsWith("ply\n")) throw new Error("mesh provider returned invalid PLY header");
  if (format === "obj" && !/(^|\n)(v|o|g)\s/.test(prefix)) throw new Error("mesh provider returned invalid OBJ content");
}

function logicalRef(document: Record<string, unknown>, kind: string, revisionId: string): M1ArtifactRef {
  return {
    artifact_id: `${kind}:${revisionId}`,
    kind,
    sha256: jsonDigest(document),
    media_type: "application/json",
    revision_ref: revisionId,
  };
}

function assetType(kind: MeshAssetKind): string {
  return kind;
}

function printDefaults(kind: MeshAssetKind): Record<string, unknown> {
  const organic = kind === "figurine" || kind === "character";
  return {
    minimum_wall_thickness_mm: organic ? 1.2 : 1.6,
    minimum_feature_size_mm: 1.0,
    base_required: organic,
    target_height_mm: null,
    maximum_overhang_deg: null,
  };
}

export class MeshRuntime {
  readonly #dataDir: string;
  readonly #meshStore: MeshStore;
  readonly #visualStore: VisualStore;
  readonly #provider: MeshProvider;

  constructor(options: MeshRuntimeOptions = {}) {
    this.#dataDir = resolve(options.dataDir ?? process.env.CAD3MF_DATA_DIR ?? ".cad3mf-data");
    mkdirSync(this.#dataDir, { recursive: true });
    this.#meshStore = options.meshStore ?? new MeshStore(join(this.#dataDir, "mesh.sqlite"));
    this.#visualStore = options.visualStore ?? new VisualStore(join(this.#dataDir, "visual.sqlite"));
    this.#provider = options.provider ?? new DeterministicMeshProvider();
  }

  providerInfo(): Record<string, unknown> {
    return {
      provider_id: this.#provider.providerId,
      model_id: this.#provider.modelId,
      model_version: this.#provider.modelVersion,
    };
  }

  async generateMesh(input: GenerateMeshInput): Promise<Record<string, unknown>> {
    const projectId = requireProjectId(input.projectId);
    const turnaround = this.#visualStore.getDocument(projectId, "turnaround_set", input.turnaroundRevisionId);
    if (turnaround.status !== "accepted" && turnaround.status !== "needs_review") {
      throw new Error(`turnaround ${String(turnaround.revision_id)} is not eligible for mesh generation`);
    }
    const consistency = turnaround.consistency as Record<string, unknown> | undefined;
    if (!consistency || consistency.pass !== true) {
      throw new Error("turnaround consistency must pass before mesh generation");
    }
    const viewRecords = turnaround.views;
    if (!Array.isArray(viewRecords) || viewRecords.length < 4) {
      throw new Error("mesh generation requires at least four turnaround views");
    }

    const views = viewRecords.map((value) => {
      if (typeof value !== "object" || value === null) throw new Error("invalid turnaround view");
      const view = value as Record<string, unknown>;
      const artifactId = String(view.artifact_id);
      const artifact = this.#visualStore.getArtifact(projectId, artifactId);
      const bytes = new Uint8Array(readFileSync(artifact.path));
      if (digest(bytes) !== artifact.sha256) throw new Error(`turnaround artifact checksum mismatch ${artifactId}`);
      return {
        view: String(view.view),
        sha256: artifact.sha256,
        mediaType: artifact.mediaType,
        bytes,
      };
    });

    const requestRevisionId = this.#meshStore.nextRevisionId(projectId, "mesh_request");
    const now = new Date().toISOString();
    const request: MeshGenerationRequest = {
      projectId,
      turnaroundRevisionId: String(turnaround.revision_id),
      assetKind: input.assetKind,
      qualityTier: input.qualityTier ?? "standard",
      outputFormat: input.outputFormat ?? "ply",
      texturePolicy: input.texturePolicy ?? "none",
      ...(input.targetTriangleCount === undefined ? {} : { targetTriangleCount: input.targetTriangleCount }),
    };
    const requestDoc: Record<string, unknown> = {
      schema_version: "0.1.0",
      request_id: requestRevisionId,
      project_id: projectId,
      source_turnaround_revision_id: request.turnaroundRevisionId,
      asset_kind: request.assetKind,
      quality_tier: request.qualityTier,
      output_format: request.outputFormat,
      texture_policy: request.texturePolicy,
      target_triangle_count: request.targetTriangleCount ?? null,
      preserve_semantic_regions: true,
      notes: [],
      status: "submitted",
      created_at: now,
    };
    this.#meshStore.addDocument(projectId, "mesh_request", requestRevisionId, requestDoc, now);

    let job = createM1Job({
      jobId: randomUUID(),
      traceId: randomUUID(),
      projectId,
      jobKind: "geometry_generation",
      stage: "geometry",
      inputs: views.map((view) => ({
        artifact_id: `turnaround:${view.view}`,
        kind: `turnaround_${view.view}`,
        sha256: view.sha256,
        media_type: view.mediaType,
        revision_ref: request.turnaroundRevisionId,
      })),
      toolVersions: [{ component: this.#provider.providerId, version: this.#provider.modelId, digest: null }],
      now,
    });
    this.#meshStore.saveJob(job);
    job = startM1Job(job, "geometry", now);
    this.#meshStore.saveJob(job);

    try {
      const generated = await this.#provider.generate({ request, turnaround, views });
      if (generated.format !== request.outputFormat) throw new Error("mesh provider output format differs from request");
      validateMeshBytes(generated.format, generated.bytes);
      if (!Number.isInteger(generated.vertexCount) || generated.vertexCount < 0) throw new Error("invalid vertex count");
      if (!Number.isInteger(generated.triangleCount) || generated.triangleCount < 0) throw new Error("invalid triangle count");

      const meshArtifact = this.#storeMesh(projectId, generated.format, generated.mediaType, generated.bytes, now);
      const meshRevisionId = this.#meshStore.nextRevisionId(projectId, "mesh_artifact");
      const meshDoc: Record<string, unknown> = {
        schema_version: "0.1.0",
        artifact_id: meshArtifact.artifactId,
        project_id: projectId,
        source_request_id: requestRevisionId,
        sha256: meshArtifact.sha256,
        format: meshArtifact.format,
        media_type: meshArtifact.mediaType,
        vertex_count: generated.vertexCount,
        triangle_count: generated.triangleCount,
        bounding_box_mm: generated.boundingBoxMm,
        topology_observations: {
          watertight: generated.topology.watertight,
          manifold: generated.topology.manifold,
          self_intersections_detected: generated.topology.selfIntersectionsDetected,
          notes: generated.topology.notes,
        },
        provenance: {
          provider: this.#provider.providerId,
          model: this.#provider.modelId,
          model_version: this.#provider.modelVersion,
          job_id: job.job_id,
          input_artifact_sha256: views.map((view) => view.sha256),
          generated_at: now,
        },
        status: "generated",
        created_at: now,
      };
      this.#meshStore.addDocument(projectId, "mesh_artifact", meshRevisionId, meshDoc, now);

      const assetRevisionId = this.#meshStore.nextRevisionId(projectId, "asset_ir");
      const assetDoc: Record<string, unknown> = {
        schema_version: "0.1.0",
        asset_id: `asset-${projectId}`,
        project_id: projectId,
        revision_id: assetRevisionId,
        parent_revision_id: null,
        source_intent_revision_id: String(turnaround.source_concept_revision_id ?? "unknown"),
        source_turnaround_revision_id: String(turnaround.revision_id),
        asset_type: assetType(request.assetKind),
        units: "mm",
        style: null,
        pose: null,
        target_dimensions: [],
        geometry_artifact: {
          artifact_id: meshArtifact.artifactId,
          sha256: meshArtifact.sha256,
          format: meshArtifact.format,
          media_type: meshArtifact.mediaType,
          vertex_count: generated.vertexCount,
          triangle_count: generated.triangleCount,
        },
        regions: [],
        print_constraints: printDefaults(request.assetKind),
        provenance: {
          generator_kind: "mesh_provider",
          provider: this.#provider.providerId,
          model: this.#provider.modelId,
          model_version: this.#provider.modelVersion,
          job_id: job.job_id,
          input_artifact_sha256: views.map((view) => view.sha256),
        },
        status: "generated",
      };
      this.#meshStore.addDocument(projectId, "asset_ir", assetRevisionId, assetDoc, now);

      const outputs: M1ArtifactRef[] = [
        logicalRef(requestDoc, "mesh_request", requestRevisionId),
        logicalRef(meshDoc, "mesh_artifact", meshRevisionId),
        logicalRef(assetDoc, "asset_ir", assetRevisionId),
        {
          artifact_id: meshArtifact.artifactId,
          kind: "mesh",
          sha256: meshArtifact.sha256,
          media_type: meshArtifact.mediaType,
          revision_ref: assetRevisionId,
        },
      ];
      job = succeedM1Job(job, outputs, now);
      this.#meshStore.saveJob(job);
      return { job, mesh_request: requestDoc, mesh_artifact: meshDoc, asset_ir: assetDoc };
    } catch (error) {
      job = failM1Job(job, "MESH_GENERATION_FAILED", new Date().toISOString());
      this.#meshStore.saveJob(job);
      throw error;
    }
  }

  getJob(jobId: string): M1JobManifest {
    return this.#meshStore.getJob(jobId);
  }

  artifactLocation(projectIdInput: string, artifactId: string): StoredMeshArtifact {
    const projectId = requireProjectId(projectIdInput);
    return this.#meshStore.getArtifact(projectId, artifactId);
  }

  getAsset(projectIdInput: string, revisionId?: string): Record<string, unknown> {
    return this.#meshStore.getDocument(requireProjectId(projectIdInput), "asset_ir", revisionId);
  }

  #storeMesh(
    projectId: string,
    format: MeshFormat,
    mediaType: StoredMeshArtifact["mediaType"],
    bytes: Uint8Array,
    createdAt: string,
  ): StoredMeshArtifact {
    const sha256 = digest(bytes);
    const artifactId = `mesh-${randomUUID()}`;
    const directory = join(this.#dataDir, "mesh-artifacts", projectId);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${artifactId}.${extension(format)}`);
    writeFileSync(path, Buffer.from(bytes), { flag: "wx" });
    const artifact: StoredMeshArtifact = { projectId, artifactId, path, sha256, format, mediaType, createdAt };
    this.#meshStore.saveArtifact(artifact);
    return artifact;
  }
}
