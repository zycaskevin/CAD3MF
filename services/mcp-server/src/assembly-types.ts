export type AssemblyProductType =
  | "figurine_with_base"
  | "modular_tank"
  | "modular_vehicle"
  | "multi_part_product"
  | "hybrid"
  | "other";

export type AssemblySourceKind = "cad_ir" | "asset_ir" | "assembly_ir";

export type AssemblyPartRole =
  | "structural"
  | "shell"
  | "figurine"
  | "base"
  | "connector"
  | "decorative"
  | "replaceable_module"
  | "other";

export type AssemblyInterfaceType =
  | "magnetic_mount"
  | "snap_fit"
  | "peg_socket"
  | "screw"
  | "dovetail"
  | "press_fit"
  | "glue"
  | "free_placement";

export interface AssemblyTransformInput {
  x: number;
  y: number;
  z: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
}

export interface AssemblyPartInput {
  id: string;
  sourceKind: AssemblySourceKind;
  sourceRef: string;
  sourceArtifactSha256?: string | null;
  role: AssemblyPartRole;
  transform: AssemblyTransformInput;
  requiredForProduct?: boolean;
}

export interface AssemblyInterfaceSpecInput {
  clearanceMm?: number | null;
  toleranceMm?: number | null;
  magnetDiameterMm?: number | null;
  magnetDepthMm?: number | null;
  pegDiameterMm?: number | null;
  engagementDepthMm?: number | null;
  screwStandard?: string | null;
  adhesiveGapMm?: number | null;
}

export interface AssemblyInterfaceInput {
  id: string;
  type: AssemblyInterfaceType;
  partA: string;
  partB: string;
  spec?: AssemblyInterfaceSpecInput;
}

export interface DefineAssemblyInput {
  projectId: string;
  productType: AssemblyProductType;
  parts: AssemblyPartInput[];
  interfaces?: AssemblyInterfaceInput[];
  notes?: string[];
}
