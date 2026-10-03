import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { AssemblyStore } from "./assembly-store.js";
import type {
  AssemblyInterfaceInput,
  AssemblyInterfaceSpecInput,
  AssemblyPartInput,
  DefineAssemblyInput,
} from "./assembly-types.js";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ITEM_ID = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;

export interface AssemblyRuntimeOptions {
  dataDir?: string;
  store?: AssemblyStore;
}

function requireProjectId(value: string): string {
  if (!PROJECT_ID.test(value)) throw new Error("invalid project_id");
  return value;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function nonNegative(value: number | null | undefined, name: string): number | null {
  if (value === undefined || value === null) return null;
  finite(value, name);
  if (value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function positive(value: number | null | undefined, name: string): number | null {
  if (value === undefined || value === null) return null;
  finite(value, name);
  if (value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

function normalizePart(input: AssemblyPartInput): Record<string, unknown> {
  if (!ITEM_ID.test(input.id)) throw new Error(`invalid part id ${input.id}`);
  if (!input.sourceRef || input.sourceRef.length > 256) {
    throw new Error(`${input.id}.source_ref must be 1 to 256 characters`);
  }
  if (
    input.sourceArtifactSha256 !== undefined &&
    input.sourceArtifactSha256 !== null &&
    !SHA256.test(input.sourceArtifactSha256)
  ) {
    throw new Error(`${input.id}.source_artifact_sha256 must be SHA-256`);
  }
  return {
    id: input.id,
    source_kind: input.sourceKind,
    source_ref: input.sourceRef,
    source_artifact_sha256: input.sourceArtifactSha256 ?? null,
    role: input.role,
    transform: {
      x: finite(input.transform.x, `${input.id}.transform.x`),
      y: finite(input.transform.y, `${input.id}.transform.y`),
      z: finite(input.transform.z, `${input.id}.transform.z`),
      rotate_x: finite(input.transform.rotateX, `${input.id}.transform.rotate_x`),
      rotate_y: finite(input.transform.rotateY, `${input.id}.transform.rotate_y`),
      rotate_z: finite(input.transform.rotateZ, `${input.id}.transform.rotate_z`),
    },
    required_for_product: input.requiredForProduct ?? true,
  };
}

function normalizeSpec(
  interfaceId: string,
  spec: AssemblyInterfaceSpecInput | undefined,
): Record<string, unknown> {
  return {
    clearance_mm: nonNegative(spec?.clearanceMm, `${interfaceId}.clearance_mm`),
    tolerance_mm: nonNegative(spec?.toleranceMm, `${interfaceId}.tolerance_mm`),
    magnet_diameter_mm: positive(
      spec?.magnetDiameterMm,
      `${interfaceId}.magnet_diameter_mm`,
    ),
    magnet_depth_mm: positive(spec?.magnetDepthMm, `${interfaceId}.magnet_depth_mm`),
    peg_diameter_mm: positive(spec?.pegDiameterMm, `${interfaceId}.peg_diameter_mm`),
    engagement_depth_mm: positive(
      spec?.engagementDepthMm,
      `${interfaceId}.engagement_depth_mm`,
    ),
    screw_standard:
      spec?.screwStandard === undefined || spec.screwStandard === null
        ? null
        : spec.screwStandard.trim(),
    adhesive_gap_mm: nonNegative(spec?.adhesiveGapMm, `${interfaceId}.adhesive_gap_mm`),
  };
}

function normalizeInterface(
  input: AssemblyInterfaceInput,
  partIds: Set<string>,
): Record<string, unknown> {
  if (!ITEM_ID.test(input.id)) throw new Error(`invalid interface id ${input.id}`);
  if (!partIds.has(input.partA)) {
    throw new Error(`${input.id}.part_a references unknown part ${input.partA}`);
  }
  if (!partIds.has(input.partB)) {
    throw new Error(`${input.id}.part_b references unknown part ${input.partB}`);
  }
  if (input.partA === input.partB) {
    throw new Error(`${input.id} cannot connect a part to itself`);
  }
  return {
    id: input.id,
    type: input.type,
    part_a: input.partA,
    part_b: input.partB,
    spec: normalizeSpec(input.id, input.spec),
  };
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(message);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(message);
  return value;
}

type CheckStatus = "pass" | "fail" | "unknown";

interface Check {
  code: string;
  status: CheckStatus;
  subject: string;
  message: string;
}

function requiredInterfaceSpecCheck(value: unknown): Check {
  const item = record(value, "invalid interface");
  const id = stringValue(item.id, "interface id missing");
  const type = stringValue(item.type, `${id} interface type missing`);
  const spec = record(item.spec, `${id} interface spec missing`);

  const hasPositive = (name: string): boolean =>
    typeof spec[name] === "number" && Number.isFinite(spec[name]) && Number(spec[name]) > 0;
  const hasNonNegative = (name: string): boolean =>
    typeof spec[name] === "number" && Number.isFinite(spec[name]) && Number(spec[name]) >= 0;

  if (type === "magnetic_mount") {
    const ok = hasPositive("magnet_diameter_mm") && hasPositive("magnet_depth_mm");
    return {
      code: "MAGNET_SPEC_COMPLETE",
      status: ok ? "pass" : "fail",
      subject: id,
      message: ok
        ? "Magnetic mount has diameter and depth."
        : "Magnetic mount requires magnet_diameter_mm and magnet_depth_mm.",
    };
  }

  if (type === "screw") {
    const standard = spec.screw_standard;
    const ok = typeof standard === "string" && standard.trim().length > 0;
    return {
      code: "SCREW_SPEC_COMPLETE",
      status: ok ? "pass" : "fail",
      subject: id,
      message: ok ? "Screw interface has a screw standard." : "Screw interface requires screw_standard.",
    };
  }

  if (type === "peg_socket") {
    const ok = hasPositive("peg_diameter_mm") && hasPositive("engagement_depth_mm");
    return {
      code: "PEG_SPEC_COMPLETE",
      status: ok ? "pass" : "fail",
      subject: id,
      message: ok
        ? "Peg/socket interface has diameter and engagement depth."
        : "Peg/socket interface requires peg_diameter_mm and engagement_depth_mm.",
    };
  }

  if (type === "snap_fit" || type === "press_fit" || type === "dovetail") {
    const ok = hasNonNegative("clearance_mm") || hasNonNegative("tolerance_mm");
    return {
      code: "FIT_POLICY_EXPLICIT",
      status: ok ? "pass" : "unknown",
      subject: id,
      message: ok
        ? "Fit interface has an explicit clearance/tolerance policy."
        : "Fit interface has no explicit clearance/tolerance; engineering fit remains UNKNOWN.",
    };
  }

  if (type === "glue") {
    const ok = hasNonNegative("adhesive_gap_mm");
    return {
      code: "ADHESIVE_GAP_EXPLICIT",
      status: ok ? "pass" : "unknown",
      subject: id,
      message: ok
        ? "Glue interface has an explicit adhesive gap."
        : "Glue interface has no adhesive_gap_mm; adhesive fit remains UNKNOWN.",
    };
  }

  return {
    code: "INTERFACE_SPEC_ACCEPTED",
    status: "pass",
    subject: id,
    message: "Interface type does not require additional mandatory dimensions in v0.2.",
  };
}

function requiredPartConnectivity(
  partsInput: unknown[],
  interfacesInput: unknown[],
): Check {
  const requiredParts = partsInput
    .map((value) => record(value, "invalid part"))
    .filter((part) => part.required_for_product !== false)
    .map((part) => stringValue(part.id, "part id missing"));

  if (requiredParts.length <= 1) {
    return {
      code: "REQUIRED_PARTS_CONNECTED",
      status: "pass",
      subject: "assembly",
      message: "Assembly has one or fewer required parts.",
    };
  }

  const requiredSet = new Set(requiredParts);
  const adjacency = new Map<string, Set<string>>(
    requiredParts.map((partId) => [partId, new Set<string>()]),
  );

  for (const value of interfacesInput) {
    const item = record(value, "invalid interface");
    if (item.type === "free_placement") continue;
    const partA = String(item.part_a ?? "");
    const partB = String(item.part_b ?? "");
    if (!requiredSet.has(partA) || !requiredSet.has(partB)) continue;
    adjacency.get(partA)?.add(partB);
    adjacency.get(partB)?.add(partA);
  }

  const visited = new Set<string>();
  const stack = [requiredParts[0] as string];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }

  const disconnected = requiredParts.filter((partId) => !visited.has(partId));
  return {
    code: "REQUIRED_PARTS_CONNECTED",
    status: disconnected.length === 0 ? "pass" : "fail",
    subject: "assembly",
    message:
      disconnected.length === 0
        ? "All required parts participate in one mechanical interface graph."
        : `Required parts are disconnected from the mechanical assembly graph: ${disconnected.join(", ")}.`,
  };
}

export class AssemblyRuntime {
  readonly #store: AssemblyStore;

  constructor(options: AssemblyRuntimeOptions = {}) {
    const dataDir = resolve(options.dataDir ?? process.env.CAD3MF_DATA_DIR ?? ".cad3mf-data");
    mkdirSync(dataDir, { recursive: true });
    this.#store = options.store ?? new AssemblyStore(join(dataDir, "assembly.sqlite"));
  }

  defineAssembly(input: DefineAssemblyInput): Record<string, unknown> {
    const projectId = requireProjectId(input.projectId);
    if (input.parts.length < 1 || input.parts.length > 512) {
      throw new Error("assembly must contain 1 to 512 parts");
    }

    const partIds = new Set<string>();
    const parts = input.parts.map((part) => {
      if (partIds.has(part.id)) throw new Error(`duplicate part id ${part.id}`);
      partIds.add(part.id);
      return normalizePart(part);
    });

    const interfaceIds = new Set<string>();
    const interfaces = (input.interfaces ?? []).map((item) => {
      if (interfaceIds.has(item.id)) throw new Error(`duplicate interface id ${item.id}`);
      interfaceIds.add(item.id);
      return normalizeInterface(item, partIds);
    });

    let parentRevisionId: string | null = null;
    try {
      parentRevisionId = String(this.#store.getDocument(projectId, "assembly_ir").revision_id);
    } catch {
      parentRevisionId = null;
    }

    const revisionId = this.#store.nextRevisionId(projectId, "assembly_ir");
    const now = new Date().toISOString();
    const document: Record<string, unknown> = {
      schema_version: "0.1.0",
      assembly_id: `assembly-${projectId}`,
      project_id: projectId,
      revision_id: revisionId,
      parent_revision_id: parentRevisionId,
      product_type: input.productType,
      units: "mm",
      parts,
      interfaces,
      notes: input.notes ?? [],
      status: "needs_validation",
    };
    this.#store.addDocument(projectId, "assembly_ir", revisionId, document, now);
    return document;
  }

  getAssembly(projectIdInput: string, revisionId?: string): Record<string, unknown> {
    return this.#store.getDocument(requireProjectId(projectIdInput), "assembly_ir", revisionId);
  }

  validateAssembly(projectIdInput: string, revisionId?: string): Record<string, unknown> {
    const projectId = requireProjectId(projectIdInput);
    const source = this.#store.getDocument(projectId, "assembly_ir", revisionId);
    const parts = Array.isArray(source.parts) ? source.parts : [];
    const interfaces = Array.isArray(source.interfaces) ? source.interfaces : [];
    const partIds = new Set(
      parts.map((value) => stringValue(record(value, "invalid part").id, "part id missing")),
    );

    const checks: Check[] = [];

    for (const value of interfaces) {
      const item = record(value, "invalid interface");
      const id = stringValue(item.id, "interface id missing");
      const partA = String(item.part_a ?? "");
      const partB = String(item.part_b ?? "");
      const referencesValid =
        partA.length > 0 &&
        partB.length > 0 &&
        partA !== partB &&
        partIds.has(partA) &&
        partIds.has(partB);
      checks.push({
        code: "INTERFACE_REFERENCES_VALID",
        status: referencesValid ? "pass" : "fail",
        subject: id,
        message: referencesValid
          ? "Interface references two distinct known parts."
          : "Interface references missing, identical, or unknown parts.",
      });
      checks.push(requiredInterfaceSpecCheck(item));
    }

    checks.push(requiredPartConnectivity(parts, interfaces));

    let pass = 0;
    let fail = 0;
    let unknown = 0;
    for (const check of checks) {
      if (check.status === "pass") pass += 1;
      else if (check.status === "fail") fail += 1;
      else unknown += 1;
    }

    const status: CheckStatus = fail > 0 ? "fail" : unknown > 0 ? "unknown" : "pass";
    const reportId = this.#store.nextRevisionId(projectId, "assembly_validation");
    const now = new Date().toISOString();
    const report: Record<string, unknown> = {
      schema_version: "0.1.0",
      project_id: projectId,
      report_id: reportId,
      source_revision_id: String(source.revision_id),
      checks,
      summary: { pass, fail, unknown },
      status,
      created_at: now,
    };
    this.#store.addDocument(
      projectId,
      "assembly_validation",
      reportId,
      report,
      now,
    );
    return report;
  }

  getValidationReport(projectIdInput: string, reportId?: string): Record<string, unknown> {
    return this.#store.getDocument(
      requireProjectId(projectIdInput),
      "assembly_validation",
      reportId,
    );
  }
}
