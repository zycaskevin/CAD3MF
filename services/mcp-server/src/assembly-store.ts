import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

type AssemblyDocumentKind = "assembly_ir" | "assembly_validation";
type Row = Record<string, unknown>;

function asRow(value: unknown, message: string): Row {
  if (typeof value !== "object" || value === null) throw new Error(message);
  return value as Row;
}

function prefix(kind: AssemblyDocumentKind): string {
  return kind === "assembly_ir" ? "assembly" : "assembly-validation";
}

export class AssemblyStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS assembly_documents (
        project_id TEXT NOT NULL,
        document_kind TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        revision_index INTEGER NOT NULL,
        document_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, document_kind, revision_id),
        UNIQUE (project_id, document_kind, revision_index)
      ) STRICT;
    `);
  }

  nextRevisionId(projectId: string, kind: AssemblyDocumentKind): string {
    const row = asRow(
      this.#db.prepare(
        "SELECT COALESCE(MAX(revision_index), 0) AS current FROM assembly_documents WHERE project_id = ? AND document_kind = ?",
      ).get(projectId, kind),
      "failed to calculate assembly revision",
    );
    return `${prefix(kind)}-r${Number(row.current) + 1}`;
  }

  addDocument(
    projectId: string,
    kind: AssemblyDocumentKind,
    revisionId: string,
    document: Record<string, unknown>,
    createdAt: string,
  ): void {
    const row = asRow(
      this.#db.prepare(
        "SELECT COALESCE(MAX(revision_index), 0) AS current FROM assembly_documents WHERE project_id = ? AND document_kind = ?",
      ).get(projectId, kind),
      "failed to calculate assembly revision index",
    );
    this.#db.prepare(`
      INSERT INTO assembly_documents (
        project_id, document_kind, revision_id, revision_index, document_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      kind,
      revisionId,
      Number(row.current) + 1,
      JSON.stringify(document),
      createdAt,
    );
  }

  getDocument(
    projectId: string,
    kind: AssemblyDocumentKind,
    revisionId?: string,
  ): Record<string, unknown> {
    const row = revisionId
      ? this.#db.prepare(
          "SELECT document_json FROM assembly_documents WHERE project_id = ? AND document_kind = ? AND revision_id = ?",
        ).get(projectId, kind, revisionId)
      : this.#db.prepare(
          "SELECT document_json FROM assembly_documents WHERE project_id = ? AND document_kind = ? ORDER BY revision_index DESC LIMIT 1",
        ).get(projectId, kind);
    const record = asRow(
      row,
      `unknown ${kind} ${projectId}${revisionId ? `/${revisionId}` : ""}`,
    );
    return JSON.parse(String(record.document_json)) as Record<string, unknown>;
  }
}
