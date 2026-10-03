import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { AssemblyRuntime } from "./assembly-runtime.js";
import type { JsonObject } from "./types.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());

function schemaText(relativePath: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(process.env.CAD3MF_REPO_ROOT ?? resolve(moduleDir, "../../.."));
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
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

const transformSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  rotate_x: z.number().finite(),
  rotate_y: z.number().finite(),
  rotate_z: z.number().finite(),
});

const partSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
  source_kind: z.enum(["cad_ir", "asset_ir", "assembly_ir"]),
  source_ref: z.string().min(1).max(256),
  source_artifact_sha256: z
    .string()
    .regex(/^[a-fA-F0-9]{64}$/)
    .nullable()
    .optional(),
  role: z.enum([
    "structural",
    "shell",
    "figurine",
    "base",
    "connector",
    "decorative",
    "replaceable_module",
    "other",
  ]),
  transform: transformSchema,
  required_for_product: z.boolean().optional(),
});

const interfaceSpecSchema = z.object({
  clearance_mm: z.number().nonnegative().finite().nullable().optional(),
  tolerance_mm: z.number().nonnegative().finite().nullable().optional(),
  magnet_diameter_mm: z.number().positive().finite().nullable().optional(),
  magnet_depth_mm: z.number().positive().finite().nullable().optional(),
  peg_diameter_mm: z.number().positive().finite().nullable().optional(),
  engagement_depth_mm: z.number().positive().finite().nullable().optional(),
  screw_standard: z.string().max(64).nullable().optional(),
  adhesive_gap_mm: z.number().nonnegative().finite().nullable().optional(),
});

const interfaceSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
  type: z.enum([
    "magnetic_mount",
    "snap_fit",
    "peg_socket",
    "screw",
    "dovetail",
    "press_fit",
    "glue",
    "free_placement",
  ]),
  part_a: z.string().min(1).max(128),
  part_b: z.string().min(1).max(128),
  spec: interfaceSpecSchema.optional(),
});

export function registerAssemblyV02(
  server: McpServer,
  options: { runtime?: AssemblyRuntime } = {},
): AssemblyRuntime {
  const runtime = options.runtime ?? new AssemblyRuntime();

  for (const [name, uri, path, title] of [
    [
      "assembly-ir-schema",
      "caddesk://schema/assembly-ir/0.1.0",
      "packages/assembly-ir/schemas/assembly-ir-0.1.0.json",
      "CAD3MF Assembly IR 0.1.0",
    ],
    [
      "assembly-validation-report-schema",
      "caddesk://schema/assembly-validation-report/0.1.0",
      "packages/assembly-ir/schemas/assembly-validation-report-0.1.0.json",
      "CAD3MF Assembly Validation Report 0.1.0",
    ],
  ] as const) {
    server.registerResource(
      name,
      uri,
      { title, mimeType: "application/schema+json" },
      async (resourceUri) => ({
        contents: [
          {
            uri: resourceUri.href,
            mimeType: "application/schema+json",
            text: schemaText(path),
          },
        ],
      }),
    );
  }

  server.registerTool(
    "define_assembly",
    {
      title: "Define product assembly",
      description:
        "Create an immutable Assembly-IR revision from CAD, imported Asset-IR, or nested Assembly-IR parts. Interfaces are declarative only; no executable CAD payload is accepted.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        product_type: z.enum([
          "figurine_with_base",
          "modular_tank",
          "modular_vehicle",
          "multi_part_product",
          "hybrid",
          "other",
        ]),
        parts: z.array(partSchema).min(1).max(512),
        interfaces: z.array(interfaceSchema).max(512).optional(),
        notes: z.array(z.string().max(1000)).max(128).optional(),
      }),
      outputSchema: jsonObjectSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Building assembly graph…",
        "openai/toolInvocation/invoked": "Assembly graph ready",
      },
    },
    async ({ project_id, product_type, parts, interfaces, notes }) => {
      try {
        return result(
          runtime.defineAssembly({
            projectId: project_id,
            productType: product_type,
            parts: parts.map((part) => ({
              id: part.id,
              sourceKind: part.source_kind,
              sourceRef: part.source_ref,
              ...(part.source_artifact_sha256 === undefined
                ? {}
                : { sourceArtifactSha256: part.source_artifact_sha256 }),
              role: part.role,
              transform: {
                x: part.transform.x,
                y: part.transform.y,
                z: part.transform.z,
                rotateX: part.transform.rotate_x,
                rotateY: part.transform.rotate_y,
                rotateZ: part.transform.rotate_z,
              },
              ...(part.required_for_product === undefined
                ? {}
                : { requiredForProduct: part.required_for_product }),
            })),
            ...(interfaces === undefined
              ? {}
              : {
                  interfaces: interfaces.map((item) => ({
                    id: item.id,
                    type: item.type,
                    partA: item.part_a,
                    partB: item.part_b,
                    ...(item.spec === undefined
                      ? {}
                      : {
                          spec: {
                            ...(item.spec.clearance_mm === undefined
                              ? {}
                              : { clearanceMm: item.spec.clearance_mm }),
                            ...(item.spec.tolerance_mm === undefined
                              ? {}
                              : { toleranceMm: item.spec.tolerance_mm }),
                            ...(item.spec.magnet_diameter_mm === undefined
                              ? {}
                              : { magnetDiameterMm: item.spec.magnet_diameter_mm }),
                            ...(item.spec.magnet_depth_mm === undefined
                              ? {}
                              : { magnetDepthMm: item.spec.magnet_depth_mm }),
                            ...(item.spec.peg_diameter_mm === undefined
                              ? {}
                              : { pegDiameterMm: item.spec.peg_diameter_mm }),
                            ...(item.spec.engagement_depth_mm === undefined
                              ? {}
                              : { engagementDepthMm: item.spec.engagement_depth_mm }),
                            ...(item.spec.screw_standard === undefined
                              ? {}
                              : { screwStandard: item.spec.screw_standard }),
                            ...(item.spec.adhesive_gap_mm === undefined
                              ? {}
                              : { adhesiveGapMm: item.spec.adhesive_gap_mm }),
                          },
                        }),
                  })),
                }),
            ...(notes === undefined ? {} : { notes }),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_assembly",
    {
      title: "Get product assembly",
      description: "Read the latest or selected immutable Assembly-IR revision.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        revision_id: z.string().min(1).max(128).optional(),
      }),
      outputSchema: jsonObjectSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_id, revision_id }) => {
      try {
        return result(runtime.getAssembly(project_id, revision_id) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "validate_assembly",
    {
      title: "Validate product assembly",
      description:
        "Validate assembly reference integrity, required-part mechanical connectivity, and interface-specific minimum data. Missing engineering fit policy returns UNKNOWN rather than false PASS.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        revision_id: z.string().min(1).max(128).optional(),
      }),
      outputSchema: jsonObjectSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Validating assembly…",
        "openai/toolInvocation/invoked": "Assembly validated",
      },
    },
    async ({ project_id, revision_id }) => {
      try {
        return result(runtime.validateAssembly(project_id, revision_id) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_assembly_validation",
    {
      title: "Get assembly validation report",
      description: "Read the latest or selected persisted assembly validation report.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        report_id: z.string().min(1).max(128).optional(),
      }),
      outputSchema: jsonObjectSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_id, report_id }) => {
      try {
        return result(runtime.getValidationReport(project_id, report_id) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return runtime;
}
