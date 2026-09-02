export type VisualProductKind =
  | "figurine"
  | "character"
  | "modular_product"
  | "vehicle"
  | "mechanical_part"
  | "hybrid"
  | "other";

export type VisualSourceRole =
  | "identity_reference"
  | "concept"
  | "front"
  | "left"
  | "right"
  | "back"
  | "three_quarter_front"
  | "three_quarter_back"
  | "sketch"
  | "dimension_reference"
  | "other";

export type VisualMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface VisualSourceAsset {
  assetId: string;
  sha256: string;
  mediaType: VisualMediaType;
  role: VisualSourceRole;
}

export interface VisualDimension {
  name: string;
  value: number;
  unit: "mm";
  source: "user" | "measured_reference" | "inferred" | "default";
  confidence?: number;
}

export interface VisualObservedFeature {
  id: string;
  type: string;
  value: string | number | boolean | string[];
  confidence: number;
  evidenceAssetIds: string[];
  userConfirmed?: boolean;
}

export interface VisualAssumption {
  id: string;
  statement: string;
  confidence: number;
  userConfirmed: boolean;
}

export interface VisualQuestion {
  id: string;
  prompt: string;
  required: boolean;
  status: "open" | "answered" | "waived";
  answer?: string | null;
}

export interface AnalyzeVisualInput {
  projectId?: string;
  productKind: VisualProductKind;
  designPrompt: string;
  style?: string | null;
  requestedFunctions?: string[];
  sourceAssets: VisualSourceAsset[];
  knownDimensions?: VisualDimension[];
}

export interface VisualAnalysisResult {
  observedFeatures: VisualObservedFeature[];
  assumptions: VisualAssumption[];
  questions: VisualQuestion[];
  notes: string[];
}

export interface GeneratedVisualImage {
  bytes: Uint8Array;
  mediaType: VisualMediaType;
  widthPx: number;
  heightPx: number;
}

export interface VisualDecision {
  id: string;
  prompt: string;
  required: boolean;
  status: "open" | "answered" | "waived";
  answer?: string | null;
}

export interface ConceptGenerationResult {
  brief: string;
  designNotes: string[];
  openDecisions: VisualDecision[];
  images: GeneratedVisualImage[];
}

export type TurnaroundViewName =
  | "front"
  | "left"
  | "right"
  | "back"
  | "three_quarter_front"
  | "three_quarter_back";

export interface GeneratedTurnaroundView extends GeneratedVisualImage {
  view: TurnaroundViewName;
  projection: "orthographic_like" | "perspective";
  notes?: string | null;
}

export interface TurnaroundGenerationResult {
  views: GeneratedTurnaroundView[];
  consistency: {
    pass: boolean;
    identityScore: number;
    styleScore: number;
    silhouetteScore: number;
    warnings: string[];
  };
}

export interface VisualProviderContext {
  projectId: string;
  productKind: VisualProductKind;
  designPrompt: string;
  style: string | null;
  requestedFunctions: string[];
  sourceAssets: VisualSourceAsset[];
  knownDimensions: VisualDimension[];
}

export interface ConceptProviderContext extends VisualProviderContext {
  designIntent: Record<string, unknown>;
}

export interface TurnaroundProviderContext extends VisualProviderContext {
  visualConcept: Record<string, unknown>;
  coveragePolicy: "minimum_four_view" | "full_six_view";
}
