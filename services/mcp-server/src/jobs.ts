export type M1JobKind =
  | "visual_analysis"
  | "concept_generation"
  | "turnaround_generation"
  | "geometry_generation"
  | "cad_build"
  | "mesh_repair"
  | "assembly"
  | "validation"
  | "manufacturing_plan"
  | "slicing"
  | "bundle";

export type M1JobStatus =
  | "queued"
  | "running"
  | "blocked"
  | "succeeded"
  | "failed"
  | "canceled";

export type M1JobStage =
  | "intake"
  | "visual_analysis"
  | "concept"
  | "confirmation"
  | "turnaround"
  | "geometry"
  | "productization"
  | "assembly"
  | "validation"
  | "manufacturing"
  | "slicing"
  | "bundle"
  | "complete";

export interface M1ArtifactRef {
  artifact_id: string;
  kind: string;
  sha256: string;
  media_type: string | null;
  revision_ref: string | null;
}

export interface M1ToolVersion {
  component: string;
  version: string;
  digest: string | null;
}

export interface M1JobManifest {
  schema_version: "0.1.0";
  job_id: string;
  trace_id: string;
  project_id: string;
  idempotency_key: string | null;
  job_kind: M1JobKind;
  status: M1JobStatus;
  stage: M1JobStage;
  attempt: number;
  max_attempts: number;
  blocked_reason_code: string | null;
  error_ref: string | null;
  inputs: M1ArtifactRef[];
  outputs: M1ArtifactRef[];
  tool_versions: M1ToolVersion[];
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateM1JobInput {
  jobId: string;
  traceId: string;
  projectId: string;
  jobKind: M1JobKind;
  stage?: M1JobStage;
  idempotencyKey?: string | null;
  maxAttempts?: number;
  inputs?: M1ArtifactRef[];
  toolVersions?: M1ToolVersion[];
  now: string;
}

const TERMINAL_STATES = new Set<M1JobStatus>(["succeeded", "failed", "canceled"]);
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function ensureMutable(job: M1JobManifest): void {
  if (TERMINAL_STATES.has(job.status)) {
    throw new Error(`job ${job.job_id} is terminal (${job.status})`);
  }
}

function clone(job: M1JobManifest): M1JobManifest {
  return {
    ...job,
    inputs: [...job.inputs],
    outputs: [...job.outputs],
    tool_versions: [...job.tool_versions],
  };
}

export function createM1Job(input: CreateM1JobInput): M1JobManifest {
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new Error("maxAttempts must be an integer from 1 to 20");
  }

  return {
    schema_version: "0.1.0",
    job_id: input.jobId,
    trace_id: input.traceId,
    project_id: input.projectId,
    idempotency_key: input.idempotencyKey ?? null,
    job_kind: input.jobKind,
    status: "queued",
    stage: input.stage ?? "intake",
    attempt: 0,
    max_attempts: maxAttempts,
    blocked_reason_code: null,
    error_ref: null,
    inputs: [...(input.inputs ?? [])],
    outputs: [],
    tool_versions: [...(input.toolVersions ?? [])],
    created_at: input.now,
    started_at: null,
    updated_at: input.now,
    completed_at: null,
  };
}

export function startM1Job(
  job: M1JobManifest,
  stage: M1JobStage,
  now: string,
): M1JobManifest {
  ensureMutable(job);
  if (job.status !== "queued" && job.status !== "blocked") {
    throw new Error(`cannot start job ${job.job_id} from ${job.status}`);
  }
  if (job.attempt >= job.max_attempts) {
    throw new Error(`job ${job.job_id} exhausted ${job.max_attempts} attempts`);
  }

  const next = clone(job);
  next.status = "running";
  next.stage = stage;
  next.attempt += 1;
  next.blocked_reason_code = null;
  next.error_ref = null;
  next.started_at ??= now;
  next.updated_at = now;
  next.completed_at = null;
  return next;
}

export function blockM1Job(
  job: M1JobManifest,
  stage: M1JobStage,
  reasonCode: string,
  now: string,
): M1JobManifest {
  ensureMutable(job);
  if (job.status !== "running") {
    throw new Error(`cannot block job ${job.job_id} from ${job.status}`);
  }
  if (!ERROR_CODE.test(reasonCode)) {
    throw new Error("blocked reason must be a canonical uppercase error code");
  }

  const next = clone(job);
  next.status = "blocked";
  next.stage = stage;
  next.blocked_reason_code = reasonCode;
  next.updated_at = now;
  return next;
}

export function succeedM1Job(
  job: M1JobManifest,
  outputs: M1ArtifactRef[],
  now: string,
): M1JobManifest {
  ensureMutable(job);
  if (job.status !== "running") {
    throw new Error(`cannot succeed job ${job.job_id} from ${job.status}`);
  }

  const next = clone(job);
  next.status = "succeeded";
  next.stage = "complete";
  next.outputs = [...outputs];
  next.updated_at = now;
  next.completed_at = now;
  return next;
}

export function failM1Job(
  job: M1JobManifest,
  errorRef: string,
  now: string,
): M1JobManifest {
  ensureMutable(job);
  if (job.status !== "running" && job.status !== "blocked") {
    throw new Error(`cannot fail job ${job.job_id} from ${job.status}`);
  }
  if (errorRef.length === 0) {
    throw new Error("errorRef must not be empty");
  }

  const next = clone(job);
  next.status = "failed";
  next.error_ref = errorRef;
  next.updated_at = now;
  next.completed_at = now;
  return next;
}

export function cancelM1Job(job: M1JobManifest, now: string): M1JobManifest {
  ensureMutable(job);
  const next = clone(job);
  next.status = "canceled";
  next.updated_at = now;
  next.completed_at = now;
  return next;
}
