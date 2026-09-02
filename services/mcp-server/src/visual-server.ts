import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { JsonObject } from "./types.js";
import { downloadChatGptVisualFile } from "./visual-file-ingest.js";
import { VisualRuntime } from "./visual-runtime.js";
import type {
  VisualDimension,
  VisualProductKind,
  VisualSourceAsset,
} from "./visual-types.js";

const PRODUCT_KINDS = [
  "figurine",
  "character",
  "modular_product",
  "vehicle",
  "mechanical_part",
  "hybrid",
  "other",
] as const;
const SOURCE_ROLES = [
  "identity_reference",
  "concept",
  "front",
  "left",
  "right",
  "back",
  "three_quarter_front",
  "three_quarter_back",
  "sketch",
  "dimension_reference",
  "other",
] as const;
const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const jsonObjectSchema = z.record(z.string(), z.unknown());
const visualOutputSchema = z.object({
  job: jsonObjectSchema.optional(),
  design_intent: jsonObjectSchema.optional(),
  visual_concept: jsonObjectSchema.optional(),
  turnaround_set: jsonObjectSchema.optional(),
  provider: jsonObjectSchema.optional(),
  artifact_urls: z.record(z.string(), z.string().url()).optional(),
});

function result(output: JsonObject) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function schemaText(relativePath: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(process.env.CAD3MF_REPO_ROOT ?? resolve(moduleDir, "../../.."));
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function visualArtifactUrl(publicBaseUrl: string, projectId: string, artifactId: string): string {
  const base = publicBaseUrl.endsWith("/") ? publicBaseUrl.slice(0, -1) : publicBaseUrl;
  return `${base}/visual-artifacts/${encodeURIComponent(projectId)}/${encodeURIComponent(artifactId)}`;
}

function artifactUrls(document: unknown, publicBaseUrl?: string): Record<string, string> {
  if (!publicBaseUrl || typeof document !== "object" || document === null) return {};
  const record = document as Record<string, unknown>;
  const projectId = String(record.project_id ?? "");
  if (!projectId) return {};
  const urls: Record<string, string> = {};
  const collections = [record.artifacts, record.views];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    for (const value of collection) {
      if (typeof value !== "object" || value === null) continue;
      const artifactId = (value as Record<string, unknown>).artifact_id;
      if (typeof artifactId === "string" && artifactId.length > 0) {
        urls[artifactId] = visualArtifactUrl(publicBaseUrl, projectId, artifactId);
      }
    }
  }
  return urls;
}

function outputWithPublicArtifacts(
  output: Record<string, unknown>,
  publicBaseUrl?: string,
): JsonObject {
  const document = output.visual_concept ?? output.turnaround_set;
  const urls = artifactUrls(document, publicBaseUrl);
  return {
    ...output,
    provider: output.provider ?? {},
    ...(Object.keys(urls).length > 0 ? { artifact_urls: urls } : {}),
  };
}

export interface VisualM1RegistrationOptions {
  publicBaseUrl?: string;
  runtime?: VisualRuntime;
}

