import assert from "node:assert/strict";
import test from "node:test";

import {
  blockM1Job,
  cancelM1Job,
  createM1Job,
  failM1Job,
  startM1Job,
  succeedM1Job,
} from "../src/jobs.js";

const T0 = "2026-09-02T10:00:00+08:00";
const T1 = "2026-09-02T10:01:00+08:00";
const T2 = "2026-09-02T10:02:00+08:00";
const T3 = "2026-09-02T10:03:00+08:00";

function queuedJob() {
  return createM1Job({
    jobId: "job-1",
    traceId: "trace-1",
    projectId: "arthur-figurine",
    jobKind: "geometry_generation",
    now: T0,
  });
}

test("M1 job can block for confirmation and resume as a retry", () => {
  const running = startM1Job(queuedJob(), "geometry", T1);
  assert.equal(running.status, "running");
  assert.equal(running.attempt, 1);

  const blocked = blockM1Job(running, "confirmation", "TURNAROUND_REQUIRED", T2);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocked_reason_code, "TURNAROUND_REQUIRED");

  const resumed = startM1Job(blocked, "geometry", T3);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.attempt, 2);
  assert.equal(resumed.blocked_reason_code, null);
});

test("M1 terminal success cannot be restarted", () => {
  const running = startM1Job(queuedJob(), "geometry", T1);
  const success = succeedM1Job(
    running,
    [
      {
        artifact_id: "mesh-r1",
        kind: "mesh",
        sha256: "a".repeat(64),
        media_type: "model/gltf-binary",
        revision_ref: "asset:r1",
      },
    ],
    T2,
  );

  assert.equal(success.status, "succeeded");
  assert.equal(success.stage, "complete");
  assert.equal(success.completed_at, T2);
  assert.throws(() => startM1Job(success, "geometry", T3), /terminal/);
});

test("M1 blocked reason must use canonical error code syntax", () => {
  const running = startM1Job(queuedJob(), "geometry", T1);
  assert.throws(
    () => blockM1Job(running, "confirmation", "please add a rear view", T2),
    /canonical uppercase error code/,
  );
});

test("M1 jobs enforce maximum attempts", () => {
  const first = createM1Job({
    jobId: "job-retry",
    traceId: "trace-retry",
    projectId: "arthur-figurine",
    jobKind: "geometry_generation",
    maxAttempts: 1,
    now: T0,
  });
  const running = startM1Job(first, "geometry", T1);
  const blocked = blockM1Job(running, "confirmation", "NEEDS_CONFIRMATION", T2);
  assert.throws(() => startM1Job(blocked, "geometry", T3), /exhausted 1 attempts/);
});

test("M1 failure and cancellation are terminal", () => {
  const running = startM1Job(queuedJob(), "geometry", T1);
  const failed = failM1Job(running, "error:geometry:1", T2);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error_ref, "error:geometry:1");
  assert.throws(() => cancelM1Job(failed, T3), /terminal/);

  const canceled = cancelM1Job(queuedJob(), T1);
  assert.equal(canceled.status, "canceled");
  assert.throws(() => startM1Job(canceled, "geometry", T2), /terminal/);
});
