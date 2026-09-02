import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { M1JobManifest } from "./jobs.js";
import type { MeshFormat } from "./mesh-types.js";

export interface StoredMeshArtifact {
  projectId: string;
  artifactId: string;
  path: string;
  sha256: string;
  format: MeshFormat;
  mediaType: "model/gltf-binary" | "model/obj" | "model/ply";
  createdAt: string;
}

type MeshDocumentKind = "mesh_request" | "mesh_artifact" | "asset_ir";
type Row = Record<string, unknown>;

function asRow(value: unknown, message: string): Row {
  if (typeof value !== "object" || value === null) throw new Error(message);
  return value as Row;
}

function prefix(kind: MeshDocumentKind): string {
  if (kind === "mesh_request") return "mesh-request";
  if (kind === "mesh_artifact") return "mesh-artifact";
  return "asset";
}

export class MeshStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS mesh_documents (
        project_id TEXT NOT NULL,
        document_kind TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        revision_index INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, document_kind, revision_id),
        UNIQUE (project_id, document_kind, revision_index)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS mesh_artifacts (
        project_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        format TEXT NOT NULL,
        media_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, artifact_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS mesh_jobs (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  nextRevisionId(projectId: string, kind: MeshDocumentKind): string {
    const row = asRow(
      this.#db.prepare(
        "SELECT COALESCE(MAX(revision_index), 0) AS current FROM mesh_documents WHERE project_id = ? AND document_kind = ?",
      ).get(projectId, kind),
      "failed to calculate mesh revision",
    );
    return `${prefix(kind)}-r${Number(row.current) + 1}`;
  }

  addDocument(projectId: string, kind: MeshDocumentKind, revisionId: string, document: Record<string, unknown>, createdAt: string): void {
    const row = asRow(
      this.#db.prepare(
        "SELECT COALESCE(MAX(revision_index), 0) AS current FROM mesh_documents WHERE project_id = ? AND document_kind = ?",
      ).get(projectId, kind),
      "failed to calculate mesh revision index",
    );
    this.#db.prepare(`
      INSERT INTO mesh_documents (project_id, document_kind, revision_id, revision_index, document_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(projectId, kind, revisionId, Number(row.current) + 1, JSON.stringify(document), createdAt);
  }

  getDocument(projectId: string, kind: MeshDocumentKind, revisionId?: string): Record<string, unknown> {
    const row = revisionId
      ? this.#db.prepare(
          "SELECT document_json FROM mesh_documents WHERE project_id = ? AND document_kind = ? AND revision_id = ?",
        ).get(projectId, kind, revisionId)
      : this.#db.prepare(
          "SELECT document_json FROM mesh_documents WHERE project_id = ? AND document_kind = ? ORDER BY revision_index DESC LIMIT 1",
        ).get(projectId, kind);
    const record = asRow(row, `unknown ${kind} ${projectId}${revisionId ? `/${revisionId}` : ""}`);
    return JSON.parse(String(record.document_json)) as Record<string, unknown>;
  }

  saveArtifact(artifact: StoredMeshArtifact): void {
    this.#db.prepare(`
      INSERT INTO mesh_artifacts (project_id, artifact_id, path, sha256, format, media_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifact.projectId,
      artifact.artifactId,
      artifact.path,
      artifact.sha256,
      artifact.format,
      artifact.mediaType,
      artifact.createdAt,
    );
  }

  getArtifact(projectId: string, artifactId: string): StoredMeshArtifact {
    const row = asRow(
      this.#db.prepare("SELECT * FROM mesh_artifacts WHERE project_id = ? AND artifact_id = ?").get(projectId, artifactId),
      `unknown mesh artifact ${projectId}/${artifactId}`,
    );
    return {
      projectId: String(row.project_id),
      artifactId: String(row.artifact_id),
      path: String(row.path),
      sha256: String(row.sha256),
      format: String(row.format) as MeshFormat,
      mediaType: String(row.media_type) as StoredMeshArtifact["mediaType"],
      createdAt: String(row.created_at),
    };
  }

  saveJob(job: M1JobManifest): void {
    this.#db.prepare(`
      INSERT INTO mesh_jobs (job_id, project_id, manifest_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET manifest_json = excluded.manifest_json, updated_at = excluded.updated_at
    `).run(job.job_id, job.project_id, JSON.stringify(job), job.updated_at);
  }

  getJob(jobId: string): M1JobManifest {
    const row = asRow(this.#db.prepare("SELECT manifest_json FROM mesh_jobs WHERE job_id = ?").get(jobId), `unknown mesh job ${jobId}`);
    return JSON.parse(String(row.manifest_json)) as M1JobManifest;
  }
}
