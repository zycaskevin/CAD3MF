import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { EngineeringStore } from "./engineering-store.js";
import type {
  DefineEngineeringEnvelopeSetInput,
  EngineeringEnvelopeInput,
} from "./engineering-types.js";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENVELOPE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

interface AxisAlignedBox {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

interface PreparedEnvelope {
  id: string;
  semanticRole: string;
  shapeKind: string;
  aabb: AxisAlignedBox | null;
  approximate: boolean;
  unknownReason: string | null;
}

export interface EngineeringRuntimeOptions {
  dataDir?: string;
  store?: EngineeringStore;
}

function requireProjectId(value: string): string {
  if (!PROJECT_ID.test(value)) throw new Error("invalid project_id");
  return value;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function positive(value: number, name: string): number {
  finite(value, name);
  if (value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function nonNegative(value: number, name: string): number {
  finite(value, name);
  if (value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function normalizeEnvelope(input: EngineeringEnvelopeInput): Record<string, unknown> {
  if (!ENVELOPE_ID.test(input.id)) throw new Error(`invalid envelope id ${input.id}`);
  const transform = {
    x: finite(input.transform.x, `${input.id}.transform.x`),
    y: finite(input.transform.y, `${input.id}.transform.y`),
    z: finite(input.transform.z, `${input.id}.transform.z`),
    rotate_x: finite(input.transform.rotateX, `${input.id}.transform.rotate_x`),
    rotate_y: finite(input.transform.rotateY, `${input.id}.transform.rotate_y`),
    rotate_z: finite(input.transform.rotateZ, `${input.id}.transform.rotate_z`),
  };
  const shape =
    input.shape.kind === "box"
      ? {
          kind: "box",
          x: positive(input.shape.x, `${input.id}.shape.x`),
          y: positive(input.shape.y, `${input.id}.shape.y`),
          z: positive(input.shape.z, `${input.id}.shape.z`),
        }
      : {
          kind: "cylinder",
          diameter: positive(input.shape.diameter, `${input.id}.shape.diameter`),
          height: positive(input.shape.height, `${input.id}.shape.height`),
          axis: "z",
        };
  return {
    id: input.id,
    semantic_role: input.semanticRole,
    component_role: input.componentRole,
    shape,
    transform,
    clearance_mm: nonNegative(input.clearanceMm ?? 0, `${input.id}.clearance_mm`),
    required: input.required ?? true,
    notes: input.notes ?? null,
  };
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(message);
  return value as Record<string, unknown>;
}

function numeric(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(message);
  return value;
}

function prepareEnvelope(value: unknown): PreparedEnvelope {
  const envelope = record(value, "invalid persisted envelope");
  const id = String(envelope.id);
  const semanticRole = String(envelope.semantic_role);
  const shape = record(envelope.shape, `${id} has invalid shape`);
  const transform = record(envelope.transform, `${id} has invalid transform`);
  const rotateX = numeric(transform.rotate_x, `${id} has invalid rotate_x`);
  const rotateY = numeric(transform.rotate_y, `${id} has invalid rotate_y`);
  const rotateZ = numeric(transform.rotate_z, `${id} has invalid rotate_z`);
  const shapeKind = String(shape.kind);

  const rotationUnsupported =
    shapeKind === "box"
      ? rotateX !== 0 || rotateY !== 0 || rotateZ !== 0
      : rotateX !== 0 || rotateY !== 0;
  if (rotationUnsupported) {
    return {
      id,
      semanticRole,
      shapeKind,
      aabb: null,
      approximate: true,
      unknownReason: "rotated envelope is outside the v0.2 axis-aligned validator",
    };
  }

  const clearance = numeric(envelope.clearance_mm ?? 0, `${id} has invalid clearance`);
  const cx = numeric(transform.x, `${id} has invalid x`);
  const cy = numeric(transform.y, `${id} has invalid y`);
  const cz = numeric(transform.z, `${id} has invalid z`);

  let halfX: number;
  let halfY: number;
  let halfZ: number;
  let approximate = false;
  if (shapeKind === "box") {
    halfX = numeric(shape.x, `${id} has invalid box x`) / 2 + clearance;
    halfY = numeric(shape.y, `${id} has invalid box y`) / 2 + clearance;
    halfZ = numeric(shape.z, `${id} has invalid box z`) / 2 + clearance;
  } else if (shapeKind === "cylinder") {
    const radius = numeric(shape.diameter, `${id} has invalid diameter`) / 2 + clearance;
    halfX = radius;
    halfY = radius;
    halfZ = numeric(shape.height, `${id} has invalid height`) / 2 + clearance;
    approximate = true;
  } else {
    return {
      id,
      semanticRole,
      shapeKind,
      aabb: null,
      approximate: true,
      unknownReason: `unsupported envelope shape ${shapeKind}`,
    };
  }

  return {
    id,
    semanticRole,
    shapeKind,
    aabb: {
      min: { x: cx - halfX, y: cy - halfY, z: cz - halfZ },
      max: { x: cx + halfX, y: cy + halfY, z: cz + halfZ },
    },
    approximate,
    unknownReason: null,
  };
}

function pairPolicy(
  left: PreparedEnvelope,
  right: PreparedEnvelope,
):
  | "occupied_vs_occupied"
  | "occupied_vs_keep_out"
  | "motion_vs_occupied"
  | "motion_vs_keep_out"
  | null {
  const roles = [left.semanticRole, right.semanticRole].sort().join(":");
  if (roles === "occupied:occupied") return "occupied_vs_occupied";
  if (roles === "keep_out:occupied") return "occupied_vs_keep_out";
  if (roles === "motion_swept:occupied") return "motion_vs_occupied";
  if (roles === "keep_out:motion_swept") return "motion_vs_keep_out";
  return null;
}

function overlap(
  left: AxisAlignedBox,
  right: AxisAlignedBox,
): { x: number; y: number; z: number; volume: number } {
  const x = Math.max(0, Math.min(left.max.x, right.max.x) - Math.max(left.min.x, right.min.x));
  const y = Math.max(0, Math.min(left.max.y, right.max.y) - Math.max(left.min.y, right.min.y));
  const z = Math.max(0, Math.min(left.max.z, right.max.z) - Math.max(left.min.z, right.min.z));
  return { x, y, z, volume: x * y * z };
}

export class EngineeringRuntime {
  readonly #store: EngineeringStore;

  constructor(options: EngineeringRuntimeOptions = {}) {
    const dataDir = resolve(options.dataDir ?? process.env.CAD3MF_DATA_DIR ?? ".cad3mf-data");
    mkdirSync(dataDir, { recursive: true });
    this.#store = options.store ?? new EngineeringStore(join(dataDir, "engineering.sqlite"));
  }

  defineEnvelopeSet(input: DefineEngineeringEnvelopeSetInput): Record<string, unknown> {
    const projectId = requireProjectId(input.projectId);
    if (input.envelopes.length < 1 || input.envelopes.length > 512) {
      throw new Error("engineering envelope set must contain 1 to 512 envelopes");
    }
    const ids = new Set<string>();
    const envelopes = input.envelopes.map((item) => {
      if (ids.has(item.id)) throw new Error(`duplicate envelope id ${item.id}`);
      ids.add(item.id);
      return normalizeEnvelope(item);
    });

    let parentRevisionId: string | null = null;
    try {
      parentRevisionId = String(this.#store.getDocument(projectId, "envelope_set").revision_id);
    } catch {
      parentRevisionId = null;
    }

    const revisionId = this.#store.nextRevisionId(projectId, "envelope_set");
    const now = new Date().toISOString();
    const frame = input.coordinateFrame ?? {
      name: "product-z-up",
      originPolicy: "product_origin" as const,
    };
    const document: Record<string, unknown> = {
      schema_version: "0.1.0",
      project_id: projectId,
      revision_id: revisionId,
      parent_revision_id: parentRevisionId,
      source_asset_revision_id: input.sourceAssetRevisionId ?? null,
      units: "mm",
      coordinate_frame: {
        name: frame.name,
        handedness: "right",
        up_axis: "z",
        origin_policy: frame.originPolicy,
      },
      envelopes,
      notes: input.notes ?? [],
      status: "needs_validation",
    };
    this.#store.addDocument(projectId, "envelope_set", revisionId, document, now);
    return document;
  }

  getEnvelopeSet(projectIdInput: string, revisionId?: string): Record<string, unknown> {
    return this.#store.getDocument(
      requireProjectId(projectIdInput),
      "envelope_set",
      revisionId,
    );
  }

  validateEnvelopeSet(projectIdInput: string, revisionId?: string): Record<string, unknown> {
    const projectId = requireProjectId(projectIdInput);
    const source = this.#store.getDocument(projectId, "envelope_set", revisionId);
    const sourceRevisionId = String(source.revision_id);
    if (!Array.isArray(source.envelopes)) throw new Error("engineering envelope set is invalid");
    const prepared = source.envelopes.map(prepareEnvelope);
    const checks: Record<string, unknown>[] = [];
    let pass = 0;
    let fail = 0;
    let unknown = 0;

    for (let leftIndex = 0; leftIndex < prepared.length; leftIndex += 1) {
      const left = prepared[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < prepared.length; rightIndex += 1) {
        const right = prepared[rightIndex];
        if (!right) continue;
        const policy = pairPolicy(left, right);
        if (!policy) continue;

        const approximate = left.approximate || right.approximate;
        if (!left.aabb || !right.aabb) {
          unknown += 1;
          checks.push({
            envelope_a: left.id,
            envelope_b: right.id,
            policy,
            status: "unknown",
            approximate: true,
            overlap_mm: { x: null, y: null, z: null },
            overlap_volume_mm3: null,
            reason: left.unknownReason ?? right.unknownReason ?? "AABB unavailable",
          });
          continue;
        }

        const measured = overlap(left.aabb, right.aabb);
        const collides = measured.volume > 0;
        if (collides) fail += 1;
        else pass += 1;
        checks.push({
          envelope_a: left.id,
          envelope_b: right.id,
          policy,
          status: collides ? "fail" : "pass",
          approximate,
          overlap_mm: { x: measured.x, y: measured.y, z: measured.z },
          overlap_volume_mm3: measured.volume,
          reason: collides
            ? "forbidden engineering envelopes overlap under the v0.2 AABB policy"
            : null,
        });
      }
    }

    const status = fail > 0 ? "fail" : unknown > 0 ? "unknown" : "pass";
    const reportId = this.#store.nextRevisionId(projectId, "interference_report");
    const now = new Date().toISOString();
    const report: Record<string, unknown> = {
      schema_version: "0.1.0",
      project_id: projectId,
      report_id: reportId,
      source_revision_id: sourceRevisionId,
      method: {
        kind: "axis_aligned_bounding_box",
        exact_geometry: false,
        notes:
          "This v0.2 validator checks declared engineering envelopes only. It does not prove exact mesh/BREP clearance. Cylinders use enclosing AABBs; unsupported rotations return UNKNOWN.",
      },
      checks,
      summary: { pass, fail, unknown },
      status,
      created_at: now,
    };
    this.#store.addDocument(projectId, "interference_report", reportId, report, now);
    return report;
  }

  getInterferenceReport(projectIdInput: string, reportId?: string): Record<string, unknown> {
    return this.#store.getDocument(
      requireProjectId(projectIdInput),
      "interference_report",
      reportId,
    );
  }

  createTraceId(): string {
    return randomUUID();
  }
}
