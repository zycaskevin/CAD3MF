import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MeshRuntime } from "../src/mesh-runtime.js";
import type {
  MeshProvider,
  MeshProviderContext,
  MeshProviderOutput,
  MeshTargetDimension,
} from "../src/mesh-types.js";
import { VisualStore } from "../src/visual-store.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3QAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

function plyFixture(): Uint8Array {
  return new TextEncoder().encode(
    "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nelement face 0\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n",
  );
}

class MetricAssertingProvider implements MeshProvider {
  readonly providerId = "metric-scale-test";
  readonly modelId = "fixture";
  readonly modelVersion = "1";
  readonly requiresTargetDimension = true;
  called = false;
  targetDimensions: MeshTargetDimension[] = [];

  async generate(context: MeshProviderContext): Promise<MeshProviderOutput> {
    this.called = true;
    this.targetDimensions = [...context.request.targetDimensions];
    return {
      bytes: plyFixture(),
      format: "ply",
      mediaType: "model/ply",
      vertexCount: 1,
      triangleCount: 0,
      boundingBoxMm: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 40, y: 40, z: 120 },
      },
      topology: {
        watertight: false,
        manifold: null,
        selfIntersectionsDetected: null,
        notes: ["scale test"],
      },
      consumedViews: ["three_quarter_front"],
    };
  }
}

async function seedVisualChain(
  dataDir: string,
  projectId: string,
  knownDimensions: Record<string, unknown>[],
): Promise<void> {
  const store = new VisualStore(join(dataDir, "visual.sqlite"));
  const createdAt = "2026-09-02T00:00:00Z";
  store.addDocument(
    projectId,
    "design_intent",
    "intent-r1",
    {
      schema_version: "0.1.0",
      intent_id: `intent-${projectId}`,
      project_id: projectId,
      revision_id: "intent-r1",
      product_kind: "figurine",
      source_assets: [],
      known_dimensions: knownDimensions,
      observed_features: [],
      hidden_geometry_assumptions: [],
      questions: [],
      status: "confirmed",
    },
    createdAt,
  );
  store.addDocument(
    projectId,
    "visual_concept",
    "concept-r1",
    {
      schema_version: "0.1.0",
      concept_id: `concept-${projectId}`,
      project_id: projectId,
      revision_id: "concept-r1",
      source_intent_revision_id: "intent-r1",
      product_kind: "figurine",
      brief: "scale test",
      artifacts: [],
      design_notes: [],
      open_decisions: [],
      status: "design_locked",
      provenance: {
        provider: "test",
        model: "fixture",
        job_id: "concept-job",
        input_artifact_sha256: [PNG_SHA],
      },
    },
    createdAt,
  );

  const artifactDir = join(dataDir, "visual-artifacts", projectId);
  await mkdir(artifactDir, { recursive: true });
  const viewNames = [
    "front",
    "left",
    "right",
    "back",
    "three_quarter_front",
    "three_quarter_back",
  ];
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
      createdAt,
    });
    views.push({
      view,
      artifact_id: artifactId,
      sha256: PNG_SHA,
      media_type: "image/png",
      projection: "orthographic_like",
    });
  }
  store.addDocument(
    projectId,
    "turnaround_set",
    "turnaround-r1",
    {
      schema_version: "0.1.0",
      turnaround_id: `turnaround-${projectId}`,
      project_id: projectId,
      revision_id: "turnaround-r1",
      source_concept_revision_id: "concept-r1",
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
        job_id: "turnaround-job",
        input_artifact_sha256: [PNG_SHA],
      },
    },
    createdAt,
  );
}

test("normalized production provider is blocked without trusted metric scale", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-mesh-scale-block-"));
  const provider = new MetricAssertingProvider();
  try {
    await seedVisualChain(dataDir, "scale-block", [
      { name: "height", value: 120, unit: "mm", source: "inferred" },
    ]);
    const runtime = new MeshRuntime({ dataDir, provider });
    await assert.rejects(
      runtime.generateMesh({
        projectId: "scale-block",
        assetKind: "figurine",
        outputFormat: "ply",
        texturePolicy: "none",
      }),
      /MESH_SCALE_REFERENCE_REQUIRED/,
    );
    assert.equal(provider.called, false);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("confirmed figurine height becomes the production uniform-scale reference", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-mesh-scale-pass-"));
  const provider = new MetricAssertingProvider();
  try {
    await seedVisualChain(dataDir, "scale-pass", [
      { name: "height", value: 120, unit: "mm", source: "user" },
    ]);
    const runtime = new MeshRuntime({ dataDir, provider });
    const output = await runtime.generateMesh({
      projectId: "scale-pass",
      assetKind: "figurine",
      outputFormat: "ply",
      texturePolicy: "none",
    });
    assert.equal(provider.called, true);
    assert.deepEqual(provider.targetDimensions, [{ name: "height", value: 120, unit: "mm" }]);

    const request = output.mesh_request as Record<string, unknown>;
    const asset = output.asset_ir as Record<string, unknown>;
    assert.deepEqual(request.target_dimensions, [{ name: "height", value: 120, unit: "mm" }]);
    assert.deepEqual(asset.target_dimensions, [{ name: "height", value: 120, unit: "mm" }]);
    const constraints = asset.print_constraints as Record<string, unknown>;
    assert.equal(constraints.target_height_mm, 120);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
