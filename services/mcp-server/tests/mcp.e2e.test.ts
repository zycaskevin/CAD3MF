import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = resolve(TEST_DIR, "..");
const REPO_ROOT = resolve(TEST_DIR, "../../..");

function childEnv(dataDir: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.CAD3MF_DATA_DIR = dataDir;
  env.CAD3MF_REPO_ROOT = REPO_ROOT;
  env.CAD3MF_PYTHON = process.env.CAD3MF_PYTHON ?? "python";
  return env;
}

async function connect(dataDir: string): Promise<Client> {
  const client = new Client(
    { name: "cad3mf-m0-e2e", version: "0.1.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts"],
    cwd: SERVICE_DIR,
    env: childEnv(dataDir),
    stderr: "pipe",
  });
  await client.connect(transport);
  assert.equal(client.getProtocolEra(), "modern");
  return client;
}

function structured(result: {
  structuredContent?: unknown;
  isError?: boolean | undefined;
}): Record<string, unknown> {
  assert.notEqual(result.isError, true);
  assert.equal(typeof result.structuredContent, "object");
  assert.notEqual(result.structuredContent, null);
  return result.structuredContent as Record<string, unknown>;
}

function withForbiddenExpression(fixture: Record<string, unknown>): Record<string, unknown> {
  const unsafe = structuredClone(fixture);
  const bodies = unsafe.bodies;
  if (!Array.isArray(bodies)) throw new Error("fixture has no bodies array");
  const firstBody = bodies[0];
  if (typeof firstBody !== "object" || firstBody === null) {
    throw new Error("fixture has no first body");
  }
  const features = (firstBody as Record<string, unknown>).features;
  if (!Array.isArray(features)) throw new Error("fixture has no feature array");
  const firstFeature = features[0];
  if (typeof firstFeature !== "object" || firstFeature === null) {
    throw new Error("fixture has no first feature");
  }
  (firstFeature as Record<string, unknown>).width = "$width / 2";
  return unsafe;
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  assert.equal(typeof value, "object", message);
  assert.notEqual(value, null, message);
  return value as Record<string, unknown>;
}

function assertFileParamTool(
  tool: { name: string; _meta?: unknown; inputSchema: unknown },
  field: string,
  extraProperties: string[] = [],
): void {
  const meta = asObject(tool._meta, `${tool.name} has no _meta`);
  assert.deepEqual(meta["openai/fileParams"], [field]);
  const input = asObject(tool.inputSchema, `${tool.name} has no input schema`);
  const properties = asObject(input.properties, `${tool.name} input has no properties`);
  const fileArray = asObject(properties[field], `${field} schema is missing`);
  const items = asObject(fileArray.items, `${field} item schema is missing`);
  const itemProperties = asObject(items.properties, `${field} item properties are missing`);
  assert.deepEqual(Object.keys(itemProperties).sort(), [
    "download_url",
    "file_id",
    "file_name",
    "mime_type",
    ...extraProperties,
  ].sort());
  const required = items.required;
  assert(Array.isArray(required));
  assert.deepEqual([...required].sort(), ["download_url", "file_id"]);
}

