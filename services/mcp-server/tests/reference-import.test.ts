import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  downloadReferenceMeshFile,
  isPrivateMeshNetworkAddress,
  type DownloadedReferenceMesh,
  type ReferenceMeshFileParam,
} from "../src/mesh-file-ingest.js";
import { MeshRuntime } from "../src/mesh-runtime.js";

function minimalGlb(): Uint8Array {
  const bytes = Buffer.alloc(12);
  bytes.write("glTF", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(12, 8);
  return new Uint8Array(bytes);
}

test("v0.2 imports a Meshy-style GLB as external reference without fake intent provenance", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-reference-import-"));
  try {
    const bytes = minimalGlb();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const downloader = async (
      input: ReferenceMeshFileParam,
    ): Promise<DownloadedReferenceMesh> => ({
      bytes,
      sha256,
      format: "glb",
      mediaType: "model/gltf-binary",
      fileId: input.fileId,
      fileName: input.fileName ?? null,
    });

    const runtime = new MeshRuntime({ dataDir, referenceDownloader: downloader });
    const output = await runtime.importReferenceAsset({
      projectId: "ai-tank-v02",
      assetKind: "vehicle_shell",
      sourceFile: {
        downloadUrl: "https://assets.example.test/tank.glb",
        fileId: "meshy-task-123",
        fileName: "tank-shell.glb",
        format: "glb",
      },
      sourceProvider: "meshy",
      sourceModel: "external-3d-generator",
      targetDimensions: [{ name: "target_length", value: 160, unit: "mm" }],
    });

    const job = output.job as Record<string, unknown>;
    const mesh = output.mesh_artifact as Record<string, unknown>;
    const asset = output.asset_ir as Record<string, unknown>;
    const source = asset.source as Record<string, unknown>;
    const provenance = asset.provenance as Record<string, unknown>;
    const geometry = asset.geometry_artifact as Record<string, unknown>;

    assert.equal(job.job_kind, "geometry_import");
    assert.equal(job.status, "succeeded");
    assert.equal(mesh.status, "reference_imported");
    assert.equal(mesh.sha256, sha256);

    assert.equal(asset.schema_version, "0.2.0");
    assert.equal(asset.asset_type, "vehicle_shell");
    assert.equal(asset.status, "reference_imported");
    assert.equal(source.kind, "external_reference");
    assert.equal(source.external_file_id, "meshy-task-123");
    assert.equal(source.design_intent_revision_id, null);
    assert.equal("source_intent_revision_id" in asset, false);
    assert.equal(provenance.generator_kind, "manual_import");
    assert.equal(provenance.provider, "meshy");
    assert.equal(geometry.sha256, sha256);

    const dimensions = asset.target_dimensions as Array<Record<string, unknown>>;
    assert.deepEqual(dimensions, [{ name: "target_length", value: 160, unit: "mm" }]);

    const restarted = new MeshRuntime({ dataDir, referenceDownloader: downloader });
    const persisted = restarted.getAsset("ai-tank-v02");
    assert.equal(persisted.status, "reference_imported");
    assert.equal(
      (persisted.geometry_artifact as Record<string, unknown>).sha256,
      sha256,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("reference import rejects an invalid project id before downloading", async () => {
  let called = false;
  const runtime = new MeshRuntime({
    referenceDownloader: async () => {
      called = true;
      throw new Error("should not download");
    },
  });

  await assert.rejects(
    runtime.importReferenceAsset({
      projectId: "../escape",
      assetKind: "other",
      sourceFile: {
        downloadUrl: "https://example.com/model.glb",
        fileId: "x",
        format: "glb",
      },
    }),
    /invalid project_id/,
  );
  assert.equal(called, false);
});

test("reference mesh network guard classifies private addresses", () => {
  assert.equal(isPrivateMeshNetworkAddress("127.0.0.1"), true);
  assert.equal(isPrivateMeshNetworkAddress("192.168.1.10"), true);
  assert.equal(isPrivateMeshNetworkAddress("10.0.0.5"), true);
  assert.equal(isPrivateMeshNetworkAddress("::1"), true);
  assert.equal(isPrivateMeshNetworkAddress("8.8.8.8"), false);
});

test("reference mesh downloader refuses non-HTTPS URLs before fetch", async () => {
  await assert.rejects(
    downloadReferenceMeshFile({
      downloadUrl: "http://example.com/model.glb",
      fileId: "file-1",
      format: "glb",
    }),
    /must use HTTPS/,
  );
});
