import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createM1Job,
  failM1Job,
  startM1Job,
  succeedM1Job,
  type M1ArtifactRef,
  type M1JobManifest,
} from "./jobs.js";
import { DeterministicVisualProvider, type VisualProvider } from "./visual-provider.js";
import { VisualStore, type StoredVisualArtifact, type VisualDocumentKind } from "./visual-store.js";
import type {
  AnalyzeVisualInput,
  GeneratedVisualImage,
  TurnaroundViewName,
  VisualDimension,
  VisualMediaType,
  VisualProductKind,
  VisualProviderContext,
  VisualSourceAsset,
} from "./visual-types.js";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;

export interface VisualRuntimeOptions {
  dataDir?: string;
  store?: VisualStore;
  provider?: VisualProvider;
}

export interface ConfirmVisualDesignInput {
  projectId: string;
  conceptRevisionId?: string;
  answers?: Record<string, string>;
  waive?: string[];
  notes?: string[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireProjectId(value?: string): string {
  const projectId = value ?? randomUUID();
  if (!PROJECT_ID.test(projectId)) {
    throw new Error("project_id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/");
  }
  return projectId;
}

function jsonDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function bytesDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function imageExtension(mediaType: VisualMediaType): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  return "webp";
}

function sourceAssetFromCanonical(value: unknown): VisualSourceAsset {
  if (typeof value !== "object" || value === null) throw new Error("invalid source asset");
  const item = value as Record<string, unknown>;
  const mediaType = String(item.media_type);
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") {
    throw new Error(`unsupported source media type ${mediaType}`);
  }
  return {
    assetId: String(item.asset_id),
    sha256: String(item.sha256),
    mediaType,
    role: String(item.role) as VisualSourceAsset["role"],
  };
}

function dimensionFromCanonical(value: unknown): VisualDimension {
  if (typeof value !== "object" || value === null) throw new Error("invalid visual dimension");
  const item = value as Record<string, unknown>;
  const source = String(item.source) as VisualDimension["source"];
  return {
    name: String(item.name),
    value: Number(item.value),
    unit: "mm",
    source,
    ...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}),
  };
}

function designPromptFromIntent(intent: Record<string, unknown>): string {
  const observed = intent.observed_features;
  if (!Array.isArray(observed)) throw new Error("design intent has no observed_features");
  for (const feature of observed) {
    if (typeof feature !== "object" || feature === null) continue;
    const item = feature as Record<string, unknown>;
    if (item.type === "requested_form" && typeof item.value === "string") return item.value;
  }
  throw new Error("design intent has no requested_form observation");
}

function logicalDocumentArtifact(
  document: Record<string, unknown>,
  kind: string,
  revisionRef: string,
): M1ArtifactRef {
  return {
    artifact_id: `${kind}:${revisionRef}`,
    kind,
    sha256: jsonDigest(document),
    media_type: "application/json",
    revision_ref: revisionRef,
  };
}

function readStoredAsset(
  store: VisualStore,
  projectId: string,
  asset: VisualSourceAsset,
  required: boolean,
): VisualSourceAsset {
  let stored: StoredVisualArtifact;
  try {
    stored = store.getArtifact(projectId, asset.assetId);
  } catch (error) {
    if (!required && error instanceof Error && error.message.startsWith("unknown visual artifact")) {
      return asset;
    }
    throw error;
  }
  if (stored.sha256 !== asset.sha256 || stored.mediaType !== asset.mediaType) {
    throw new Error(`stored visual artifact metadata mismatch for ${asset.assetId}`);
  }
  const bytes = new Uint8Array(readFileSync(stored.path));
  if (bytesDigest(bytes) !== stored.sha256) {
    throw new Error(`stored visual artifact checksum mismatch for ${asset.assetId}`);
  }
  return { ...asset, bytes };
}

function providerContextFromIntent(
  intent: Record<string, unknown>,
  store: VisualStore,
): VisualProviderContext {
  const sourceAssets = intent.source_assets;
  const dimensions = intent.known_dimensions;
  if (!Array.isArray(sourceAssets) || !Array.isArray(dimensions)) {
    throw new Error("design intent is missing canonical visual inputs");
  }
  const requestedFunctions = Array.isArray(intent.requested_functions)
    ? intent.requested_functions.map((value) => String(value))
    : [];
  const projectId = requireProjectId(String(intent.project_id));
  return {
    projectId,
    productKind: String(intent.product_kind) as VisualProductKind,
    designPrompt: designPromptFromIntent(intent),
    style: typeof intent.style === "string" ? intent.style : null,
    requestedFunctions,
    sourceAssets: sourceAssets
      .map(sourceAssetFromCanonical)
      .map((asset) => readStoredAsset(store, projectId, asset, false)),
    knownDimensions: dimensions.map(dimensionFromCanonical),
  };
}

