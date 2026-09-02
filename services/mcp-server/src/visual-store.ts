import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { M1JobManifest } from "./jobs.js";

export type VisualDocumentKind = "design_intent" | "visual_concept" | "turnaround_set";

export interface StoredVisualArtifact {
  projectId: string;
  artifactId: string;
  path: string;
  sha256: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  createdAt: string;
}

type Row = Record<string, unknown>;

function asRow(value: unknown, message: string): Row {
  if (typeof value !== "object" || value === null) throw new Error(message);
  return value as Row;
}

function revisionPrefix(kind: VisualDocumentKind): string {
  if (kind === "design_intent") return "intent";
  if (kind === "visual_concept") return "concept";
  return "turnaround";
}

export class VisualStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS visual_documents (
        project_id TEXT NOT NULL,
        document_kind TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        revision_index INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, document_kind, revision_id),
        UNIQUE (project_id, document_kind, revision_index)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS visual_artifacts (
        project_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        media_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, artifact_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS visual_jobs (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_visual_documents_latest
        ON visual_documents(project_id, document_kind, revision_index DESC);
      CREATE INDEX IF NOT EXISTS idx_visual_jobs_project
        ON visual_jobs(project_id, updated_at DESC);
    `);
  }

  close(): void {
    this.#db.close();
  }

  nextRevisionId(projectId: string, kind: VisualDocumentKind): string {
    const row = asRow(
      this.#db
        .prepare(
          "SELECT COALESCE(MAX(revision_index), 0) AS current FROM visual_documents WHERE project_id = ? AND document_kind = ?",
        )
        .get(projectId, kind),
      "failed to calculate visual revision",
    );
    return `${revisionPrefix(kind)}-r${Number(row.current) + 1}`;
  }

  addDocument(
    projectId: string,
    kind: VisualDocumentKind,
    revisionId: string,
    document: Record<string, unknown>,
    createdAt: string,
  ): void {
    const row = asRow(
      this.#db
        .prepare(
          "SELECT COALESCE(MAX(revision_index), 0) AS current FROM visual_documents WHERE project_id = ? AND document_kind = ?",
        )
        .get(projectId, kind),
      "failed to calculate visual revision index",
    );
    const revisionIndex = Number(row.current) + 1;
    this.#db
      .prepare(`
        INSERT INTO visual_documents (
          project_id, document_kind, revision_id, revision_index, document_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(projectId, kind, revisionId, revisionIndex, JSON.stringify(document), createdAt);
  }

  getDocument(
    projectId: string,
    kind: VisualDocumentKind,
    revisionId?: string,
  ): Record<string, unknown> {
    const row = revisionId
      ? this.#db
          .prepare(
            "SELECT document_json FROM visual_documents WHERE project_id = ? AND document_kind = ? AND revision_id = ?",
          )
          .get(projectId, kind, revisionId)
      : this.#db
          .prepare(
            "SELECT document_json FROM visual_documents WHERE project_id = ? AND document_kind = ? ORDER BY revision_index DESC LIMIT 1",
          )
          .get(projectId, kind);
    const record = asRow(
      row,
      `unknown ${kind} ${projectId}${revisionId ? `/${revisionId}` : ""}`,
    );
    return JSON.parse(String(record.document_json)) as Record<string, unknown>;
  }

  saveArtifact(artifact: StoredVisualArtifact): void {
    this.#db
      .prepare(`
        INSERT INTO visual_artifacts (
          project_id, artifact_id, path, sha256, media_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        artifact.projectId,
        artifact.artifactId,
        artifact.path,
        artifact.sha256,
        artifact.mediaType,
        artifact.createdAt,
      );
  }

  getArtifact(projectId: string, artifactId: string): StoredVisualArtifact {
    const row = asRow(
      this.#db
        .prepare(
          "SELECT * FROM visual_artifacts WHERE project_id = ? AND artifact_id = ?",
        )
        .get(projectId, artifactId),
      `unknown visual artifact ${projectId}/${artifactId}`,
    );
    const mediaType = String(row.media_type);
    if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") {
      throw new Error(`unsupported stored visual media type ${mediaType}`);
    }
    return {
      projectId: String(row.project_id),
      artifactId: String(row.artifact_id),
      path: String(row.path),
      sha256: String(row.sha256),
      mediaType,
      createdAt: String(row.created_at),
    };
  }

  saveJob(job: M1JobManifest): void {
    this.#db
      .prepare(`
        INSERT INTO visual_jobs (job_id, project_id, manifest_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          manifest_json = excluded.manifest_json,
          updated_at = excluded.updated_at
      `)
      .run(job.job_id, job.project_id, JSON.stringify(job), job.updated_at);
  }

  getJob(jobId: string): M1JobManifest {
    const row = asRow(
      this.#db.prepare("SELECT manifest_json FROM visual_jobs WHERE job_id = ?").get(jobId),
      `unknown visual job ${jobId}`,
    );
    return JSON.parse(String(row.manifest_json)) as M1JobManifest;
  }
}
