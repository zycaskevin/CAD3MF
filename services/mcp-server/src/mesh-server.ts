import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { MeshRuntime } from "./mesh-runtime.js";
import type { JsonObject } from "./types.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const meshOutputSchema = z.object({
  job: jsonObjectSchema,
  mesh_request: jsonObjectSchema,
  mesh_artifact: jsonObjectSchema,
  asset_ir: jsonObjectSchema,
  provider: jsonObjectSchema,
});

function schemaText(relativePath: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(process.env.CAD3MF_REPO_ROOT ?? resolve(moduleDir, "../../.."));
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function result(output: JsonObject) {
  return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
}

export function registerMeshM1(server: McpServer, options: { runtime?: MeshRuntime } = {}): MeshRuntime {
  const runtime = options.runtime ?? new MeshRuntime();

  for (const [name, uri, path, title] of [
    ["mesh-generation-request-schema", "caddesk://schema/mesh-generation-request/0.1.0", "packages/mesh-generation/schemas/mesh-generation-request-0.1.0.json", "CAD3MF Mesh Generation Request 0.1.0"],
    ["mesh-artifact-schema", "caddesk://schema/mesh-artifact/0.1.0", "packages/mesh-generation/schemas/mesh-artifact-0.1.0.json", "CAD3MF Mesh Artifact 0.1.0"],
    ["asset-ir-schema-m1", "caddesk://schema/asset-ir/0.1.0", "packages/asset-ir/schemas/asset-ir-0.1.0.json", "CAD3MF Asset-IR 0.1.0"],
  ] as const) {
    server.registerResource(name, uri, { title, mimeType: "application/schema+json" }, async (resourceUri) => ({
      contents: [{ uri: resourceUri.href, mimeType: "application/schema+json", text: schemaText(path) }],
    }));
  }

  server.registerTool(
    "generate_mesh",
    {
      title: "Generate 3D mesh asset",
      description: "Use this when an approved multi-view turnaround should be converted into a provider-generated 3D mesh and canonical Asset-IR. This does not claim printability.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        turnaround_revision_id: z.string().min(1).max(128).optional(),
        asset_kind: z.enum(["figurine", "character", "vehicle_shell", "hard_surface_shell", "product_shell", "decorative_part", "other"]),
        quality_tier: z.enum(["preview", "standard", "high"]).default("standard"),
        output_format: z.enum(["glb", "obj", "ply"]).default("ply"),
        texture_policy: z.enum(["none", "vertex_color", "pbr"]).default("none"),
        target_triangle_count: z.number().int().min(100).max(5000000).nullable().optional(),
      }),
      outputSchema: meshOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Generating 3D mesh…",
        "openai/toolInvocation/invoked": "3D mesh generated",
      },
    },
    async ({ project_id, turnaround_revision_id, asset_kind, quality_tier, output_format, texture_policy, target_triangle_count }) => {
      try {
        const output = await runtime.generateMesh({
          projectId: project_id,
          ...(turnaround_revision_id === undefined ? {} : { turnaroundRevisionId: turnaround_revision_id }),
          assetKind: asset_kind,
          qualityTier: quality_tier,
          outputFormat: output_format,
          texturePolicy: texture_policy,
          ...(target_triangle_count === undefined ? {} : { targetTriangleCount: target_triangle_count }),
        });
        return result({ ...output, provider: runtime.providerInfo() });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_mesh_asset",
    {
      title: "Get generated Asset-IR",
      description: "Read a generated Asset-IR revision for an M1-003 mesh asset.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        revision_id: z.string().min(1).max(128).optional(),
      }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, revision_id }) => {
      try {
        return result(runtime.getAsset(project_id, revision_id) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_mesh_job",
    {
      title: "Get mesh generation job",
      description: "Read a persisted M1-003 mesh-generation job manifest.",
      inputSchema: z.object({ job_id: z.string().min(1).max(128) }),
      outputSchema: jsonObjectSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ job_id }) => {
      try {
        return result(runtime.getJob(job_id) as unknown as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return runtime;
}
