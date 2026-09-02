import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { registerMeshM1 } from "./mesh-server.js";
import { CadDeskRuntime } from "./runtime.js";
import type { JsonObject } from "./types.js";
import { registerHostVisualConceptAdoption } from "./visual-adoption-server.js";
import { registerVisualM1 } from "./visual-server.js";

export const VIEWER_RESOURCE_URI = "ui://caddesk/viewer/v1.html";
export const VIEWER_MIME_TYPE = "text/html;profile=mcp-app";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const parametersSchema = z.record(z.string(), z.number());
const snapshotSchema = z.object({
  project_id: z.string(),
  revision_id: z.string(),
  parent_revision_id: z.string().nullable(),
  parameters: parametersSchema,
  geometry_summary: jsonObjectSchema,
  viewer: z.object({ preview_url: z.string().url() }),
  artifact_urls: z.object({
    step: z.string().url(),
    stl: z.string().url(),
    "3mf": z.string().url(),
  }),
});

const inspectSchema = z.object({
  project_id: z.string(),
  revision_id: z.string(),
  parent_revision_id: z.string().nullable(),
  parameters: parametersSchema,
  feature_tree: z.array(z.unknown()),
  geometry_summary: jsonObjectSchema,
});

const validateSchema = z.object({
  project_id: z.string(),
  revision_id: z.string(),
  validation: jsonObjectSchema,
});

