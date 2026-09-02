import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { VisualRuntime } from "../src/visual-runtime.js";
import type { VisualProductKind } from "../src/visual-types.js";

const SOURCE_SHA = "c".repeat(64);

function object(value: unknown, message: string): Record<string, unknown> {
  assert.equal(typeof value, "object", message);
  assert.notEqual(value, null, message);
  return value as Record<string, unknown>;
}

async function runGoldenVisualCase(
  productKind: VisualProductKind,
  projectId: string,
  decisionId: string,
  coveragePolicy: "minimum_four_view" | "full_six_view",
  expectedViews: number,
): Promise<void> {
  const dataDir = await mkdtemp(resolve(tmpdir(), `cad3mf-visual-${projectId}-`));
  try {
    const runtime = new VisualRuntime({ dataDir });
    assert.deepEqual(runtime.providerInfo(), {
      provider_id: "deterministic-test",
      model_id: "fixture-png-v1",
    });

    const analyzed = await runtime.analyzeVisualInput({
      projectId,
      productKind,
      designPrompt:
        productKind === "figurine"
          ? "Create a stylized collectible figurine with a stable display pose."
          : "Create a futuristic modular tank with a replaceable upper body module.",
      style: productKind === "figurine" ? "chibi_collectible" : "futuristic_hard_surface",
      requestedFunctions:
        productKind === "figurine" ? ["stable_base"] : ["replaceable_upper_module"],
      sourceAssets: [
        {
          assetId: `${projectId}-reference`,
          sha256: SOURCE_SHA,
          mediaType: "image/png",
          role: productKind === "figurine" ? "identity_reference" : "concept",
        },
      ],
      knownDimensions: [
        {
          name: productKind === "figurine" ? "target_height" : "target_length",
          value: productKind === "figurine" ? 120 : 180,
          unit: "mm",
          source: "user",
          confidence: 1,
        },
      ],
    });
    const analyzedIntent = object(analyzed.design_intent, "missing design intent");
    assert.equal(analyzedIntent.product_kind, productKind);
    assert.equal(analyzedIntent.status, "needs_confirmation");
    const analyzeJob = object(analyzed.job, "missing analyze job");
    assert.equal(analyzeJob.status, "succeeded");

    const generatedConcept = await runtime.generateConcept(projectId);
    const concept = object(generatedConcept.visual_concept, "missing visual concept");
    assert.equal(concept.product_kind, productKind);
    assert.equal(concept.status, "needs_confirmation");
    assert.equal("artifact_path" in concept, false);

    await assert.rejects(
      runtime.generateTurnaround(projectId, String(concept.revision_id), coveragePolicy),
      /design-locked visual concept/,
    );
    assert.throws(
      () => runtime.confirmDesign({ projectId, conceptRevisionId: String(concept.revision_id) }),
      /required visual decisions remain open/,
    );

    const confirmed = runtime.confirmDesign({
      projectId,
      conceptRevisionId: String(concept.revision_id),
      answers: {
        [decisionId]: productKind === "figurine" ? "standing neutral pose" : "turret and upper shell",
      },
      notes: ["Golden reference confirmation."],
    });
    const lockedConcept = object(confirmed.visual_concept, "missing locked concept");
    assert.equal(lockedConcept.status, "design_locked");
    assert.notEqual(lockedConcept.revision_id, concept.revision_id);

    const restarted = new VisualRuntime({ dataDir });
    const turnaroundResult = await restarted.generateTurnaround(
      projectId,
      String(lockedConcept.revision_id),
      coveragePolicy,
    );
    const turnaround = object(turnaroundResult.turnaround_set, "missing turnaround set");
    const views = turnaround.views;
    assert(Array.isArray(views));
    assert.equal(views.length, expectedViews);
    assert.equal(turnaround.coverage_policy, coveragePolicy);
    assert.equal(turnaround.status, "needs_review");

    const firstView = object(views[0], "missing first turnaround view");
    const artifact = restarted.artifactLocation(projectId, String(firstView.artifact_id));
    assert.equal(artifact.mediaType, "image/png");
    const bytes = await readFile(artifact.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);

    const turnaroundJob = object(turnaroundResult.job, "missing turnaround job");
    const persistedJob = restarted.getJob(String(turnaroundJob.job_id));
    assert.equal(persistedJob.status, "succeeded");
    assert.equal(persistedJob.project_id, projectId);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("REF-VIS-001 figurine uses generic visual workflow", async () => {
  await runGoldenVisualCase("figurine", "ref-vis-001", "pose", "full_six_view", 6);
});

test("REF-VIS-002 modular tank uses the same generic visual workflow", async () => {
  await runGoldenVisualCase(
    "vehicle",
    "ref-vis-002",
    "module_boundary",
    "minimum_four_view",
    4,
  );
});
