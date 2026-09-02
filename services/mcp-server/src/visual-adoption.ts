import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createM1Job,
  failM1Job,
  startM1Job,
  succeedM1Job,
  type M1ArtifactRef,
} from "./jobs.js";
import { VisualStore, type StoredVisualArtifact } from "./visual-store.js";
import type { VisualDecision, VisualSourceAsset } from "./visual-types.js";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;

export interface AdoptVisualConceptInput {
  projectId: string;
  intentRevisionId?: string;
  brief: string;
  designNotes?: string[];
  openDecisions?: VisualDecision[];
  conceptImages: VisualSourceAsset[];
}

export interface HostVisualConceptAdopterOptions {
  dataDir?: string;
  store?: VisualStore;
}

function requireProjectId(value: string): string {
  if (!PROJECT_ID.test(value)) {
    throw new Error("project_id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/");
  }
  return value;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function extension(mediaType: VisualSourceAsset["mediaType"]): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  return "webp";
}

function logicalDocumentArtifact(
  document: Record<string, unknown>,
  kind: "design_intent" | "visual_concept",
  revisionId: string,
): M1ArtifactRef {
  return {
    artifact_id: `${kind}:${revisionId}`,
    kind,
    sha256: jsonDigest(document),
    media_type: "application/json",
    revision_ref: revisionId,
  };
}

export class HostVisualConceptAdopter {
  readonly #dataDir: string;
  readonly #store: VisualStore;

  constructor(options: HostVisualConceptAdopterOptions = {}) {
    this.#dataDir = resolve(options.dataDir ?? process.env.CAD3MF_DATA_DIR ?? ".cad3mf-data");
    mkdirSync(this.#dataDir, { recursive: true });
    this.#store = options.store ?? new VisualStore(join(this.#dataDir, "visual.sqlite"));
  }

  adoptConcept(input: AdoptVisualConceptInput): Record<string, unknown> {
    const projectId = requireProjectId(input.projectId);
    if (input.brief.trim().length === 0) throw new Error("brief must not be empty");
    if (input.conceptImages.length < 1 || input.conceptImages.length > 8) {
      throw new Error("concept_images must contain between 1 and 8 images");
    }
    for (const image of input.conceptImages) {
      if (!SHA256.test(image.sha256)) throw new Error(`invalid SHA-256 for ${image.assetId}`);
      if (!image.bytes) throw new Error(`host-provided concept image ${image.assetId} has no bytes`);
      if (digest(image.bytes) !== image.sha256) {
        throw new Error(`host-provided concept checksum mismatch for ${image.assetId}`);
      }
    }

    const intent = this.#store.getDocument(projectId, "design_intent", input.intentRevisionId);
    if (intent.status === "rejected") throw new Error("cannot adopt concept for rejected design intent");

    const now = new Date().toISOString();
    let job = createM1Job({
      jobId: randomUUID(),
      traceId: randomUUID(),
      projectId,
      jobKind: "concept_generation",
      stage: "concept",
      inputs: [
        logicalDocumentArtifact(intent, "design_intent", String(intent.revision_id)),
        ...input.conceptImages.map((image) => ({
          artifact_id: image.assetId,
          kind: "host_concept_image",
          sha256: image.sha256,
          media_type: image.mediaType,
          revision_ref: null,
        })),
      ],
      toolVersions: [{ component: "chatgpt-host-artifact", version: "1", digest: null }],
      now,
    });
    this.#store.saveJob(job);
    job = startM1Job(job, "concept", now);
    this.#store.saveJob(job);

    try {
      const stored = input.conceptImages.map((image, index) => ({
        stored: this.#storeImage(projectId, image, now),
        role: index === 0 ? "hero" : "variant",
      }));
      const revisionId = this.#store.nextRevisionId(projectId, "visual_concept");
      let parentRevisionId: string | null = null;
      try {
        parentRevisionId = String(this.#store.getDocument(projectId, "visual_concept").revision_id);
      } catch {
        parentRevisionId = null;
      }
      const productKind = String(intent.product_kind);
      const style = typeof intent.style === "string" ? intent.style : null;
      const concept: Record<string, unknown> = {
        schema_version: "0.1.0",
        concept_id: `concept-${projectId}`,
        project_id: projectId,
        revision_id: revisionId,
        parent_revision_id: parentRevisionId,
        source_intent_revision_id: String(intent.revision_id),
        product_kind: productKind,
        brief: input.brief,
        style,
        artifacts: stored.map(({ stored: artifact, role }) => ({
          artifact_id: artifact.artifactId,
          sha256: artifact.sha256,
          media_type: artifact.mediaType,
          role,
        })),
        design_notes: [...(input.designNotes ?? [])],
        open_decisions: (input.openDecisions ?? []).map((decision) => ({
          id: decision.id,
          prompt: decision.prompt,
          required: decision.required,
          status: decision.status,
          ...(decision.answer === undefined ? {} : { answer: decision.answer }),
        })),
        status: "needs_confirmation",
        provenance: {
          provider: "host-provided",
          model: "unattested-host-visual",
          job_id: job.job_id,
          input_artifact_sha256: input.conceptImages.map((image) => image.sha256),
          generated_at: now,
        },
        created_at: now,
        updated_at: now,
      };
      this.#store.addDocument(projectId, "visual_concept", revisionId, concept, now);

      const outputs: M1ArtifactRef[] = [
        logicalDocumentArtifact(concept, "visual_concept", revisionId),
        ...stored.map(({ stored: artifact }) => ({
          artifact_id: artifact.artifactId,
          kind: "concept_image",
          sha256: artifact.sha256,
          media_type: artifact.mediaType,
          revision_ref: revisionId,
        })),
      ];
      job = succeedM1Job(job, outputs, now);
      this.#store.saveJob(job);
      return { job, visual_concept: concept };
    } catch (error) {
      job = failM1Job(job, "HOST_CONCEPT_ADOPTION_FAILED", new Date().toISOString());
      this.#store.saveJob(job);
      throw error;
    }
  }

  #storeImage(
    projectId: string,
    image: VisualSourceAsset,
    createdAt: string,
  ): StoredVisualArtifact {
    if (!image.bytes) throw new Error(`host-provided concept image ${image.assetId} has no bytes`);
    const directory = join(this.#dataDir, "visual-artifacts", projectId);
    mkdirSync(directory, { recursive: true });
    const artifactId = image.assetId;
    const path = join(directory, `host-concept-${randomUUID()}.${extension(image.mediaType)}`);
    writeFileSync(path, Buffer.from(image.bytes), { flag: "wx" });
    const artifact: StoredVisualArtifact = {
      projectId,
      artifactId,
      path,
      sha256: image.sha256,
      mediaType: image.mediaType,
      createdAt,
    };
    this.#store.saveArtifact(artifact);
    return artifact;
  }
}
