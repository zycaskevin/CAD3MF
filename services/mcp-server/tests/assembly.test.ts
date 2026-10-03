import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { AssemblyRuntime } from "../src/assembly-runtime.js";

const zero = { x: 0, y: 0, z: 0, rotateX: 0, rotateY: 0, rotateZ: 0 };

test("AI Tank assembly fails incomplete magnetic mount then passes corrected revision", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-assembly-"));
  try {
    const runtime = new AssemblyRuntime({ dataDir });

    const bad = runtime.defineAssembly({
      projectId: "ai-tank-assembly",
      productType: "modular_tank",
      parts: [
        {
          id: "chassis",
          sourceKind: "cad_ir",
          sourceRef: "cad:r10",
          role: "structural",
          transform: zero,
        },
        {
          id: "shell",
          sourceKind: "asset_ir",
          sourceRef: "asset:r4",
          role: "shell",
          transform: zero,
        },
        {
          id: "turret",
          sourceKind: "asset_ir",
          sourceRef: "asset:r5",
          role: "replaceable_module",
          transform: { ...zero, z: 18 },
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
        {
          id: "turret-mount",
          type: "magnetic_mount",
          partA: "shell",
          partB: "turret",
          spec: {},
        },
      ],
    });

    assert.equal(bad.revision_id, "assembly-r1");
    const failed = runtime.validateAssembly("ai-tank-assembly");
    const failedChecks = failed.checks as Array<Record<string, unknown>>;
    assert.equal(failed.status, "fail");
    assert(
      failedChecks.some(
        (check) =>
          check.code === "MAGNET_SPEC_COMPLETE" &&
          check.subject === "turret-mount" &&
          check.status === "fail",
      ),
    );

    const fixed = runtime.defineAssembly({
      projectId: "ai-tank-assembly",
      productType: "modular_tank",
      parts: [
        {
          id: "chassis",
          sourceKind: "cad_ir",
          sourceRef: "cad:r10",
          role: "structural",
          transform: zero,
        },
        {
          id: "shell",
          sourceKind: "asset_ir",
          sourceRef: "asset:r4",
          role: "shell",
          transform: zero,
        },
        {
          id: "turret",
          sourceKind: "asset_ir",
          sourceRef: "asset:r5",
          role: "replaceable_module",
          transform: { ...zero, z: 18 },
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
        {
          id: "turret-mount",
          type: "magnetic_mount",
          partA: "shell",
          partB: "turret",
          spec: { magnetDiameterMm: 4, magnetDepthMm: 2.5 },
        },
      ],
    });

    assert.equal(fixed.revision_id, "assembly-r2");
    assert.equal(fixed.parent_revision_id, "assembly-r1");

    const passed = runtime.validateAssembly("ai-tank-assembly", "assembly-r2");
    const summary = passed.summary as Record<string, unknown>;
    assert.equal(passed.status, "pass");
    assert.equal(summary.fail, 0);
    assert.equal(summary.unknown, 0);

    const restarted = new AssemblyRuntime({ dataDir });
    assert.equal(restarted.getAssembly("ai-tank-assembly").revision_id, "assembly-r2");
    assert.equal(restarted.getValidationReport("ai-tank-assembly").status, "pass");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("disconnected required parts fail assembly connectivity", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-assembly-disconnected-"));
  try {
    const runtime = new AssemblyRuntime({ dataDir });
    runtime.defineAssembly({
      projectId: "disconnected",
      productType: "multi_part_product",
      parts: [
        {
          id: "body",
          sourceKind: "cad_ir",
          sourceRef: "cad:r1",
          role: "structural",
          transform: zero,
        },
        {
          id: "cover",
          sourceKind: "asset_ir",
          sourceRef: "asset:r1",
          role: "shell",
          transform: zero,
        },
      ],
      interfaces: [],
    });
    const report = runtime.validateAssembly("disconnected");
    const checks = report.checks as Array<Record<string, unknown>>;
    assert.equal(report.status, "fail");
    assert(
      checks.some(
        (check) => check.code === "REQUIRED_PARTS_CONNECTED" && check.status === "fail",
      ),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("snap fit without clearance/tolerance returns UNKNOWN, not false PASS", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-assembly-unknown-"));
  try {
    const runtime = new AssemblyRuntime({ dataDir });
    runtime.defineAssembly({
      projectId: "snap-unknown",
      productType: "multi_part_product",
      parts: [
        {
          id: "body",
          sourceKind: "cad_ir",
          sourceRef: "cad:r1",
          role: "structural",
          transform: zero,
        },
        {
          id: "cover",
          sourceKind: "cad_ir",
          sourceRef: "cad:r2",
          role: "shell",
          transform: zero,
        },
      ],
      interfaces: [
        {
          id: "cover-snap",
          type: "snap_fit",
          partA: "body",
          partB: "cover",
          spec: {},
        },
      ],
    });
    const report = runtime.validateAssembly("snap-unknown");
    const checks = report.checks as Array<Record<string, unknown>>;
    assert.equal(report.status, "unknown");
    assert(
      checks.some(
        (check) => check.code === "FIT_POLICY_EXPLICIT" && check.status === "unknown",
      ),
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("assembly definition rejects self-referential interfaces", async () => {
  const dataDir = await mkdtemp(resolve(tmpdir(), "cad3mf-assembly-self-"));
  try {
    const runtime = new AssemblyRuntime({ dataDir });
    assert.throws(
      () =>
        runtime.defineAssembly({
          projectId: "self-reference",
          productType: "other",
          parts: [
            {
              id: "body",
              sourceKind: "cad_ir",
              sourceRef: "cad:r1",
              role: "structural",
              transform: zero,
            },
          ],
          interfaces: [
            {
              id: "bad-interface",
              type: "screw",
              partA: "body",
              partB: "body",
              spec: { screwStandard: "M2" },
            },
          ],
        }),
      /cannot connect a part to itself/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
