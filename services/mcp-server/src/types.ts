export type JsonObject = Record<string, unknown>;

export interface BuildManifest {
  project_id: string;
  revision_id: string;
  parent_revision_id: string | null;
  parameters: Record<string, number>;
  validation: JsonObject;
  artifacts: Record<string, string>;
}

export interface StoredProject {
  projectId: string;
  designSpec: string;
  units: string;
  manufacturingProcess: string;
  material: string;
  latestRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredRevision {
  projectId: string;
  revisionId: string;
  parentRevisionId: string | null;
  cadIr: JsonObject;
  validation: JsonObject;
  artifacts: Record<string, string>;
  createdAt: string;
}

export interface CreateDesignInput {
  projectId?: string;
  designSpec: string;
  units: "mm";
  manufacturingProcess: "fdm";
  material: string;
  cadIr: JsonObject;
}

export interface SetParameterChange {
  operation: "set_parameter";
  name: string;
  value: number;
}

export interface ModifyDesignInput {
  projectId: string;
  baseRevisionId?: string;
  change: SetParameterChange;
}
