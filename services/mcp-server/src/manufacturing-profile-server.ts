import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { ManufacturingProfileRuntime } from "./manufacturing-profile-runtime.js";
import type { JsonObject } from "./types.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());

function schemaText(relativePath: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(process.env.CAD3MF_REPO_ROOT ?? resolve(moduleDir, "../../.."));
  return readFileSync(resolve(root, relativePath), "utf8");
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

export function registerManufacturingProfilesV02(
  server: McpServer,
  options: { runtime?: ManufacturingProfileRuntime } = {},
): ManufacturingProfileRuntime {
  const runtime = options.runtime ?? new ManufacturingProfileRuntime();

  server.registerResource(
    "manufacturing-profile-schema",
    "caddesk://schema/manufacturing-profile/0.1.0",
    {
      title: "CAD3MF Manufacturing Profile 0.1.0",
      mimeType: "application/schema+json",
    },
    async (resourceUri) => ({
      contents: [
        {
          uri: resourceUri.href,
          mimeType: "application/schema+json",
          text: schemaText(
            "packages/manufacturing/schemas/manufacturing-profile-0.1.0.json",
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "list_manufacturing_profiles",
    {
      title: "List manufacturing profiles",
      description:
        "List explicit CAD3MF manufacturing policies. Starter profiles are not machine-certified defaults.",
      inputSchema: z.object({}),
      outputSchema: z.object({ profiles: z.array(jsonObjectSchema) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => result({ profiles: runtime.listProfiles() }),
  );

  server.registerTool(
    "get_manufacturing_profile",
    {
      title: "Get manufacturing profile",
      description:
        "Read a manufacturing profile including its calibration/evidence status. Unverified starter values must not be represented as official printer specifications.",
      inputSchema: z.object({ profile_id: z.string().min(1).max(128) }),
      outputSchema: jsonObjectSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ profile_id }) => {
      try {
        return result(runtime.getProfile(profile_id) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "resolve_fit_policy",
    {
      title: "Resolve profile fit policy",
      description:
        "Resolve an explicit clearance/allowance value from a named manufacturing profile while preserving calibration warnings and evidence status.",
      inputSchema: z.object({
        profile_id: z.string().min(1).max(128),
        fit_kind: z.enum([
          "default_clearance",
          "loose_clearance",
          "snap_fit_allowance",
        ]),
      }),
      outputSchema: jsonObjectSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ profile_id, fit_kind }) => {
      try {
        return result(runtime.resolveFitPolicy(profile_id, fit_kind) as JsonObject);
      } catch (error) {
        return failure(error);
      }
    },
  );

  return runtime;
}
