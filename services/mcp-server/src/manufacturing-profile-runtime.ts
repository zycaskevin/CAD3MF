import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type FitPolicyKind = "default_clearance" | "loose_clearance" | "snap_fit_allowance";

function repoRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(process.env.CAD3MF_REPO_ROOT ?? resolve(moduleDir, "../../.."));
}

function profilesDir(): string {
  return resolve(repoRoot(), "packages/manufacturing/profiles");
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function loadProfileFile(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return record(parsed, "manufacturing profile must be a JSON object");
}

export class ManufacturingProfileRuntime {
  listProfiles(): Record<string, unknown>[] {
    return readdirSync(profilesDir())
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => loadProfileFile(resolve(profilesDir(), name)))
      .map((profile) => ({
        profile_id: profile.profile_id,
        profile_version: profile.profile_version,
        process: profile.process,
        material: profile.material,
        nozzle_diameter_mm: profile.nozzle_diameter_mm,
        machine_scope: profile.machine_scope,
        calibration: profile.calibration,
        status: profile.status,
      }));
  }

  getProfile(profileId: string): Record<string, unknown> {
    const found = this.listProfiles().find((profile) => profile.profile_id === profileId);
    if (!found) throw new Error(`unknown manufacturing profile ${profileId}`);
    const file = readdirSync(profilesDir())
      .filter((name) => name.endsWith(".json"))
      .map((name) => resolve(profilesDir(), name))
      .find((path) => loadProfileFile(path).profile_id === profileId);
    if (!file) throw new Error(`unknown manufacturing profile ${profileId}`);
    return loadProfileFile(file);
  }

  resolveFitPolicy(profileId: string, fitKind: FitPolicyKind): Record<string, unknown> {
    const profile = this.getProfile(profileId);
    const fit = record(profile.fit_policy, "manufacturing profile is missing fit_policy");
    const calibration = record(
      profile.calibration,
      "manufacturing profile is missing calibration metadata",
    );

    const key =
      fitKind === "default_clearance"
        ? "default_clearance_mm"
        : fitKind === "loose_clearance"
          ? "loose_clearance_mm"
          : "snap_fit_allowance_mm";
    const value = fit[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`manufacturing profile has invalid ${key}`);
    }

    return {
      profile_id: profile.profile_id,
      profile_version: profile.profile_version,
      fit_kind: fitKind,
      value_mm: value,
      value_semantics: fitKind === "snap_fit_allowance" ? "allowance" : "clearance",
      calibration_required: calibration.required === true,
      evidence_status: calibration.evidence_status,
      authoritative_for_machine:
        record(profile.machine_scope, "manufacturing profile is missing machine_scope")
          .machine_specific === true && calibration.evidence_status === "production_verified",
      warning:
        calibration.required === true
          ? "Starter fit value requires calibration on the actual printer/material/orientation before production."
          : null,
    };
  }
}
