import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { AssemblyRuntime } from "./assembly-runtime.js";
import { EngineeringRuntime } from "./engineering-runtime.js";
import { MeshRuntime } from "./mesh-runtime.js";
import type { JsonObject } from "./types.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const VIEWER_RESOURCE_URI = "ui://caddesk/viewer/v1.html";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function optionalRead(
  read: () => Record<string, unknown>,
): Record<string, unknown> | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function artifactUrl(publicBaseUrl: string, projectId: string, artifactId: string): string {
  const base = publicBaseUrl.endsWith("/") ? publicBaseUrl.slice(0, -1) : publicBaseUrl;
  return `${base}/mesh-artifacts/${encodeURIComponent(projectId)}/${encodeURIComponent(artifactId)}`;
}

function result(output: JsonObject) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

function uiToolMeta() {
  return {
    ui: { resourceUri: VIEWER_RESOURCE_URI, visibility: ["model", "app"] },
    "openai/outputTemplate": VIEWER_RESOURCE_URI,
    "openai/toolInvocation/invoking": "Preparing engineering view…",
    "openai/toolInvocation/invoked": "Engineering view ready",
  };
}

export function registerEngineeringViewV02(
  server: McpServer,
  options: {
    publicBaseUrl?: string;
    meshRuntime?: MeshRuntime;
    engineeringRuntime?: EngineeringRuntime;
    assemblyRuntime?: AssemblyRuntime;
  } = {},
): void {
  const meshRuntime = options.meshRuntime ?? new MeshRuntime();
  const engineeringRuntime = options.engineeringRuntime ?? new EngineeringRuntime();
  const assemblyRuntime = options.assemblyRuntime ?? new AssemblyRuntime();

  server.registerTool(
    "render_engineering_view",
    {
      title: "Render engineering view",
      description:
        "Open an imported/generated Asset-IR in the CADDesk viewer with the selected/latest engineering envelopes, interference report, and assembly validation context. This view visualizes declared engineering data and does not upgrade approximate checks into exact geometry evidence.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        asset_revision_id: z.string().min(1).max(128).optional(),
        envelope_revision_id: z.string().min(1).max(128).optional(),
        assembly_revision_id: z.string().min(1).max(128).optional(),
      }),
      outputSchema: jsonObjectSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: uiToolMeta(),
    },
    async ({
      project_id,
      asset_revision_id,
      envelope_revision_id,
      assembly_revision_id,
    }) => {
      try {
        if (!options.publicBaseUrl) {
          throw new Error("render_engineering_view requires the HTTP/App deployment");
        }

        const asset = meshRuntime.getAsset(project_id, asset_revision_id);
        const geometry = asRecord(asset.geometry_artifact);
        const artifactId = String(geometry.artifact_id ?? "");
        const expectedSha = String(geometry.sha256 ?? "");
        if (!artifactId || !expectedSha) {
          throw new Error("Asset-IR geometry artifact provenance is incomplete");
        }
        const stored = meshRuntime.artifactLocation(project_id, artifactId);
        if (stored.sha256 !== expectedSha) {
          throw new Error("Asset-IR geometry artifact digest mismatch");
        }

        const envelopes = optionalRead(() =>
          engineeringRuntime.getEnvelopeSet(project_id, envelope_revision_id),
        );
        const interference = optionalRead(() =>
          engineeringRuntime.getInterferenceReport(project_id),
        );
        const assembly = optionalRead(() =>
          assemblyRuntime.getAssembly(project_id, assembly_revision_id),
        );
        const assemblyValidation = optionalRead(() =>
          assemblyRuntime.getValidationReport(project_id),
        );

        const envelopeRevision =
          envelopes && typeof envelopes.revision_id === "string"
            ? envelopes.revision_id
            : null;
        const assemblyRevision =
          assembly && typeof assembly.revision_id === "string"
            ? assembly.revision_id
            : null;

        const interferenceStale =
          interference !== null &&
          envelopeRevision !== null &&
          interference.source_revision_id !== envelopeRevision;
        const assemblyValidationStale =
          assemblyValidation !== null &&
          assemblyRevision !== null &&
          assemblyValidation.source_revision_id !== assemblyRevision;

        return result({
          view_kind: "engineering",
          project_id,
          asset_revision_id: asset.revision_id,
          asset_type: asset.asset_type,
          target_dimensions: asset.target_dimensions ?? [],
          geometry_artifact: geometry,
          viewer: {
            preview_url: artifactUrl(options.publicBaseUrl, project_id, artifactId),
          },
          envelope_set: envelopes,
          interference_report: interference,
          interference_report_stale: interferenceStale,
          assembly,
          assembly_validation: assemblyValidation,
          assembly_validation_stale: assemblyValidationStale,
          evidence_note:
            "Engineering overlays visualize declared IR. AABB/cylinder checks remain approximate where the report says approximate=true; this view is not exact BREP proof.",
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
