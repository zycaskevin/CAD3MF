import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { EngineeringRuntime } from "./engineering-runtime.js";
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

const boxSchema = z.object({
  kind: z.literal("box"),
  x: z.number().positive().finite(),
  y: z.number().positive().finite(),
  z: z.number().positive().finite(),
});

const cylinderSchema = z.object({
  kind: z.literal("cylinder"),
  diameter: z.number().positive().finite(),
  height: z.number().positive().finite(),
  axis: z.literal("z"),
});

const envelopeSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,127}$/),
  semantic_role: z.enum(["occupied", "keep_out", "motion_swept", "required_contact"]),
  component_role: z.enum([
    "battery",
    "pcb",
    "motor",
    "camera",
    "tof",
    "speaker",
    "wiring",
    "chassis",
    "shell",
    "turret",
    "service_volume",
    "other",
  ]),
  shape: z.union([boxSchema, cylinderSchema]),
  transform: transformSchema,
  clearance_mm: z.number().nonnegative().finite().optional(),
  required: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export function registerEngineeringV02(
  server: McpServer,
  options: { runtime?: EngineeringRuntime } = {},
): EngineeringRuntime {
  const runtime = options.runtime ?? new EngineeringRuntime();

  for (const [name, uri, path, title] of [
    [
      "engineering-envelope-set-schema",
      "caddesk://schema/engineering-envelope-set/0.1.0",
      "packages/engineering/schemas/engineering-envelope-set-0.1.0.json",
      "CAD3MF Engineering Envelope Set 0.1.0",
    ],
    [
      "engineering-interference-report-schema",
      "caddesk://schema/engineering-interference-report/0.1.0",
      "packages/engineering/schemas/engineering-interference-report-0.1.0.json",
      "CAD3MF Engineering Interference Report 0.1.0",
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
    "define_engineering_envelopes",
    {
      title: "Define engineering envelopes",
      description:
        "Define occupied volumes, keep-out zones, motion swept volumes, and required-contact regions in millimeters for a product revision. Use this for battery, PCB, motor, camera, ToF, speaker, wiring, chassis, shell, turret, and service-volume constraints.",
      inputSchema: z.object({
        project_id: z.string().min(1).max(128),
        source_asset_revision_id: z.string().min(1).max(128).nullable().optional(),
        coordinate_frame: z
          .object({
            name: z.string().min(1).max(128),
            origin_policy: z.enum(["product_origin", "chassis_origin", "custom"]),
          })
          .optional(),
        envelopes: z.array(envelopeSchema).min(1).max(512),
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
        "openai/toolInvocation/invoking": "Defining engineering volumes…",
        "openai/toolInvocation/invoked": "Engineering volumes ready",
      },
    },
    async ({
      project_id,
      source_asset_revision_id,
      coordinate_frame,
      envelopes,
      notes,
    }) => {
      try {
        return result(
          runtime.defineEnvelopeSet({
            projectId: project_id,
            ...(source_asset_revision_id === undefined
              ? {}
              : { sourceAssetRevisionId: source_asset_revision_id }),
            ...(coordinate_frame === undefined
              ? {}
              : {
                  coordinateFrame: {
                    name: coordinate_frame.name,
                    originPolicy: coordinate_frame.origin_policy,
                  },
                }),
            envelopes: envelopes.map((envelope) => ({
              id: envelope.id,
              semanticRole: envelope.semantic_role,
              componentRole: envelope.component_role,
              shape: envelope.shape,
              transform: {
                x: envelope.transform.x,
                y: envelope.transform.y,
                z: envelope.transform.z,
                rotateX: envelope.transform.rotate_x,
                rotateY: envelope.transform.rotate_y,
                rotateZ: envelope.transform.rotate_z,
              },
              ...(envelope.clearance_mm === undefined
                ? {}
                : { clearanceMm: envelope.clearance_mm }),
              ...(envelope.required === undefined ? {} : { required: envelope.required }),
              ...(envelope.notes === undefined ? {} : { notes: envelope.notes }),
            })),
            ...(notes === undefined ? {} : { notes }),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_engineering_envelopes",
    {
      title: "Get engineering envelopes",
      description: "Read the latest or selected immutable engineering-envelope revision.",
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
        return result(runtime.getEnvelopeSet(project_id, revision_id) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "validate_engineering_envelopes",
    {
      title: "Validate engineering envelope interference",
      description:
        "Run the v0.2 conservative AABB interference gate over declared engineering envelopes. PASS/FAIL applies only to the declared envelope policy. Cylinders are conservative AABB approximations and unsupported rotations return UNKNOWN; this is not exact mesh/BREP collision.",
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
        "openai/toolInvocation/invoking": "Checking engineering interference…",
        "openai/toolInvocation/invoked": "Engineering interference checked",
      },
    },
    async ({ project_id, revision_id }) => {
      try {
        return result(runtime.validateEnvelopeSet(project_id, revision_id) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_engineering_report",
    {
      title: "Get engineering interference report",
      description: "Read the latest or selected persisted engineering interference report.",
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
        return result(runtime.getInterferenceReport(project_id, report_id) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return runtime;
}
