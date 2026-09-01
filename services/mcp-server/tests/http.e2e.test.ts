import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = resolve(TEST_DIR, "..");
const REPO_ROOT = resolve(TEST_DIR, "../../..");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
  return port;
}

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`HTTP server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // Retry while the TypeScript process starts.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("timed out waiting for CAD3MF HTTP server");
}

function childEnv(dataDir: string, port: number, baseUrl: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    ...env,
    CAD3MF_DATA_DIR: dataDir,
    CAD3MF_REPO_ROOT: REPO_ROOT,
    CAD3MF_PYTHON: process.env.CAD3MF_PYTHON ?? "python",
    CAD3MF_HOST: "127.0.0.1",
    CAD3MF_PORT: String(port),
    CAD3MF_PUBLIC_BASE_URL: baseUrl,
  };
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

test("HTTP MCP serves the ChatGPT viewer and immutable CAD artifacts", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-http-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "src/http.ts"], {
    cwd: SERVICE_DIR,
    env: childEnv(dataDir, port, baseUrl),
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  let client: Client | null = null;
  try {
    await waitForHealth(baseUrl, child);
    client = new Client(
      { name: "cad3mf-http-e2e", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    assert.equal(client.getProtocolEra(), "modern");

    const { resources } = await client.listResources();
    assert.equal(resources.some((resource) => resource.uri === "ui://caddesk/viewer/v1.html"), true);
    const viewer = await client.readResource({ uri: "ui://caddesk/viewer/v1.html" });
    const content = viewer.contents[0];
    assert(content && "text" in content && typeof content.text === "string");
    assert.equal(content.mimeType, "text/html;profile=mcp-app");
    assert.match(content.text, /data-caddesk-viewer=["']v1["']/);

    const fixture = JSON.parse(
      await readFile(resolve(REPO_ROOT, "tests/golden-models/magnet_module.v1.json"), "utf8"),
    ) as Record<string, unknown>;
    const created = structured(
      await client.callTool({
        name: "create_design",
        arguments: {
          project_id: "http-magnet-module",
          design_spec: "60 × 40 × 8 mm magnet module",
          units: "mm",
          manufacturing_process: "fdm",
          material: "PETG",
          cad_ir: fixture,
        },
      }),
    );
    assert.equal(created.revision_id, "r1");
    assert.equal("artifacts" in created, false);
    const viewerData = created.viewer as Record<string, unknown>;
    assert.equal(viewerData.preview_url, `${baseUrl}/artifacts/http-magnet-module/r1/preview`);

    const previewResponse = await fetch(String(viewerData.preview_url));
    assert.equal(previewResponse.status, 200);
    assert.match(previewResponse.headers.get("content-type") ?? "", /^model\/gltf-binary/);
    const previewBytes = new Uint8Array(await previewResponse.arrayBuffer());
    assert.equal(new TextDecoder().decode(previewBytes.slice(0, 4)), "glTF");

    const modified = structured(
      await client.callTool({
        name: "modify_design",
        arguments: {
          project_id: "http-magnet-module",
          base_revision_id: "r1",
          change: { operation: "set_parameter", name: "magnet_diameter", value: 8 },
        },
      }),
    );
    assert.equal(modified.revision_id, "r2");
    assert.equal(modified.parent_revision_id, "r1");
    const parameters = modified.parameters as Record<string, number>;
    assert.equal(parameters.magnet_diameter, 8);

    const exported = structured(
      await client.callTool({
        name: "export_design",
        arguments: { project_id: "http-magnet-module", revision_id: "r2", format: "3mf" },
      }),
    );
    assert.equal(exported.artifact_url, `${baseUrl}/artifacts/http-magnet-module/r2/3mf`);
    assert.equal("artifact_path" in exported, false);
    const threeMf = await fetch(String(exported.artifact_url));
    assert.equal(threeMf.status, 200);
    assert.match(threeMf.headers.get("content-type") ?? "", /^model\/3mf/);
    const threeMfBytes = new Uint8Array(await threeMf.arrayBuffer());
    assert.equal(new TextDecoder().decode(threeMfBytes.slice(0, 2)), "PK");
  } finally {
    if (client) await client.close().catch(() => undefined);
    child.kill("SIGTERM");
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) return resolveExit();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    await rm(dataDir, { recursive: true, force: true });
  }

  assert.equal(child.exitCode === 0 || child.signalCode === "SIGTERM", true, stderr);
});
