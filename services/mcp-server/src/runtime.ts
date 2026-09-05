import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { ProjectStore } from "./store.js";
import type {
  CreateDesignInput,
  JsonObject,
  ModifyDesignInput,
  StoredProject,
  StoredRevision,
} from "./types.js";
import { CadWorker } from "./worker.js";

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export type ArtifactKind = "preview" | "step" | "stl" | "3mf";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireProjectId(value?: string): string {
  const projectId = value ?? randomUUID();
  if (!PROJECT_ID.test(projectId)) {
    throw new Error("project_id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/");
  }
  return projectId;
}

function parameterMap(cadIr: JsonObject): Record<string, number> {
  const value = cadIr.parameters;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("CAD-IR parameters must be an object");
  }
  return value as Record<string, number>;
}

function featureTree(cadIr: JsonObject): unknown[] {
  if (!Array.isArray(cadIr.bodies)) return [];
  return cadIr.bodies.map((body) => {
    if (typeof body !== "object" || body === null) return body;
    const record = body as Record<string, unknown>;
    const features = Array.isArray(record.features)
      ? record.features.map((feature) => {
          if (typeof feature !== "object" || feature === null) return feature;
          const f = feature as Record<string, unknown>;
          return { id: f.id, type: f.type, operation: f.operation ?? null };
        })
      : [];
    return { id: record.id, features };
  });
}

export interface CadDeskRuntimeOptions {
  dataDir?: string;
  store?: ProjectStore;
  worker?: CadWorker;
}

export class CadDeskRuntime {
  readonly #dataDir: string;
  readonly #store: ProjectStore;
  readonly #worker: CadWorker;

  constructor(options: CadDeskRuntimeOptions = {}) {
    this.#dataDir = resolve(options.dataDir ?? process.env.CAD3MF_DATA_DIR ?? ".cad3mf-data");
    mkdirSync(this.#dataDir, { recursive: true });
    this.#store = options.store ?? new ProjectStore(join(this.#dataDir, "caddesk.sqlite"));
    this.#worker = options.worker ?? new CadWorker();
  }

  createDesign(input: CreateDesignInput): JsonObject {
    const projectId = requireProjectId(input.projectId);
    const revisionId = "r1";
    const cadIr = cloneJson(input.cadIr);
    cadIr.project_id = projectId;
    cadIr.revision_id = revisionId;
    cadIr.parent_revision_id = null;
    cadIr.units = input.units;
    cadIr.manufacturing = {
      process: input.manufacturingProcess,
      material: input.material,
    };

    const createdAt = new Date().toISOString();
    const manifest = this.#worker.build(cadIr, this.#revisionDir(projectId, revisionId));
    const project: StoredProject = {
      projectId,
      designSpec: input.designSpec,
      units: input.units,
      manufacturingProcess: input.manufacturingProcess,
      material: input.material,
      latestRevisionId: revisionId,
      createdAt,
      updatedAt: createdAt,
    };
    const revision: StoredRevision = {
      projectId,
      revisionId,
      parentRevisionId: null,
      cadIr,
      validation: manifest.validation,
      artifacts: manifest.artifacts,
      createdAt,
    };
    this.#store.createProject(project, revision);

    return this.#designResult(project, revision);
  }

  modifyDesign(input: ModifyDesignInput): JsonObject {
    const projectId = requireProjectId(input.projectId);
    const base = this.#store.getRevision(projectId, input.baseRevisionId);
    const revisionId = this.#store.nextRevisionId(projectId);
    const cadIr = cloneJson(base.cadIr);
    const parameters = parameterMap(cadIr);

    if (!(input.change.name in parameters)) {
      throw new Error(`unknown parameter ${input.change.name}`);
    }
    parameters[input.change.name] = input.change.value;
    cadIr.revision_id = revisionId;
    cadIr.parent_revision_id = base.revisionId;

    const createdAt = new Date().toISOString();
    const manifest = this.#worker.build(cadIr, this.#revisionDir(projectId, revisionId));
    const revision: StoredRevision = {
      projectId,
      revisionId,
      parentRevisionId: base.revisionId,
      cadIr,
      validation: manifest.validation,
      artifacts: manifest.artifacts,
      createdAt,
    };
    this.#store.addRevision(revision);

    return this.#designResult(this.#store.getProject(projectId), revision);
  }

  inspectDesign(projectId: string, revisionId?: string): JsonObject {
    const project = this.#store.getProject(requireProjectId(projectId));
    const revision = this.#store.getRevision(project.projectId, revisionId);
    return {
      project_id: project.projectId,
      revision_id: revision.revisionId,
      parent_revision_id: revision.parentRevisionId,
      parameters: parameterMap(revision.cadIr),
      feature_tree: featureTree(revision.cadIr),
      geometry_summary: revision.validation,
    };
  }

  renderDesign(projectId: string, revisionId?: string): JsonObject {
    const artifact = this.artifactLocation(projectId, "preview", revisionId);
    return {
      project_id: artifact.projectId,
      revision_id: artifact.revisionId,
      preview_path: artifact.path,
      preview_uri: pathToFileURL(resolve(artifact.path)).href,
    };
  }

  validateDesign(projectId: string, revisionId?: string): JsonObject {
    const revision = this.#store.getRevision(requireProjectId(projectId), revisionId);
    return {
      project_id: revision.projectId,
      revision_id: revision.revisionId,
      validation: revision.validation,
    };
  }

  exportDesign(projectId: string, format: "step" | "stl" | "3mf", revisionId?: string): JsonObject {
    const artifact = this.artifactLocation(projectId, format, revisionId);
    return {
      project_id: artifact.projectId,
      revision_id: artifact.revisionId,
      format,
      artifact_path: artifact.path,
      artifact_uri: pathToFileURL(resolve(artifact.path)).href,
    };
  }

  artifactLocation(
    projectId: string,
    kind: ArtifactKind,
    revisionId?: string,
  ): { projectId: string; revisionId: string; path: string } {
    const revision = this.#store.getRevision(requireProjectId(projectId), revisionId);
    const path = revision.artifacts[kind];
    if (!path) throw new Error(`revision has no ${kind} artifact`);
    return { projectId: revision.projectId, revisionId: revision.revisionId, path };
  }

  cadIrSchema(): JsonObject {
    return this.#worker.cadIrSchema();
  }

  #revisionDir(projectId: string, revisionId: string): string {
    return join(this.#dataDir, "projects", projectId, "revisions", revisionId);
  }

  #designResult(project: StoredProject, revision: StoredRevision): JsonObject {
    return {
      project_id: project.projectId,
      revision_id: revision.revisionId,
      parent_revision_id: revision.parentRevisionId,
      parameters: parameterMap(revision.cadIr),
      geometry_summary: revision.validation,
      artifacts: revision.artifacts,
    };
  }
}