const exportSchema = z.object({
  project_id: z.string(),
  revision_id: z.string(),
  format: z.enum(["step", "stl", "3mf"]),
  artifact_url: z.string().url(),
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

const revisionSelector = {
  project_id: z.string().min(1),
  revision_id: z.string().min(1).optional(),
};

function artifactUrl(
  publicBaseUrl: string,
  projectId: string,
  revisionId: string,
  kind: "preview" | "step" | "stl" | "3mf",
): string {
  const base = publicBaseUrl.endsWith("/") ? publicBaseUrl.slice(0, -1) : publicBaseUrl;
  return `${base}/artifacts/${encodeURIComponent(projectId)}/${encodeURIComponent(revisionId)}/${kind}`;
}

function publicSnapshot(output: JsonObject, publicBaseUrl: string): JsonObject {
  const projectId = String(output.project_id);
  const revisionId = String(output.revision_id);
  return {
    project_id: projectId,
    revision_id: revisionId,
    parent_revision_id: output.parent_revision_id ?? null,
    parameters: output.parameters ?? {},
    geometry_summary: output.geometry_summary ?? {},
    viewer: { preview_url: artifactUrl(publicBaseUrl, projectId, revisionId, "preview") },
    artifact_urls: {
      step: artifactUrl(publicBaseUrl, projectId, revisionId, "step"),
      stl: artifactUrl(publicBaseUrl, projectId, revisionId, "stl"),
      "3mf": artifactUrl(publicBaseUrl, projectId, revisionId, "3mf"),
    },
  };
}

function viewerHtmlPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(process.env.CAD3MF_REPO_ROOT ?? resolve(moduleDir, "../../.."));
  return resolve(repoRoot, "apps/chatgpt-plugin/dist/caddesk-viewer.html");
}

function uiToolMeta() {
  return {
    ui: { resourceUri: VIEWER_RESOURCE_URI, visibility: ["model", "app"] },
    "openai/outputTemplate": VIEWER_RESOURCE_URI,
  };
}

export interface CadDeskServerOptions {
  publicBaseUrl?: string;
}

export function createCadDeskServer(
  runtime = new CadDeskRuntime(),
  options: CadDeskServerOptions = {},
): McpServer {
  const server = new McpServer({ name: "cad3mf", version: "0.1.0" });
  const publicBaseUrl = options.publicBaseUrl;
  const resourceOrigin = new URL(publicBaseUrl ?? "http://127.0.0.1:8787").origin;

  server.registerResource(
    "cad-ir-schema",
    "caddesk://schema/cad-ir/0.1",
    {
      title: "CAD3MF CAD-IR 0.1 JSON Schema",
      description: "Canonical schema for CAD-IR documents accepted by create_design.",
      mimeType: "application/schema+json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/schema+json",
          text: JSON.stringify(runtime.cadIrSchema()),
        },
      ],
    }),
  );

  server.registerResource(
    "caddesk-viewer",
    VIEWER_RESOURCE_URI,
    {
      title: "CADDesk interactive viewer",
      description: "Interactive Three.js viewer for CAD3MF project revisions.",
      mimeType: VIEWER_MIME_TYPE,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: VIEWER_MIME_TYPE,
          text: readFileSync(viewerHtmlPath(), "utf8"),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [resourceOrigin],
                resourceDomains: [resourceOrigin],
              },
            },
            "openai/widgetDescription":
              "Interactive parametric CAD viewer with revision, validation, parameters, and export actions.",
          },
        },
      ],
    }),
  );

  server.registerTool(
    "create_design",
    {
      title: "Create CAD design",
      description:
        "Use this when the user wants a new parametric CAD project. Translate the design intent into CAD-IR 0.1 using caddesk://schema/cad-ir/0.1, then call this tool. Arbitrary Python is never accepted.",
      inputSchema: z.object({
        project_id: z.string().min(1).optional(),
        design_spec: z.string().min(1),
        units: z.literal("mm").default("mm"),
        manufacturing_process: z.literal("fdm").default("fdm"),
        material: z.string().min(1).default("PETG"),
        cad_ir: z.record(z.string(), z.unknown()),
      }),
      ...(publicBaseUrl ? { outputSchema: snapshotSchema } : {}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ...uiToolMeta(),
        "openai/toolInvocation/invoking": "Building CAD model…",
        "openai/toolInvocation/invoked": "CAD model ready",
      },
    },
    async ({ project_id, design_spec, units, manufacturing_process, material, cad_ir }) => {
      try {
        const output = runtime.createDesign({
          ...(project_id === undefined ? {} : { projectId: project_id }),
          designSpec: design_spec,
          units,
          manufacturingProcess: manufacturing_process,
          material,
          cadIr: cad_ir,
        });
        return result(publicBaseUrl ? publicSnapshot(output, publicBaseUrl) : output);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "modify_design",
    {
      title: "Modify CAD design",
      description:
        "Use this when the user asks to change an existing parametric design. M0 supports set_parameter and always creates a new immutable revision.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        base_revision_id: z.string().min(1).optional(),
        change: z.object({
          operation: z.literal("set_parameter"),
          name: z.string().min(1),
          value: z.number().finite(),
        }),
      }),
      ...(publicBaseUrl ? { outputSchema: snapshotSchema } : {}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        ...uiToolMeta(),
        "openai/toolInvocation/invoking": "Rebuilding CAD revision…",
        "openai/toolInvocation/invoked": "CAD revision ready",
      },
    },
    async ({ project_id, base_revision_id, change }) => {
      try {
        const output = runtime.modifyDesign({
          projectId: project_id,
          ...(base_revision_id === undefined ? {} : { baseRevisionId: base_revision_id }),
          change: { operation: "set_parameter", name: change.name, value: change.value },
        });
        return result(publicBaseUrl ? publicSnapshot(output, publicBaseUrl) : output);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inspect_design",
    {
      title: "Inspect CAD design",
      description:
        "Use this when parameters, feature tree, or geometry summary are needed for a revision.",
      inputSchema: z.object(revisionSelector),
      outputSchema: inspectSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_id, revision_id }) => {
      try {
        return result(runtime.inspectDesign(project_id, revision_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "render_design",
    {
      title: "Render CAD design",
      description:
        "Use this when the user wants to view an existing CAD revision in the interactive viewer.",
      inputSchema: z.object(revisionSelector),
      ...(publicBaseUrl ? { outputSchema: snapshotSchema } : {}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: uiToolMeta(),
    },
    async ({ project_id, revision_id }) => {
      try {
        if (!publicBaseUrl) return result(runtime.renderDesign(project_id, revision_id));
        const inspected = runtime.inspectDesign(project_id, revision_id);
        return result(publicSnapshot(inspected, publicBaseUrl));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "validate_design",
    {
      title: "Validate CAD design",
      description: "Use this when geometry validity needs to be checked for a project revision.",
      inputSchema: z.object(revisionSelector),
      outputSchema: validateSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_id, revision_id }) => {
      try {
        return result(runtime.validateDesign(project_id, revision_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "export_design",
    {
      title: "Export CAD design",
      description: "Use this when the user wants the STEP, STL, or 3MF artifact for a revision.",
      inputSchema: z.object({
        ...revisionSelector,
        format: z.enum(["step", "stl", "3mf"]),
      }),
      ...(publicBaseUrl ? { outputSchema: exportSchema } : {}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_id, revision_id, format }) => {
      try {
        if (!publicBaseUrl) return result(runtime.exportDesign(project_id, format, revision_id));
        const artifact = runtime.artifactLocation(project_id, format, revision_id);
        return result({
          project_id: artifact.projectId,
          revision_id: artifact.revisionId,
          format,
          artifact_url: artifactUrl(publicBaseUrl, artifact.projectId, artifact.revisionId, format),
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  registerVisualM1(server, {
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
  });
  registerHostVisualConceptAdoption(server, {
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
  });
  registerMeshM1(server, {
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
  });

  return server;
}
