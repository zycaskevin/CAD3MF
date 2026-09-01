import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { StoredProject, StoredRevision } from "./types.js";

type Row = Record<string, unknown>;

function asRow(value: unknown, message: string): Row {
  if (typeof value !== "object" || value === null) {
    throw new Error(message);
  }
  return value as Row;
}

function projectFromRow(row: Row): StoredProject {
  return {
    projectId: String(row.project_id),
    designSpec: String(row.design_spec),
    units: String(row.units),
    manufacturingProcess: String(row.manufacturing_process),
    material: String(row.material),
    latestRevisionId: String(row.latest_revision_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function revisionFromRow(row: Row): StoredRevision {
  return {
    projectId: String(row.project_id),
    revisionId: String(row.revision_id),
    parentRevisionId: row.parent_revision_id === null ? null : String(row.parent_revision_id),
    cadIr: JSON.parse(String(row.cad_ir_json)) as Record<string, unknown>,
    validation: JSON.parse(String(row.validation_json)) as Record<string, unknown>,
    artifacts: JSON.parse(String(row.artifacts_json)) as Record<string, string>,
    createdAt: String(row.created_at),
  };
}

export class ProjectStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        design_spec TEXT NOT NULL,
        units TEXT NOT NULL,
        manufacturing_process TEXT NOT NULL,
        material TEXT NOT NULL,
        latest_revision_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS revisions (
        project_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        parent_revision_id TEXT,
        cad_ir_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, revision_id),
        FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_revisions_project_created
        ON revisions(project_id, created_at);
    `);
  }

  close(): void {
    this.#db.close();
  }

  createProject(project: StoredProject, revision: StoredRevision): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(`
          INSERT INTO projects (
            project_id, design_spec, units, manufacturing_process, material,
            latest_revision_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          project.projectId,
          project.designSpec,
          project.units,
          project.manufacturingProcess,
          project.material,
          project.latestRevisionId,
          project.createdAt,
          project.updatedAt,
        );
      this.#insertRevision(revision);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  addRevision(revision: StoredRevision): void {
    const now = revision.createdAt;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#insertRevision(revision);
      const result = this.#db
        .prepare("UPDATE projects SET latest_revision_id = ?, updated_at = ? WHERE project_id = ?")
        .run(revision.revisionId, now, revision.projectId);
      if (result.changes !== 1) {
        throw new Error(`unknown project ${revision.projectId}`);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getProject(projectId: string): StoredProject {
    const row = this.#db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId);
    return projectFromRow(asRow(row, `unknown project ${projectId}`));
  }

  getRevision(projectId: string, revisionId?: string): StoredRevision {
    const resolvedRevisionId = revisionId ?? this.getProject(projectId).latestRevisionId;
    const row = this.#db
      .prepare("SELECT * FROM revisions WHERE project_id = ? AND revision_id = ?")
      .get(projectId, resolvedRevisionId);
    return revisionFromRow(
      asRow(row, `unknown revision ${projectId}/${resolvedRevisionId}`),
    );
  }

  nextRevisionId(projectId: string): string {
    this.getProject(projectId);
    const row = asRow(
      this.#db.prepare("SELECT COUNT(*) AS count FROM revisions WHERE project_id = ?").get(projectId),
      `failed to count revisions for ${projectId}`,
    );
    return `r${Number(row.count) + 1}`;
  }

  #insertRevision(revision: StoredRevision): void {
    this.#db
      .prepare(`
        INSERT INTO revisions (
          project_id, revision_id, parent_revision_id, cad_ir_json,
          validation_json, artifacts_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        revision.projectId,
        revision.revisionId,
        revision.parentRevisionId,
        JSON.stringify(revision.cadIr),
        JSON.stringify(revision.validation),
        JSON.stringify(revision.artifacts),
        revision.createdAt,
      );
  }
}
