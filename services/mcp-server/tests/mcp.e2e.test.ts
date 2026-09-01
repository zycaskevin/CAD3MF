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
        "create_design",
        "export_design",
        "inspect_design",
        "modify_design",
        "render_design",
        "validate_design",
      ],
    );

    const { resources } = await client.listResources();
    assert.equal(resources.some((resource) => resource.uri === "caddesk://schema/cad-ir/0.1"), true);
    const schemaResult = await client.readResource({ uri: "caddesk://schema/cad-ir/0.1" });
    const schemaContent = schemaResult.contents[0];
    assert(schemaContent && "text" in schemaContent && typeof schemaContent.text === "string");
    const schema = JSON.parse(schemaContent.text) as Record<string, unknown>;
    assert.equal(schema.type, "object");

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
