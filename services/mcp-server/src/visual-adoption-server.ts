import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { JsonObject } from "./types.js";
import { HostVisualConceptAdopter } from "./visual-adoption.js";
import { downloadChatGptVisualFile } from "./visual-file-ingest.js";
import type { VisualDecision, VisualSourceAsset } from "./visual-types.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const adoptionOutputSchema = z.object({
  job: jsonObjectSchema,
  visual_concept: jsonObjectSchema,
  provider: jsonObjectSchema,
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

function visualArtifactUrl(publicBaseUrl: string, projectId: string, artifactId: string): string {
  const base = publicBaseUrl.endsWith("/") ? publicBaseUrl.slice(0, -1) : publicBaseUrl;
  return `${base}/visual-artifacts/${encodeURIComponent(projectId)}/${encodeURIComponent(artifactId)}`;
}

function publicArtifactUrls(
  concept: Record<string, unknown>,
  publicBaseUrl?: string,
): Record<string, string> {
  if (!publicBaseUrl) return {};
  const projectId = String(concept.project_id ?? "");
  const artifacts = concept.artifacts;
  if (!projectId || !Array.isArray(artifacts)) return {};
  const urls: Record<string, string> = {};
  for (const value of artifacts) {
    if (typeof value !== "object" || value === null) continue;
    const artifactId = (value as Record<string, unknown>).artifact_id;
    if (typeof artifactId === "string" && artifactId.length > 0) {
      urls[artifactId] = visualArtifactUrl(publicBaseUrl, projectId, artifactId);
    }
  }
  return urls;
}

export interface HostVisualAdoptionRegistrationOptions {
  publicBaseUrl?: string;
  adopter?: HostVisualConceptAdopter;
}

export function registerHostVisualConceptAdoption(
  server: McpServer,
  options: HostVisualAdoptionRegistrationOptions = {},
): HostVisualConceptAdopter {
  const adopter = options.adopter ?? new HostVisualConceptAdopter();

  const fileSchema = z.object({
    download_url: z.string().url(),
    file_id: z.string().min(1).max(512),
    mime_type: z.string().max(128).optional(),
    file_name: z.string().max(512).optional(),
  });
  const decisionSchema = z.object({
    id: z.string().min(1).max(128),
    prompt: z.string().min(1).max(1000),
    required: z.boolean(),
    status: z.enum(["open", "answered", "waived"]).default("open"),
    answer: z.string().max(2000).nullable().optional(),
  });

  server.registerTool(
    "adopt_visual_concept",
    {
      title: "Adopt selected visual concept",
      description:
        "Use this after ChatGPT or the user has produced and selected concept image(s). CAD3MF ingests the selected files into canonical Visual Concept state without regenerating them. A later confirm_design call still creates the explicit design-lock revision.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        intent_revision_id: z.string().min(1).max(128).optional(),
        brief: z.string().min(1).max(4000),
        design_notes: z.array(z.string().min(1).max(1000)).max(128).default([]),
        open_decisions: z.array(decisionSchema).max(128).default([]),
        concept_files: z.array(fileSchema).min(1).max(8),
      }),
      outputSchema: adoptionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/fileParams": ["concept_files"],
      },
    },
    async ({
      project_id,
      intent_revision_id,
      brief,
      design_notes,
      open_decisions,
      concept_files,
    }) => {
      try {
        const images: VisualSourceAsset[] = [];
        for (const file of concept_files) {
          const downloaded = await downloadChatGptVisualFile({
            downloadUrl: file.download_url,
            fileId: file.file_id,
            ...(file.mime_type === undefined ? {} : { mimeType: file.mime_type }),
            ...(file.file_name === undefined ? {} : { fileName: file.file_name }),
            role: "concept",
          });
          images.push({
            assetId: `adopted-concept-${randomUUID()}`,
            sha256: downloaded.sha256,
            mediaType: downloaded.mediaType,
            role: "concept",
            bytes: downloaded.bytes,
          });
        }
        const decisions: VisualDecision[] = open_decisions.map((decision) => ({
          id: decision.id,
          prompt: decision.prompt,
          required: decision.required,
          status: decision.status,
          ...(decision.answer === undefined ? {} : { answer: decision.answer }),
        }));
        const output = adopter.adoptConcept({
          projectId: project_id,
          ...(intent_revision_id === undefined ? {} : { intentRevisionId: intent_revision_id }),
          brief,
          designNotes: design_notes,
          openDecisions: decisions,
          conceptImages: images,
        });
        const concept = output.visual_concept as Record<string, unknown>;
        const urls = publicArtifactUrls(concept, options.publicBaseUrl);
        return result({
          ...output,
          provider: {
            provider_id: "host-provided",
            model_id: "unattested-host-visual",
          },
          ...(Object.keys(urls).length > 0 ? { artifact_urls: urls } : {}),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return adopter;
}