test("M0 MCP golden path persists revisions across server restarts", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-mcp-"));
  const fixture = JSON.parse(
    await readFile(resolve(REPO_ROOT, "tests/golden-models/magnet_module.v1.json"), "utf8"),
  ) as Record<string, unknown>;

  let projectId = "";
  const client = await connect(dataDir);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "adopt_visual_concept",
        "analyze_visual_input",
        "confirm_design",
        "create_design",
        "export_design",
        "generate_concept",
        "generate_mesh",
        "generate_turnaround",
        "get_mesh_asset",
        "get_mesh_job",
        "get_visual_job",
        "inspect_design",
        "modify_design",
        "render_design",
        "validate_design",
      ],
    );

    const analyzeTool = tools.find((tool) => tool.name === "analyze_visual_input");
    assert(analyzeTool);
    assertFileParamTool(analyzeTool, "source_files", ["role"]);

    const adoptTool = tools.find((tool) => tool.name === "adopt_visual_concept");
    assert(adoptTool);
    assertFileParamTool(adoptTool, "concept_files");

    const generateMeshTool = tools.find((tool) => tool.name === "generate_mesh");
    assert(generateMeshTool);
    const meshInput = asObject(generateMeshTool.inputSchema, "generate_mesh has no input schema");
    const meshProperties = asObject(meshInput.properties, "generate_mesh input has no properties");
    assert.equal("asset_kind" in meshProperties, true);
    assert.equal("output_format" in meshProperties, true);

    const { resources } = await client.listResources();
    assert.equal(resources.some((resource) => resource.uri === "caddesk://schema/cad-ir/0.1"), true);
    assert.equal(
      resources.some((resource) => resource.uri === "caddesk://schema/visual-concept/0.1.0"),
      true,
    );
    assert.equal(
      resources.some((resource) => resource.uri === "caddesk://schema/turnaround-set/0.1.0"),
      true,
    );
    assert.equal(
      resources.some((resource) => resource.uri === "caddesk://schema/mesh-generation-request/0.1.0"),
      true,
    );
    assert.equal(
      resources.some((resource) => resource.uri === "caddesk://schema/mesh-artifact/0.1.0"),
      true,
    );
    assert.equal(resources.some((resource) => resource.uri === "caddesk://schema/asset-ir/0.1.0"), true);

    const schemaResult = await client.readResource({ uri: "caddesk://schema/cad-ir/0.1" });
    const schemaContent = schemaResult.contents[0];
    assert(schemaContent && "text" in schemaContent && typeof schemaContent.text === "string");
    const schema = JSON.parse(schemaContent.text) as Record<string, unknown>;
    assert.equal(schema.type, "object");

    const visualSchemaResult = await client.readResource({
      uri: "caddesk://schema/visual-concept/0.1.0",
    });
    const visualSchemaContent = visualSchemaResult.contents[0];
    assert(
      visualSchemaContent &&
        "text" in visualSchemaContent &&
        typeof visualSchemaContent.text === "string",
    );
    const visualSchema = JSON.parse(visualSchemaContent.text) as Record<string, unknown>;
    assert.equal(visualSchema.type, "object");

    const meshSchemaResult = await client.readResource({
      uri: "caddesk://schema/mesh-artifact/0.1.0",
    });
    const meshSchemaContent = meshSchemaResult.contents[0];
    assert(meshSchemaContent && "text" in meshSchemaContent && typeof meshSchemaContent.text === "string");
    const meshSchema = JSON.parse(meshSchemaContent.text) as Record<string, unknown>;
    assert.equal(meshSchema.type, "object");

    const traversalAttempt = await client.callTool({
      name: "create_design",
      arguments: {
        project_id: "../escape",
        design_spec: "path traversal must be rejected",
        units: "mm",
        manufacturing_process: "fdm",
        material: "PETG",
        cad_ir: fixture,
      },
    });
    assert.equal(traversalAttempt.isError, true);

    const expressionAttempt = await client.callTool({
      name: "create_design",
      arguments: {
        project_id: "unsafe-expression",
        design_spec: "arbitrary expressions must be rejected",
        units: "mm",
        manufacturing_process: "fdm",
        material: "PETG",
        cad_ir: withForbiddenExpression(fixture),
      },
    });
    assert.equal(expressionAttempt.isError, true);
    const expressionError = expressionAttempt.content.find((item) => item.type === "text");
    assert(expressionError && expressionError.type === "text");
    assert.match(expressionError.text, /expressions are forbidden/);

    const rejectedProject = await client.callTool({
      name: "inspect_design",
      arguments: { project_id: "unsafe-expression" },
    });
    assert.equal(rejectedProject.isError, true);

    const created = structured(
      await client.callTool({
        name: "create_design",
        arguments: {
          design_spec:
            "60 × 40 × 8 mm magnet module with two 6.2 × 3.2 mm pockets and left/right dovetail connectors",
          units: "mm",
          manufacturing_process: "fdm",
          material: "PETG",
          cad_ir: fixture,
        },
      }),
    );
    projectId = String(created.project_id);
    assert.match(projectId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    assert.equal(created.revision_id, "r1");

    const modified = structured(
      await client.callTool({
        name: "modify_design",
        arguments: {
          project_id: projectId,
          change: { operation: "set_parameter", name: "magnet_diameter", value: 8 },
        },
      }),
    );
    assert.equal(modified.revision_id, "r2");
    assert.equal(modified.parent_revision_id, "r1");

    const inspected = structured(
      await client.callTool({ name: "inspect_design", arguments: { project_id: projectId } }),
    );
    assert.equal(inspected.revision_id, "r2");
    const parameters = inspected.parameters as Record<string, number>;
    assert.equal(parameters.magnet_diameter, 8);

    const validated = structured(
      await client.callTool({ name: "validate_design", arguments: { project_id: projectId } }),
    );
    const validation = validated.validation as Record<string, unknown>;
    assert.equal(validation.pass, true);
    assert.equal(validation.solid_count, 1);

    const rendered = structured(
      await client.callTool({ name: "render_design", arguments: { project_id: projectId } }),
    );
    assert.match(String(rendered.preview_uri), /^file:/);

    const exported = structured(
      await client.callTool({
        name: "export_design",
        arguments: { project_id: projectId, format: "3mf" },
      }),
    );
    assert.equal(exported.format, "3mf");
    assert.match(String(exported.artifact_uri), /^file:/);
  } finally {
    await client.close();
  }

  const restarted = await connect(dataDir);
  try {
    const inspected = structured(
      await restarted.callTool({ name: "inspect_design", arguments: { project_id: projectId } }),
    );
    assert.equal(inspected.revision_id, "r2");
    const parameters = inspected.parameters as Record<string, number>;
    assert.equal(parameters.magnet_diameter, 8);
  } finally {
    await restarted.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
