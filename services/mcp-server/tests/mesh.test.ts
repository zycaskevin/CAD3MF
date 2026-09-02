import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MeshRuntime } from "../src/mesh-runtime.js";
import { VisualStore } from "../src/visual-store.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3QAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

async function seedTurnaround(
  dataDir: string,
  projectId: string,
  productKind: "figurine" | "vehicle",
): Promise<string> {
  const store = new VisualStore(join(dataDir, "visual.sqlite"));
  const artifactDir = join(dataDir, "visual-artifacts", projectId);
  await mkdir(artifactDir, { recursive: true });
  const viewNames = ["front", "left", "right", "back", "three_quarter_front", "three_quarter_back"];
  const views = [];
  for (const view of viewNames) {
    const artifactId = `${projectId}-${view}`;
    const path = join(artifactDir, `${artifactId}.png`);
    await writeFile(path, PNG);
    store.saveArtifact({
      projectId,
      artifactId,
      path,
      sha256: PNG_SHA,
      mediaType: "image/png",
      createdAt: "2026-09-02T00:00:00Z",
    });
    views.push({
      view,
      artifact_id: artifactId,
      sha256: PNG_SHA,
      media_type: "image/png",
      projection: "orthographic_like",
      width_px: 1,
      height_px: 1,
      notes: null,
    });
  }
  const revisionId = "turnaround-r1";
  store.addDocument(
    projectId,
    "turnaround_set",
    revisionId,
    {
      schema_version: "0.1.0",
      turnaround_id: `turnaround-${projectId}`,
      project_id: projectId,
      revision_id: revisionId,
      parent_revision_id: null,
      source_concept_revision_id: "concept-r2",
      coverage_policy: "full_six_view",
      views,
      consistency: {
        pass: true,
        identity_score: 1,
        style_score: 1,
        silhouette_score: 1,
        warnings: [],
      },
      status: "accepted",
      provenance: {
        provider: "test",
        model: "fixture",
        job_id: "seed-job",
        input_artifact_sha256: [PNG_SHA],
      },
      created_at: "2026-09-02T00:00:00Z",
      updated_at: "2026-09-02T00:00:00Z",
      product_kind: productKind,
    },
    "2026-09-02T00:00:00Z",
  );
  return revisionId;
}

for (const testCase of [
  { name: "figurine", projectId: "mesh-figurine", assetKind: "figurine" as const },
  { name: "modular tank", projectId: "mesh-tank", assetKind: "vehicle_shell" as const },
]) {
  test(`M1-003 uses the same mesh pipeline for ${testCase.name}`, async () => {
    const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-mesh-"));
    try {
      const turnaroundRevisionId = await seedTurnaround(dataDir, testCase.projectId, testCase.name === "figurine" ? "figurine" : "vehicle");
      const runtime = new MeshRuntime({ dataDir });
      const output = await runtime.generateMesh({
        projectId: testCase.projectId,
        turnaroundRevisionId,
        assetKind: testCase.assetKind,
        outputFormat: "ply",
        texturePolicy: "none",
      });
      const mesh = output.mesh_artifact as Record<string, unknown>;
      const asset = output.asset_ir as Record<string, unknown>;
      const job = output.job as Record<string, unknown>;

      assert.equal(mesh.format, "ply");
      assert.equal(mesh.vertex_count, 8);
      assert.equal(mesh.triangle_count, 12);
      assert.match(String(mesh.sha256), /^[a-f0-9]{64}$/);
      assert.equal(asset.asset_type, testCase.assetKind);
      assert.equal(asset.status, "generated");
      assert.equal(job.status, "succeeded");
      assert.equal("printable" in mesh, false);

      const restarted = new MeshRuntime({ dataDir });
      const persisted = restarted.getAsset(testCase.projectId);
      assert.equal(persisted.asset_type, testCase.assetKind);
      assert.equal(
        (persisted.geometry_artifact as Record<string, unknown>).sha256,
        mesh.sha256,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

test("M1-003 refuses turnaround that has not passed consistency review", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-mesh-invalid-"));
  try {
    const projectId = "mesh-invalid";
    const store = new VisualStore(join(dataDir, "visual.sqlite"));
    store.addDocument(
      projectId,
      "turnaround_set",
      "turnaround-r1",
      {
        project_id: projectId,
        revision_id: "turnaround-r1",
        source_concept_revision_id: "concept-r1",
        views: [{}, {}, {}, {}],
        consistency: { pass: false },
        status: "needs_review",
      },
      "2026-09-02T00:00:00Z",
    );
    const runtime = new MeshRuntime({ dataDir });
    await assert.rejects(
      runtime.generateMesh({ projectId, assetKind: "other", outputFormat: "ply" }),
      /consistency must pass/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
