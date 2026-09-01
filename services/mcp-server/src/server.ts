import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { CadDeskRuntime } from "./runtime.js";
import type { JsonObject } from "./types.js";

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

export function createCadDeskServer(runtime = new CadDeskRuntime()): McpServer {
  const server = new McpServer({ name: "cad3mf", version: "0.1.0" });

  server.registerResource(
    "cad-ir-schema",
    "caddesk://schema/cad-ir/0.1",
    {
      title: "CAD3MF CAD-IR 0.1 JSON Schema",
      description: "Canonical schema for CAD-IR documents accepted by create_design.",
      mimeType: "application/schema+json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/schema+json", text: JSON.stringify(runtime.cadIrSchema()) }],
    }),
  );

  server.registerTool(
    "create_design",
    {
      title: "Create CAD design",
      description:
        "Create revision r1 from a validated CAD-IR document. The host model should translate the user's natural-language design intent into CAD-IR 0.1; read caddesk://schema/cad-ir/0.1 for the canonical schema. Arbitrary Python is never accepted.",
      inputSchema: z.object({
        project_id: z.string().min(1).optional(),
        design_spec: z.string().min(1),
        units: z.literal("mm").default("mm"),
        manufacturing_process: z.literal("fdm").default("fdm"),
        material: z.string().min(1).default("PETG"),
        cad_ir: z.record(z.string(), z.unknown()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, design_spec, units, manufacturing_process, material, cad_ir }) => {
      try {
        return result(
          runtime.createDesign({
            ...(project_id === undefined ? {} : { projectId: project_id }),
            designSpec: design_spec,
            units,
            manufacturingProcess: manufacturing_process,
            material,
            cadIr: cad_ir,
          }),
        );
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
        "Create a new immutable revision from an existing revision. M0 intentionally supports only set_parameter; feature-tree mutation operations are added after the golden path is stable.",
      inputSchema: z.object({
        project_id: z.string().min(1),
        base_revision_id: z.string().min(1).optional(),
        change: z.object({
          operation: z.literal("set_parameter"),
          name: z.string().min(1),
          value: z.number().finite(),
        }),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ project_id, base_revision_id, change }) => {
      try {
        return result(
          runtime.modifyDesign({
            projectId: project_id,
            ...(base_revision_id === undefined ? {} : { baseRevisionId: base_revision_id }),
            change: { operation: "set_parameter", name: change.name, value: change.value },
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "inspect_design",
    {
      title: "Inspect CAD design",
      description: "Read parameters, feature tree, and geometry summary for a project revision.",
      inputSchema: z.object(revisionSelector),
      annotations: { readOnlyHint: true, openWorldHint: false },
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
      description: "Return the GLB/TJS preview artifact URI for a project revision.",
      inputSchema: z.object(revisionSelector),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project_id, revision_id }) => {
      try {
        return result(runtime.renderDesign(project_id, revision_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "validate_design",
    {
      title: "Validate CAD design",
      description: "Return cached OpenCascade geometry validation for a project revision.",
      inputSchema: z.object(revisionSelector),
      annotations: { readOnlyHint: true, openWorldHint: false },
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
      description: "Return the already-built STEP, STL, or 3MF artifact for a project revision.",
      inputSchema: z.object({
        ...revisionSelector,
        format: z.enum(["step", "stl", "3mf"]),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project_id, revision_id, format }) => {
      try {
        return result(runtime.exportDesign(project_id, format, revision_id));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
