import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { AssemblyRuntime } from "../src/assembly-runtime.js";
import { EngineeringRuntime } from "../src/engineering-runtime.js";
import { MeshStore } from "../src/mesh-store.js";

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
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited early with code ${child.exitCode}`);
    }
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

async function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  return await new Promise<number>((resolveStatus, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolveStatus(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
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

test("HTTP MCP serves the ChatGPT viewer and immutable CAD/visual artifacts", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-http-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const engineeringProjectId = "http-engineering-tank";
  const engineeringArtifactId = "mesh-http-engineering";
  const engineeringArtifactDir = join(
    dataDir,
    "mesh-artifacts",
    engineeringProjectId,
  );
  await mkdir(engineeringArtifactDir, { recursive: true });
  const engineeringArtifactPath = join(
    engineeringArtifactDir,
    `${engineeringArtifactId}.glb`,
  );
  const engineeringGlb = Buffer.alloc(12);
  engineeringGlb.write("glTF", 0, "ascii");
  engineeringGlb.writeUInt32LE(2, 4);
  engineeringGlb.writeUInt32LE(12, 8);
  await writeFile(engineeringArtifactPath, engineeringGlb);
  const engineeringSha = createHash("sha256").update(engineeringGlb).digest("hex");
  const createdAt = "2026-10-03T16:30:00Z";

  const meshStore = new MeshStore(join(dataDir, "mesh.sqlite"));
  meshStore.saveArtifact({
    projectId: engineeringProjectId,
    artifactId: engineeringArtifactId,
    path: engineeringArtifactPath,
    sha256: engineeringSha,
    format: "glb",
    mediaType: "model/gltf-binary",
    createdAt,
  });
  meshStore.addDocument(
    engineeringProjectId,
    "asset_ir",
    "asset-r1",
    {
      schema_version: "0.2.0",
      asset_id: "asset-http-engineering-tank",
      project_id: engineeringProjectId,
      revision_id: "asset-r1",
      parent_revision_id: null,
      source: {
        kind: "external_reference",
        design_intent_revision_id: null,
        turnaround_revision_id: null,
        external_file_id: "fixture-http-engineering",
      },
      asset_type: "vehicle_shell",
      units: "mm",
      style: null,
      pose: null,
      target_dimensions: [{ name: "target_length", value: 160, unit: "mm" }],
      geometry_artifact: {
        artifact_id: engineeringArtifactId,
        sha256: engineeringSha,
        format: "glb",
        media_type: "model/gltf-binary",
        vertex_count: null,
        triangle_count: null,
      },
      regions: [],
      print_constraints: {
        minimum_wall_thickness_mm: 1.6,
        minimum_feature_size_mm: 1,
        base_required: false,
        target_height_mm: null,
        maximum_overhang_deg: null,
      },
      provenance: {
        generator_kind: "manual_import",
        provider: "fixture",
        model: "fixture",
        model_version: null,
        job_id: "fixture-job",
        input_artifact_sha256: [engineeringSha],
      },
      status: "reference_imported",
    },
    createdAt,
  );

  const engineeringRuntime = new EngineeringRuntime({ dataDir });
  engineeringRuntime.defineEnvelopeSet({
    projectId: engineeringProjectId,
    sourceAssetRevisionId: "asset-r1",
    coordinateFrame: { name: "tank-chassis", originPolicy: "chassis_origin" },
    envelopes: [
      {
        id: "battery-clearance",
        semanticRole: "keep_out",
        componentRole: "battery",
        shape: { kind: "box", x: 60, y: 30, z: 18 },
        transform: { x: -50, y: 0, z: 12, rotateX: 0, rotateY: 0, rotateZ: 0 },
      },
      {
        id: "pcb",
        semanticRole: "occupied",
        componentRole: "pcb",
        shape: { kind: "box", x: 45, y: 25, z: 4 },
        transform: { x: 50, y: 0, z: 16, rotateX: 0, rotateY: 0, rotateZ: 0 },
      },
    ],
  });
  engineeringRuntime.validateEnvelopeSet(engineeringProjectId);

  const assemblyRuntime = new AssemblyRuntime({ dataDir });
  assemblyRuntime.defineAssembly({
    projectId: engineeringProjectId,
    productType: "modular_tank",
    parts: [
      {
        id: "chassis",
        sourceKind: "cad_ir",
        sourceRef: "cad:r1",
        role: "structural",
        transform: { x: 0, y: 0, z: 0, rotateX: 0, rotateY: 0, rotateZ: 0 },
      },
      {
        id: "shell",
        sourceKind: "asset_ir",
        sourceRef: "asset-r1",
        sourceArtifactSha256: engineeringSha,
        role: "shell",
        transform: { x: 0, y: 0, z: 0, rotateX: 0, rotateY: 0, rotateZ: 0 },
      },
    ],
    interfaces: [
      {
        id: "shell-mount",
        type: "screw",
        partA: "chassis",
        partB: "shell",
        spec: { screwStandard: "M2" },
      },
    ],
  });
  assemblyRuntime.validateAssembly(engineeringProjectId);

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
    const rejectedMcp = await fetch(`${baseUrl}/mcp`, {
      headers: { origin: "https://unlisted-sandbox.oaiusercontent.com" },
    });
    assert.equal(rejectedMcp.status, 403);

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

    const previewResponse = await fetch(String(viewerData.preview_url), {
      headers: { origin: "null" },
    });
    assert.equal(previewResponse.status, 200);
    assert.equal(previewResponse.headers.get("access-control-allow-origin"), "*");
    assert.match(previewResponse.headers.get("content-type") ?? "", /^model\/gltf-binary/);
    const previewBytes = new Uint8Array(await previewResponse.arrayBuffer());
    assert.equal(new TextDecoder().decode(previewBytes.slice(0, 4)), "glTF");

    const rejectedArtifactHost = await requestStatus(String(viewerData.preview_url), {
      host: "attacker.invalid",
      origin: "null",
    });
    assert.equal(rejectedArtifactHost, 403);

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
    const threeMf = await fetch(String(exported.artifact_url), {
      headers: { origin: "https://unlisted-sandbox.oaiusercontent.com" },
    });
    assert.equal(threeMf.status, 200);
    assert.equal(threeMf.headers.get("access-control-allow-origin"), "*");
    assert.match(threeMf.headers.get("content-type") ?? "", /^model\/3mf/);
    const threeMfBytes = new Uint8Array(await threeMf.arrayBuffer());
    assert.equal(new TextDecoder().decode(threeMfBytes.slice(0, 2)), "PK");

    const engineeringView = structured(
      await client.callTool({
        name: "render_engineering_view",
        arguments: { project_id: engineeringProjectId },
      }),
    );
    assert.equal(engineeringView.view_kind, "engineering");
    assert.equal(engineeringView.asset_revision_id, "asset-r1");
    const engineeringViewer = engineeringView.viewer as Record<string, unknown>;
    assert.equal(
      engineeringViewer.preview_url,
      `${baseUrl}/mesh-artifacts/${engineeringProjectId}/${engineeringArtifactId}`,
    );
    const engineeringInterference = engineeringView.interference_report as Record<
      string,
      unknown
    >;
    assert.equal(engineeringInterference.status, "pass");
    assert.equal(engineeringView.interference_report_stale, false);
    const engineeringAssembly = engineeringView.assembly_validation as Record<
      string,
      unknown
    >;
    assert.equal(engineeringAssembly.status, "pass");
    assert.equal(engineeringView.assembly_validation_stale, false);
    const visualAlignment = engineeringView.visual_alignment as Record<string, unknown>;
    assert.equal(visualAlignment.mode, "normalize_longest_extent_center_ground");
    assert.equal(visualAlignment.target_value_mm, 160);
    assert.equal(visualAlignment.authoritative, false);

    const meshResponse = await fetch(String(engineeringViewer.preview_url), {
      headers: { origin: "null" },
    });
    assert.equal(meshResponse.status, 200);
    assert.equal(meshResponse.headers.get("access-control-allow-origin"), "*");
    assert.match(meshResponse.headers.get("content-type") ?? "", /^model\/gltf-binary/);
    const meshBytes = new Uint8Array(await meshResponse.arrayBuffer());
    assert.equal(createHash("sha256").update(meshBytes).digest("hex"), engineeringSha);

    const rejectedMeshHost = await requestStatus(String(engineeringViewer.preview_url), {
      host: "attacker.invalid",
      origin: "null",
    });
    assert.equal(rejectedMeshHost, 403);

    const sourceSha = "d".repeat(64);
    const analyzed = structured(
      await client.callTool({
        name: "analyze_visual_input",
        arguments: {
          project_id: "http-visual-figurine",
          product_kind: "figurine",
          design_prompt: "Create a stylized collectible figurine with a stable standing pose.",
          style: "chibi_collectible",
          requested_functions: ["stable_base"],
          source_assets: [
            {
              asset_id: "http-reference-1",
              sha256: sourceSha,
              media_type: "image/png",
              role: "identity_reference",
            },
          ],
          known_dimensions: [
            {
              name: "target_height",
              value: 120,
              unit: "mm",
              source: "user",
              confidence: 1,
            },
          ],
        },
      }),
    );
    const designIntent = analyzed.design_intent as Record<string, unknown>;
    assert.equal(designIntent.project_id, "http-visual-figurine");
    assert.equal(designIntent.status, "needs_confirmation");
    assert.equal("artifact_path" in analyzed, false);

    const generatedConcept = structured(
      await client.callTool({
        name: "generate_concept",
        arguments: { project_id: "http-visual-figurine" },
      }),
    );
    const visualConcept = generatedConcept.visual_concept as Record<string, unknown>;
    assert.equal(visualConcept.status, "needs_confirmation");
    assert.equal("artifact_path" in visualConcept, false);
    const visualArtifactUrls = generatedConcept.artifact_urls as Record<string, string>;
    const visualUrl = Object.values(visualArtifactUrls)[0];
    assert(visualUrl);
    assert.match(visualUrl, /^http:\/\/127\.0\.0\.1:\d+\/visual-artifacts\//);

    const visualImage = await fetch(visualUrl, { headers: { origin: "null" } });
    assert.equal(visualImage.status, 200);
    assert.equal(visualImage.headers.get("access-control-allow-origin"), "*");
    assert.match(visualImage.headers.get("content-type") ?? "", /^image\/png/);
    const visualBytes = new Uint8Array(await visualImage.arrayBuffer());
    assert.deepEqual([...visualBytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const rejectedVisualHost = await requestStatus(visualUrl, {
      host: "attacker.invalid",
      origin: "null",
    });
    assert.equal(rejectedVisualHost, 403);
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
