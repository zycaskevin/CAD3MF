export type EnvelopeSemanticRole =
  | "occupied"
  | "keep_out"
  | "motion_swept"
  | "required_contact";

export type EnvelopeComponentRole =
  | "battery"
  | "pcb"
  | "motor"
  | "camera"
  | "tof"
  | "speaker"
  | "wiring"
  | "chassis"
  | "shell"
  | "turret"
  | "service_volume"
  | "other";

export interface EngineeringTransform {
  x: number;
  y: number;
  z: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
}

export interface BoxEnvelopeShape {
  kind: "box";
  x: number;
  y: number;
  z: number;
}

export interface CylinderEnvelopeShape {
  kind: "cylinder";
  diameter: number;
  height: number;
  axis: "z";
}

export type EngineeringEnvelopeShape = BoxEnvelopeShape | CylinderEnvelopeShape;

export interface EngineeringEnvelopeInput {
  id: string;
  semanticRole: EnvelopeSemanticRole;
  componentRole: EnvelopeComponentRole;
  shape: EngineeringEnvelopeShape;
  transform: EngineeringTransform;
  clearanceMm?: number;
  required?: boolean;
  notes?: string | null;
}

export interface DefineEngineeringEnvelopeSetInput {
  projectId: string;
  sourceAssetRevisionId?: string | null;
  coordinateFrame?: {
    name: string;
    originPolicy: "product_origin" | "chassis_origin" | "custom";
  };
  envelopes: EngineeringEnvelopeInput[];
  notes?: string[];
}