function conceptImagesFromConcept(
  concept: Record<string, unknown>,
  store: VisualStore,
): VisualSourceAsset[] {
  const projectId = requireProjectId(String(concept.project_id));
  const artifacts = concept.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error("visual concept has no image artifacts");
  }
  return artifacts.map((value) => {
    if (typeof value !== "object" || value === null) throw new Error("invalid concept artifact");
    const artifact = value as Record<string, unknown>;
    const mediaType = String(artifact.media_type);
    if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") {
      throw new Error(`unsupported concept image media type ${mediaType}`);
    }
    const source: VisualSourceAsset = {
      assetId: String(artifact.artifact_id),
      sha256: String(artifact.sha256),
      mediaType,
      role: "concept",
    };
    return readStoredAsset(store, projectId, source, true);
  });
}

export class VisualRuntime {
  readonly #dataDir: string;
  readonly #store: VisualStore;
  readonly #provider: VisualProvider;

  constructor(options: VisualRuntimeOptions = {}) {
    this.#dataDir = resolve(options.dataDir ?? process.env.CAD3MF_DATA_DIR ?? ".cad3mf-data");
    mkdirSync(this.#dataDir, { recursive: true });
    this.#store = options.store ?? new VisualStore(join(this.#dataDir, "visual.sqlite"));
    this.#provider = options.provider ?? new DeterministicVisualProvider();
  }

  providerInfo(): { provider_id: string; model_id: string } {
    return { provider_id: this.#provider.providerId, model_id: this.#provider.modelId };
  }

  async analyzeVisualInput(input: AnalyzeVisualInput): Promise<Record<string, unknown>> {
    const projectId = requireProjectId(input.projectId);
    if (input.designPrompt.trim().length === 0) throw new Error("design_prompt must not be empty");
    if (input.sourceAssets.length < 1 || input.sourceAssets.length > 32) {
      throw new Error("source_assets must contain between 1 and 32 images");
    }
    for (const asset of input.sourceAssets) {
      if (!SHA256.test(asset.sha256)) throw new Error(`invalid SHA-256 for ${asset.assetId}`);
      if (asset.bytes && bytesDigest(asset.bytes) !== asset.sha256) {
        throw new Error(`source image checksum mismatch for ${asset.assetId}`);
      }
    }
    for (const dimension of input.knownDimensions ?? []) {
      if (!Number.isFinite(dimension.value) || dimension.value <= 0) {
        throw new Error(`dimension ${dimension.name} must be greater than zero`);
      }
    }

    const now = new Date().toISOString();
    for (const asset of input.sourceAssets) {
      if (asset.bytes) this.#storeSourceAsset(projectId, asset, now);
    }

    let job = createM1Job({
      jobId: randomUUID(),
      traceId: randomUUID(),
      projectId,
      jobKind: "visual_analysis",
      stage: "intake",
      inputs: input.sourceAssets.map((asset) => ({
        artifact_id: asset.assetId,
        kind: "source_image",
        sha256: asset.sha256,
        media_type: asset.mediaType,
        revision_ref: null,
      })),
      toolVersions: [
        { component: this.#provider.providerId, version: this.#provider.modelId, digest: null },
      ],
      now,
    });
    this.#store.saveJob(job);
    job = startM1Job(job, "visual_analysis", now);
    this.#store.saveJob(job);

    try {
      const context: VisualProviderContext = {
        projectId,
        productKind: input.productKind,
        designPrompt: input.designPrompt,
        style: input.style ?? null,
        requestedFunctions: [...(input.requestedFunctions ?? [])],
        sourceAssets: input.sourceAssets.map((asset) => ({ ...asset })),
        knownDimensions: (input.knownDimensions ?? []).map((dimension) => ({ ...dimension })),
      };
      const analysis = await this.#provider.analyze(context);
      const revisionId = this.#store.nextRevisionId(projectId, "design_intent");
      const parentRevisionId = this.#latestRevisionId(projectId, "design_intent");
      const intent: Record<string, unknown> = {
        schema_version: "0.1.0",
        intent_id: `intent-${projectId}`,
        project_id: projectId,
        revision_id: revisionId,
        parent_revision_id: parentRevisionId,
        product_kind: input.productKind,
        style: input.style ?? null,
        requested_functions: [...(input.requestedFunctions ?? [])],
        source_assets: input.sourceAssets.map((asset) => ({
          asset_id: asset.assetId,
          sha256: asset.sha256,
          media_type: asset.mediaType,
          role: asset.role,
        })),
        known_dimensions: (input.knownDimensions ?? []).map((dimension) => ({
          name: dimension.name,
          value: dimension.value,
          unit: "mm",
          source: dimension.source,
          ...(dimension.confidence === undefined ? {} : { confidence: dimension.confidence }),
        })),
        observed_features: analysis.observedFeatures.map((feature) => ({
          id: feature.id,
          type: feature.type,
          value: feature.value,
          confidence: feature.confidence,
          evidence: feature.evidenceAssetIds.map((assetId) => ({ asset_id: assetId })),
          user_confirmed: feature.userConfirmed ?? false,
        })),
        hidden_geometry_assumptions: analysis.assumptions.map((assumption) => ({
          id: assumption.id,
          statement: assumption.statement,
          confidence: assumption.confidence,
          user_confirmed: assumption.userConfirmed,
        })),
        questions: analysis.questions.map((question) => ({
          id: question.id,
          prompt: question.prompt,
          required: question.required,
          status: question.status,
          ...(question.answer === undefined ? {} : { answer: question.answer }),
        })),
        notes: [...analysis.notes],
        status: "needs_confirmation",
        created_at: now,
        updated_at: now,
      };
      this.#store.addDocument(projectId, "design_intent", revisionId, intent, now);
      job = succeedM1Job(job, [logicalDocumentArtifact(intent, "design_intent", revisionId)], now);
      this.#store.saveJob(job);
      return { job, design_intent: cloneJson(intent) };
    } catch (error) {
      job = failM1Job(job, "VISUAL_ANALYSIS_FAILED", new Date().toISOString());
      this.#store.saveJob(job);
      throw error;
    }
  }

  async generateConcept(
    projectIdInput: string,
    intentRevisionId?: string,
  ): Promise<Record<string, unknown>> {
    const projectId = requireProjectId(projectIdInput);
    const intent = this.#store.getDocument(projectId, "design_intent", intentRevisionId);
    if (intent.status === "rejected") throw new Error("cannot generate concept from rejected design intent");
    const context = providerContextFromIntent(intent, this.#store);
    const now = new Date().toISOString();
    let job = createM1Job({
      jobId: randomUUID(),
      traceId: randomUUID(),
      projectId,
      jobKind: "concept_generation",
      stage: "concept",
      inputs: [
        logicalDocumentArtifact(intent, "design_intent", String(intent.revision_id)),
        ...context.sourceAssets.map((asset) => ({
          artifact_id: asset.assetId,
          kind: "source_image",
          sha256: asset.sha256,
          media_type: asset.mediaType,
          revision_ref: null,
        })),
      ],
      toolVersions: [
        { component: this.#provider.providerId, version: this.#provider.modelId, digest: null },
      ],
      now,
    });
    this.#store.saveJob(job);
    job = startM1Job(job, "concept", now);
    this.#store.saveJob(job);

    try {
      const generated = await this.#provider.generateConcept({ ...context, designIntent: intent });
      if (generated.images.length < 1 || generated.images.length > 8) {
        throw new Error("visual provider returned invalid concept image count");
      }
      const conceptRevisionId = this.#store.nextRevisionId(projectId, "visual_concept");
      const parentRevisionId = this.#latestRevisionId(projectId, "visual_concept");
      const artifacts = generated.images.map((image, index) => {
        const stored = this.#storeImage(projectId, `concept-${index + 1}`, image, now);
        return {
          artifact_id: stored.artifactId,
          sha256: stored.sha256,
          media_type: stored.mediaType,
          role: index === 0 ? "hero" : "variant",
          width_px: image.widthPx,
          height_px: image.heightPx,
        };
      });
      const concept: Record<string, unknown> = {
        schema_version: "0.1.0",
        concept_id: `concept-${projectId}`,
        project_id: projectId,
        revision_id: conceptRevisionId,
        parent_revision_id: parentRevisionId,
        source_intent_revision_id: String(intent.revision_id),
        product_kind: context.productKind,
        brief: generated.brief,
        style: context.style,
        artifacts,
        design_notes: [...generated.designNotes],
        open_decisions: generated.openDecisions.map((decision) => ({
          id: decision.id,
          prompt: decision.prompt,
          required: decision.required,
          status: decision.status,
          ...(decision.answer === undefined ? {} : { answer: decision.answer }),
        })),
        status: "needs_confirmation",
        provenance: {
          provider: this.#provider.providerId,
          model: this.#provider.modelId,
          job_id: job.job_id,
          input_artifact_sha256: context.sourceAssets.map((asset) => asset.sha256),
          generated_at: now,
        },
        created_at: now,
        updated_at: now,
      };
      this.#store.addDocument(projectId, "visual_concept", conceptRevisionId, concept, now);
      const outputRefs: M1ArtifactRef[] = [
        logicalDocumentArtifact(concept, "visual_concept", conceptRevisionId),
        ...artifacts.map((artifact) => ({
          artifact_id: String(artifact.artifact_id),
          kind: "concept_image",
          sha256: String(artifact.sha256),
          media_type: String(artifact.media_type),
          revision_ref: conceptRevisionId,
        })),
      ];
      job = succeedM1Job(job, outputRefs, now);
      this.#store.saveJob(job);
      return { job, visual_concept: cloneJson(concept) };
    } catch (error) {
      job = failM1Job(job, "CONCEPT_GENERATION_FAILED", new Date().toISOString());
      this.#store.saveJob(job);
      throw error;
    }
  }

  confirmDesign(input: ConfirmVisualDesignInput): Record<string, unknown> {
    const projectId = requireProjectId(input.projectId);
    const concept = this.#store.getDocument(projectId, "visual_concept", input.conceptRevisionId);
    if (concept.status === "design_locked") throw new Error("visual concept is already design-locked");
    if (concept.status === "rejected" || concept.status === "superseded") {
      throw new Error(`cannot confirm visual concept in ${String(concept.status)} state`);
    }
    const decisions = concept.open_decisions;
    if (!Array.isArray(decisions)) throw new Error("visual concept has no open_decisions array");
    const answers = input.answers ?? {};
    const waive = new Set(input.waive ?? []);
    const updatedDecisions = decisions.map((value) => {
      if (typeof value !== "object" || value === null) throw new Error("invalid concept decision");
      const decision = cloneJson(value as Record<string, unknown>);
      const id = String(decision.id);
      if (Object.hasOwn(answers, id)) {
        decision.status = "answered";
        decision.answer = answers[id] ?? "";
      } else if (waive.has(id)) {
        decision.status = "waived";
        decision.answer = null;
      }
      return decision;
    });
    const unresolved = updatedDecisions.filter(
      (decision) => decision.required === true && decision.status === "open",
    );
    if (unresolved.length > 0) {
      throw new Error(
        `required visual decisions remain open: ${unresolved.map((decision) => decision.id).join(", ")}`,
      );
    }

    const now = new Date().toISOString();
    const sourceIntentRevisionId = String(concept.source_intent_revision_id);
    const sourceIntent = this.#store.getDocument(
      projectId,
      "design_intent",
      sourceIntentRevisionId,
    );
    const lockedIntentRevisionId = this.#store.nextRevisionId(projectId, "design_intent");
    const lockedIntent = cloneJson(sourceIntent);
    lockedIntent.revision_id = lockedIntentRevisionId;
    lockedIntent.parent_revision_id = sourceIntentRevisionId;
    lockedIntent.status = "confirmed";
    lockedIntent.updated_at = now;
    const existingNotes = Array.isArray(lockedIntent.notes)
      ? lockedIntent.notes.map((value) => String(value))
      : [];
    lockedIntent.notes = [...existingNotes, ...(input.notes ?? [])];
    this.#store.addDocument(projectId, "design_intent", lockedIntentRevisionId, lockedIntent, now);

    const lockedConceptRevisionId = this.#store.nextRevisionId(projectId, "visual_concept");
    const lockedConcept = cloneJson(concept);
    lockedConcept.revision_id = lockedConceptRevisionId;
    lockedConcept.parent_revision_id = String(concept.revision_id);
    lockedConcept.source_intent_revision_id = lockedIntentRevisionId;
    lockedConcept.open_decisions = updatedDecisions;
    lockedConcept.status = "design_locked";
    lockedConcept.updated_at = now;
    this.#store.addDocument(
      projectId,
      "visual_concept",
      lockedConceptRevisionId,
      lockedConcept,
      now,
    );

    return {
      design_intent: cloneJson(lockedIntent),
      visual_concept: cloneJson(lockedConcept),
    };
  }

  async generateTurnaround(
    projectIdInput: string,
    conceptRevisionId?: string,
    coveragePolicy: "minimum_four_view" | "full_six_view" = "full_six_view",
  ): Promise<Record<string, unknown>> {
    const projectId = requireProjectId(projectIdInput);
    const concept = this.#store.getDocument(projectId, "visual_concept", conceptRevisionId);
    if (concept.status !== "design_locked") {
      throw new Error("turnaround generation requires a design-locked visual concept");
    }
    const intent = this.#store.getDocument(
      projectId,
      "design_intent",
      String(concept.source_intent_revision_id),
    );
    const context = providerContextFromIntent(intent, this.#store);
    const now = new Date().toISOString();
    let job = createM1Job({
      jobId: randomUUID(),
      traceId: randomUUID(),
      projectId,
      jobKind: "turnaround_generation",
      stage: "turnaround",
      inputs: [logicalDocumentArtifact(concept, "visual_concept", String(concept.revision_id))],
      toolVersions: [
        { component: this.#provider.providerId, version: this.#provider.modelId, digest: null },
      ],
      now,
    });
    this.#store.saveJob(job);
    job = startM1Job(job, "turnaround", now);
    this.#store.saveJob(job);

    try {
      const generated = await this.#provider.generateTurnaround({
        ...context,
        visualConcept: concept,
        conceptImages: conceptImagesFromConcept(concept, this.#store),
        coveragePolicy,
      });
      this.#validateTurnaroundCoverage(
        generated.views.map((view) => view.view),
        coveragePolicy,
      );
      const revisionId = this.#store.nextRevisionId(projectId, "turnaround_set");
      const parentRevisionId = this.#latestRevisionId(projectId, "turnaround_set");
      const views = generated.views.map((view) => {
        const stored = this.#storeImage(projectId, `turnaround-${view.view}`, view, now);
        return {
          view: view.view,
          artifact_id: stored.artifactId,
          sha256: stored.sha256,
          media_type: stored.mediaType,
          projection: view.projection,
          width_px: view.widthPx,
          height_px: view.heightPx,
          notes: view.notes ?? null,
        };
      });
      const turnaround: Record<string, unknown> = {
        schema_version: "0.1.0",
        turnaround_id: `turnaround-${projectId}`,
        project_id: projectId,
        revision_id: revisionId,
        parent_revision_id: parentRevisionId,
        source_concept_revision_id: String(concept.revision_id),
        coverage_policy: coveragePolicy,
        views,
        consistency: {
          pass: generated.consistency.pass,
          identity_score: generated.consistency.identityScore,
          style_score: generated.consistency.styleScore,
          silhouette_score: generated.consistency.silhouetteScore,
          warnings: [...generated.consistency.warnings],
        },
        status: "needs_review",
        provenance: {
          provider: this.#provider.providerId,
          model: this.#provider.modelId,
          job_id: job.job_id,
          input_artifact_sha256: this.#conceptArtifactDigests(concept),
          generated_at: now,
        },
        created_at: now,
        updated_at: now,
      };
      this.#store.addDocument(projectId, "turnaround_set", revisionId, turnaround, now);
      const outputRefs: M1ArtifactRef[] = [
        logicalDocumentArtifact(turnaround, "turnaround_set", revisionId),
        ...views.map((view) => ({
          artifact_id: String(view.artifact_id),
          kind: `turnaround_${String(view.view)}`,
          sha256: String(view.sha256),
          media_type: String(view.media_type),
          revision_ref: revisionId,
        })),
      ];
      job = succeedM1Job(job, outputRefs, now);
      this.#store.saveJob(job);
      return { job, turnaround_set: cloneJson(turnaround) };
    } catch (error) {
      job = failM1Job(job, "TURNAROUND_GENERATION_FAILED", new Date().toISOString());
      this.#store.saveJob(job);
      throw error;
    }
  }

  getJob(jobId: string): M1JobManifest {
    return this.#store.getJob(jobId);
  }

  artifactLocation(
    projectIdInput: string,
    artifactId: string,
  ): { projectId: string; artifactId: string; path: string; sha256: string; mediaType: VisualMediaType } {
    const projectId = requireProjectId(projectIdInput);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(artifactId)) {
      throw new Error("invalid visual artifact id");
    }
    const artifact = this.#store.getArtifact(projectId, artifactId);
    return {
      projectId: artifact.projectId,
      artifactId: artifact.artifactId,
      path: artifact.path,
      sha256: artifact.sha256,
      mediaType: artifact.mediaType,
    };
  }

  #latestRevisionId(projectId: string, kind: VisualDocumentKind): string | null {
    try {
      return String(this.#store.getDocument(projectId, kind).revision_id);
    } catch {
      return null;
    }
  }

  #storeSourceAsset(projectId: string, asset: VisualSourceAsset, createdAt: string): void {
    if (!asset.bytes) return;
    const computed = bytesDigest(asset.bytes);
    if (computed !== asset.sha256) throw new Error(`source image checksum mismatch for ${asset.assetId}`);

    try {
      const existing = this.#store.getArtifact(projectId, asset.assetId);
      if (
        existing.sha256 !== asset.sha256 ||
        existing.mediaType !== asset.mediaType ||
        bytesDigest(new Uint8Array(readFileSync(existing.path))) !== asset.sha256
      ) {
        throw new Error(`existing source artifact mismatch for ${asset.assetId}`);
      }
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("unknown visual artifact")) {
        throw error;
      }
    }