export function registerVisualM1(
  server: McpServer,
  options: VisualM1RegistrationOptions = {},
): VisualRuntime {
  const runtime = options.runtime ?? new VisualRuntime();

  server.registerResource(
    "visual-concept-schema",
    "caddesk://schema/visual-concept/0.1.0",
    {
      title: "CAD3MF Visual Concept 0.1.0 JSON Schema",
      description: "Canonical M1-002 visual concept contract.",
      mimeType: "application/schema+json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/schema+json",
          text: schemaText("packages/visual-concept/schemas/visual-concept-0.1.0.json"),
        },
      ],
    }),
  );

  server.registerResource(
    "turnaround-set-schema",
    "caddesk://schema/turnaround-set/0.1.0",
    {
      title: "CAD3MF Turnaround Set 0.1.0 JSON Schema",
      description: "Canonical M1-002 multi-view turnaround contract.",
      mimeType: "application/schema+json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/schema+json",
          text: schemaText("packages/visual-concept/schemas/turnaround-set-0.1.0.json"),
        },
      ],
    }),
  );

  const sourceFileSchema = z.object({
    download_url: z.string().url(),
    file_id: z.string().min(1).max(512),
    mime_type: z.string().max(128).optional(),
    file_name: z.string().max(512).optional(),
    role: z.enum(SOURCE_ROLES).default("other"),
  });
  const sourceAssetSchema = z.object({
    asset_id: z.string().min(1).max(128),
    sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
    media_type: z.enum(MEDIA_TYPES),
    role: z.enum(SOURCE_ROLES),
  });
  const dimensionSchema = z.object({
    name: z.string().min(1).max(128),
    value: z.number().positive().finite(),
    unit: z.literal("mm").default("mm"),
    source: z.enum(["user", "measured_reference", "inferred", "default"]),
    confidence: z.number().min(0).max(1).optional(),
  });

  server.registerTool(
    "analyze_visual_input",
    {
      title: "Analyze visual design input",
      description:
        "Create canonical Design Intent from ChatGPT image files or previously ingested image artifacts plus a design prompt. Source images are evidence, not geometry truth.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128).optional(),
        product_kind: z.enum(PRODUCT_KINDS),
        design_prompt: z.string().min(1).max(4000),
        style: z.string().max(256).nullable().optional(),
        requested_functions: z.array(z.string().min(1).max(256)).max(64).default([]),
        source_files: z.array(sourceFileSchema).max(12).default([]),
        source_assets: z
          .array(sourceAssetSchema)
          .max(32)
          .default([])
          .describe("Advanced reuse of visual artifacts already ingested by CAD3MF."),
        known_dimensions: z.array(dimensionSchema).max(128).default([]),
      }),
      outputSchema: visualOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/fileParams": ["source_files"],
      },
    },
    async ({
      project_id,
      product_kind,
      design_prompt,
      style,
      requested_functions,
      source_files,
      source_assets,
      known_dimensions,
    }) => {
      try {
        if (source_files.length === 0 && source_assets.length === 0) {
          throw new Error("at least one source_files or source_assets image is required");
        }
        if (source_files.length + source_assets.length > 32) {
          throw new Error("combined visual source count must not exceed 32 images");
        }

        const downloadedAssets: VisualSourceAsset[] = [];
        for (const file of source_files) {
          const downloaded = await downloadChatGptVisualFile({
            downloadUrl: file.download_url,
            fileId: file.file_id,
            ...(file.mime_type === undefined ? {} : { mimeType: file.mime_type }),
            ...(file.file_name === undefined ? {} : { fileName: file.file_name }),
            role: file.role,
          });
          downloadedAssets.push({
            assetId: `source-${randomUUID()}`,
            sha256: downloaded.sha256,
            mediaType: downloaded.mediaType,
            role: downloaded.role,
            bytes: downloaded.bytes,
          });
        }

        const sourceAssets: VisualSourceAsset[] = [
          ...downloadedAssets,
          ...source_assets.map((asset) => ({
            assetId: asset.asset_id,
            sha256: asset.sha256,
            mediaType: asset.media_type,
            role: asset.role,
          })),
        ];
        const knownDimensions: VisualDimension[] = known_dimensions.map((dimension) => ({
          name: dimension.name,
          value: dimension.value,
          unit: "mm",
          source: dimension.source,
          ...(dimension.confidence === undefined ? {} : { confidence: dimension.confidence }),
        }));
        const output = await runtime.analyzeVisualInput({
          ...(project_id === undefined ? {} : { projectId: project_id }),
          productKind: product_kind as VisualProductKind,
          designPrompt: design_prompt,
          style: style ?? null,
          requestedFunctions: requested_functions,
          sourceAssets,
          knownDimensions,
        });
        return result(
          outputWithPublicArtifacts(
            { ...output, provider: runtime.providerInfo() },
            options.publicBaseUrl,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "generate_concept",
    {
      title: "Generate visual concept",
      description:
        "Generate a reviewable visual concept from canonical Design Intent. The concept is a derived review artifact and not 3D geometry truth.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        intent_revision_id: z.string().min(1).max(128).optional(),
      }),
      outputSchema: visualOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_id, intent_revision_id }) => {
      try {
        const output = await runtime.generateConcept(project_id, intent_revision_id);
        return result(
          outputWithPublicArtifacts(
            { ...output, provider: runtime.providerInfo() },
            options.publicBaseUrl,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "confirm_design",
    {
      title: "Confirm and design-lock visual concept",
      description:
        "Resolve required visual decisions and create immutable successor revisions. This gate must pass before turnaround generation.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        concept_revision_id: z.string().min(1).max(128).optional(),
        answers: z.record(z.string(), z.string().max(2000)).default({}),
        waive: z.array(z.string().min(1).max(128)).max(128).default([]),
        notes: z.array(z.string().min(1).max(1000)).max(128).default([]),
      }),
      outputSchema: visualOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_id, concept_revision_id, answers, waive, notes }) => {
      try {
        const output = runtime.confirmDesign({
          projectId: project_id,
          ...(concept_revision_id === undefined ? {} : { conceptRevisionId: concept_revision_id }),
          answers,
          waive,
          notes,
        });
        return result(
          outputWithPublicArtifacts(
            { ...output, provider: runtime.providerInfo() },
            options.publicBaseUrl,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "generate_turnaround",
    {
      title: "Generate multi-view turnaround",
      description:
        "Generate a consistent multi-view reference set from a design-locked concept for downstream M1-003 geometry generation.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        concept_revision_id: z.string().min(1).max(128).optional(),
        coverage_policy: z
          .enum(["minimum_four_view", "full_six_view"])
          .default("full_six_view"),
      }),
      outputSchema: visualOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ project_id, concept_revision_id, coverage_policy }) => {
      try {
        const output = await runtime.generateTurnaround(
          project_id,
          concept_revision_id,
          coverage_policy,
        );
        return result(
          outputWithPublicArtifacts(
            { ...output, provider: runtime.providerInfo() },
            options.publicBaseUrl,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_visual_job",
    {
      title: "Get visual pipeline job",
      description: "Read a persisted M1 visual job manifest by job ID.",
      inputSchema: z.object({ job_id: z.string().min(1).max(128) }),
      outputSchema: jsonObjectSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      try {
        const job = runtime.getJob(job_id);
        return result(job as unknown as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return runtime;
}
