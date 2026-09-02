import { DeterministicMeshProvider } from "./mesh-provider.js";
import { Sf3dHttpMeshProvider } from "./sf3d-provider.js";
import type { MeshProvider } from "./mesh-types.js";

export function createMeshProviderFromEnv(): MeshProvider {
  const configured = (process.env.CAD3MF_MESH_PROVIDER ?? "deterministic").trim().toLowerCase();
  if (configured === "deterministic" || configured === "deterministic-mesh-ci") {
    return new DeterministicMeshProvider();
  }
  if (configured === "sf3d-http" || configured === "stable-fast-3d") {
    return new Sf3dHttpMeshProvider();
  }
  throw new Error(`unsupported CAD3MF_MESH_PROVIDER ${configured}`);
}