    const directory = join(this.#dataDir, "visual-artifacts", projectId);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `source-${randomUUID()}.${imageExtension(asset.mediaType)}`);
    writeFileSync(path, Buffer.from(asset.bytes), { flag: "wx" });
    this.#store.saveArtifact({
      projectId,
      artifactId: asset.assetId,
      path,
      sha256: asset.sha256,
      mediaType: asset.mediaType,
      createdAt,
    });
  }

  #storeImage(
    projectId: string,
    prefix: string,
    image: GeneratedVisualImage,
    createdAt: string,
  ): StoredVisualArtifact {
    if (
      image.mediaType !== "image/png" &&
      image.mediaType !== "image/jpeg" &&
      image.mediaType !== "image/webp"
    ) {
      throw new Error(`provider returned unsupported visual media type ${String(image.mediaType)}`);
    }
    const artifactId = `${prefix}-${randomUUID()}`;
    const directory = join(this.#dataDir, "visual-artifacts", projectId);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${artifactId}.${imageExtension(image.mediaType)}`);
    const bytes = Buffer.from(image.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(path, bytes, { flag: "wx" });
    const artifact: StoredVisualArtifact = {
      projectId,
      artifactId,
      path,
      sha256,
      mediaType: image.mediaType,
      createdAt,
    };
    this.#store.saveArtifact(artifact);
    return artifact;
  }

  #validateTurnaroundCoverage(
    views: TurnaroundViewName[],
    coveragePolicy: "minimum_four_view" | "full_six_view",
  ): void {
    const unique = new Set(views);
    if (unique.size !== views.length) throw new Error("turnaround contains duplicate camera views");
    if (coveragePolicy === "full_six_view") {
      const required: TurnaroundViewName[] = [
        "front",
        "left",
        "right",
        "back",
        "three_quarter_front",
        "three_quarter_back",
      ];
      const missing = required.filter((view) => !unique.has(view));
      if (missing.length > 0) throw new Error(`full turnaround is missing: ${missing.join(", ")}`);
      return;
    }
    const hasSide = unique.has("left") || unique.has("right");
    const hasThreeQuarter =
      unique.has("three_quarter_front") || unique.has("three_quarter_back");
    if (!unique.has("front") || !unique.has("back") || !hasSide || !hasThreeQuarter) {
      throw new Error(
        "minimum turnaround requires front, back, one side, and one three-quarter view",
      );
    }
  }

  #conceptArtifactDigests(concept: Record<string, unknown>): string[] {
    const artifacts = concept.artifacts;
    if (!Array.isArray(artifacts)) return [];
    return artifacts
      .map((artifact) => {
        if (typeof artifact !== "object" || artifact === null) return null;
        const sha = (artifact as Record<string, unknown>).sha256;
        return typeof sha === "string" && SHA256.test(sha) ? sha : null;
      })
      .filter((sha): sha is string => sha !== null);
  }
}
