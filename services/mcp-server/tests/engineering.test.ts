import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { EngineeringRuntime } from "../src/engineering-runtime.js";

function zeroTransform(x = 0, y = 0, z = 0) {
  return { x, y, z, rotateX: 0, rotateY: 0, rotateZ: 0 };
}

test("AI Tank negative control detects PCB intrusion into battery keep-out and passes after correction", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-engineering-"));
  try {
    const runtime = new EngineeringRuntime({ dataDir });

    const bad = runtime.defineEnvelopeSet({
      projectId: "ai-tank-v02",
      sourceAssetRevisionId: "asset-r1",
      coordinateFrame: { name: "tank-chassis", originPolicy: "chassis_origin" },
      envelopes: [
        {
          id: "battery-clearance",
          semanticRole: "keep_out",
          componentRole: "battery",
          shape: { kind: "box", x: 80, y: 35, z: 18 },
          transform: zeroTransform(),
          clearanceMm: 1,
        },
        {
          id: "pcb",
          semanticRole: "occupied",
          componentRole: "pcb",
          shape: { kind: "box", x: 50, y: 30, z: 4 },
          transform: zeroTransform(),
        },
      ],
    });

    assert.equal(bad.revision_id, "envelopes-r1");
    assert.equal(bad.status, "needs_validation");

    const failed = runtime.validateEnvelopeSet("ai-tank-v02");
    const failedSummary = failed.summary as Record<string, unknown>;
    const failedChecks = failed.checks as Array<Record<string, unknown>>;
    assert.equal(failed.status, "fail");
    assert.equal(failedSummary.fail, 1);
    assert.equal(failedChecks.length, 1);
    assert.equal(failedChecks[0]?.policy, "occupied_vs_keep_out");
    assert.equal(failedChecks[0]?.status, "fail");
    assert.equal(failedChecks[0]?.approximate, false);
    assert(Number(failedChecks[0]?.overlap_volume_mm3) > 0);

    const fixed = runtime.defineEnvelopeSet({
      projectId: "ai-tank-v02",
      sourceAssetRevisionId: "asset-r1",
      coordinateFrame: { name: "tank-chassis", originPolicy: "chassis_origin" },
      envelopes: [
        {
          id: "battery-clearance",
          semanticRole: "keep_out",
          componentRole: "battery",
          shape: { kind: "box", x: 80, y: 35, z: 18 },
          transform: zeroTransform(),
          clearanceMm: 1,
        },
        {
          id: "pcb",
          semanticRole: "occupied",
          componentRole: "pcb",
          shape: { kind: "box", x: 50, y: 30, z: 4 },
          transform: zeroTransform(80, 0, 0),
        },
      ],
    });

    assert.equal(fixed.revision_id, "envelopes-r2");
    assert.equal(fixed.parent_revision_id, "envelopes-r1");

    const passed = runtime.validateEnvelopeSet("ai-tank-v02", "envelopes-r2");
    const passedSummary = passed.summary as Record<string, unknown>;
    assert.equal(passed.status, "pass");
    assert.equal(passedSummary.pass, 1);
    assert.equal(passedSummary.fail, 0);
    assert.equal(passedSummary.unknown, 0);

    const restarted = new EngineeringRuntime({ dataDir });
    const persisted = restarted.getEnvelopeSet("ai-tank-v02");
    assert.equal(persisted.revision_id, "envelopes-r2");
    const report = restarted.getInterferenceReport("ai-tank-v02");
    assert.equal(report.status, "pass");
    assert.equal(report.source_revision_id, "envelopes-r2");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("rotated box returns UNKNOWN instead of pretending AABB validation is exact", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-engineering-rotation-"));
  try {
    const runtime = new EngineeringRuntime({ dataDir });
    runtime.defineEnvelopeSet({
      projectId: "ai-tank-rotation",
      envelopes: [
        {
          id: "battery-clearance",
          semanticRole: "keep_out",
          componentRole: "battery",
          shape: { kind: "box", x: 80, y: 35, z: 18 },
          transform: zeroTransform(),
        },
        {
          id: "pcb-rotated",
          semanticRole: "occupied",
          componentRole: "pcb",
          shape: { kind: "box", x: 50, y: 30, z: 4 },
          transform: { ...zeroTransform(), rotateZ: 15 },
        },
      ],
    });

    const report = runtime.validateEnvelopeSet("ai-tank-rotation");
    const summary = report.summary as Record<string, unknown>;
    const checks = report.checks as Array<Record<string, unknown>>;
    assert.equal(report.status, "unknown");
    assert.equal(summary.unknown, 1);
    assert.equal(checks[0]?.status, "unknown");
    assert.equal(checks[0]?.approximate, true);
    assert.match(String(checks[0]?.reason), /rotated envelope/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("cylinder collision is conservative and explicitly marked approximate", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-engineering-cylinder-"));
  try {
    const runtime = new EngineeringRuntime({ dataDir });
    runtime.defineEnvelopeSet({
      projectId: "ai-tank-motor",
      envelopes: [
        {
          id: "motor",
          semanticRole: "occupied",
          componentRole: "motor",
          shape: { kind: "cylinder", diameter: 20, height: 30, axis: "z" },
          transform: zeroTransform(),
        },
        {
          id: "service-zone",
          semanticRole: "keep_out",
          componentRole: "service_volume",
          shape: { kind: "box", x: 10, y: 10, z: 10 },
          transform: zeroTransform(),
        },
      ],
    });

    const report = runtime.validateEnvelopeSet("ai-tank-motor");
    const checks = report.checks as Array<Record<string, unknown>>;
    assert.equal(report.status, "fail");
    assert.equal(checks[0]?.approximate, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("engineering envelope IDs are unique per revision", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-engineering-duplicate-"));
  try {
    const runtime = new EngineeringRuntime({ dataDir });
    assert.throws(
      () =>
        runtime.defineEnvelopeSet({
          projectId: "duplicate-test",
          envelopes: [
            {
              id: "battery",
              semanticRole: "occupied",
              componentRole: "battery",
              shape: { kind: "box", x: 10, y: 10, z: 10 },
              transform: zeroTransform(),
            },
            {
              id: "battery",
              semanticRole: "keep_out",
              componentRole: "service_volume",
              shape: { kind: "box", x: 20, y: 20, z: 20 },
              transform: zeroTransform(),
            },
          ],
        }),
      /duplicate envelope id/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
