import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BuildManifest, JsonObject } from "./types.js";

export class CadWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CadWorkerError";
  }
}

export interface CadWorkerOptions {
  repoRoot?: string;
  python?: string;
}

export class CadWorker {
  readonly #repoRoot: string;
  readonly #python: string;

  constructor(options: CadWorkerOptions = {}) {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const inferredRepoRoot = resolve(moduleDir, "../../..");
    this.#repoRoot = resolve(options.repoRoot ?? process.env.CAD3MF_REPO_ROOT ?? inferredRepoRoot);
    this.#python = options.python ?? process.env.CAD3MF_PYTHON ?? "python3";
  }

  build(cadIr: JsonObject, outputDir: string): BuildManifest {
    mkdirSync(outputDir, { recursive: true });
    const specPath = resolve(outputDir, "cad-ir.json");
    writeFileSync(specPath, `${JSON.stringify(cadIr, null, 2)}\n`, "utf8");

    this.#run(["-m", "cad3mf_worker.cli", "build", specPath, "--out", outputDir]);
    const manifestPath = resolve(outputDir, "build.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BuildManifest;
    if (!manifest.project_id || !manifest.revision_id || !manifest.artifacts || !manifest.validation) {
      throw new CadWorkerError("cad-worker returned an incomplete build manifest");
    }
    return manifest;
  }

  cadIrSchema(): JsonObject {
    const output = this.#run(["-m", "cad3mf_worker.cli", "schema"]);
    const parsed = JSON.parse(output) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new CadWorkerError("cad-worker returned an invalid CAD-IR schema");
    }
    return parsed as JsonObject;
  }

  #run(args: string[]): string {
    const pythonPath = [
      resolve(this.#repoRoot, "packages/cad-ir/src"),
      resolve(this.#repoRoot, "packages/cad-compiler/src"),
      resolve(this.#repoRoot, "services/cad-worker/src"),
      resolve(this.#repoRoot, "adapters/cadquery/src"),
      process.env.PYTHONPATH,
    ]
      .filter((value): value is string => Boolean(value))
      .join(delimiter);

    const result = spawnSync(this.#python, args, {
      cwd: this.#repoRoot,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: pythonPath },
      maxBuffer: 10 * 1024 * 1024,
    });

    if (result.error) {
      throw new CadWorkerError(`failed to start CAD worker: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
      throw new CadWorkerError(`CAD worker failed: ${detail}`);
    }
    return result.stdout;
  }
}
