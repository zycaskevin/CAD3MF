import assert from "node:assert/strict";
import test from "node:test";

import { ManufacturingProfileRuntime } from "../src/manufacturing-profile-runtime.js";

test("starter PETG profile is explicitly unverified and calibration-gated", () => {
  const runtime = new ManufacturingProfileRuntime();
  const profile = runtime.getProfile("bambu-class-petg-0.4-starter");
  const calibration = profile.calibration as Record<string, unknown>;
  const scope = profile.machine_scope as Record<string, unknown>;

  assert.equal(profile.status, "starter_policy");
  assert.equal(calibration.required, true);
  assert.equal(calibration.evidence_status, "unverified");
  assert.equal(scope.machine_specific, false);
});

test("fit policy resolves values but does not claim machine authority", () => {
  const runtime = new ManufacturingProfileRuntime();

  const normal = runtime.resolveFitPolicy(
    "bambu-class-petg-0.4-starter",
    "default_clearance",
  );
  assert.equal(normal.value_mm, 0.25);
  assert.equal(normal.value_semantics, "clearance");
  assert.equal(normal.calibration_required, true);
  assert.equal(normal.authoritative_for_machine, false);

  const loose = runtime.resolveFitPolicy(
    "bambu-class-petg-0.4-starter",
    "loose_clearance",
  );
  assert.equal(loose.value_mm, 0.4);

  const snap = runtime.resolveFitPolicy(
    "bambu-class-petg-0.4-starter",
    "snap_fit_allowance",
  );
  assert.equal(snap.value_mm, 0.3);
  assert.equal(snap.value_semantics, "allowance");
});

test("unknown profile fails closed", () => {
  const runtime = new ManufacturingProfileRuntime();
  assert.throws(() => runtime.getProfile("not-real"), /unknown manufacturing profile/);
});
