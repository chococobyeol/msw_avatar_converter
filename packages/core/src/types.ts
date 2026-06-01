export type SourceKind = 'image-upload' | 'public-meaegi' | 'nexon-api' | 'future-ai';
export type TargetPartId =
  | 'cap-a1' | 'cap-a2' | 'cap-ani' | 'cap-b' | 'cap-c1' | 'cap-c2' | 'cap-d' | 'cap-e' | 'cap-f' | 'cap-g'
  | 'cape' | 'cape-balloon' | 'gloves' | 'hair' | 'longcoat' | 'pants' | 'shoes';

export interface SourceAsset {
  id: string;
  kind: SourceKind;
  label: string;
  uri?: string;
  provenance: {
    acquiredAt: string;
    publicNoLogin: boolean;
    userProvided: boolean;
    notes?: string;
  };
  metadata: Record<string, unknown>;
}

export interface SourcePart {
  id: string;
  label: string;
  category: string;
  assetIds: string[];
  metadata: Record<string, unknown>;
}

export interface SourceFrame {
  id: string;
  action: string;
  frameIndex: number;
  partId: string;
  assetId: string;
  imageRef: string;
  width: number;
  height: number;
  anchor?: Anchor;
  durationMs?: number;
}

export interface SourceFrameSet {
  id: string;
  sourceKind: SourceKind;
  assets: SourceAsset[];
  parts: SourcePart[];
  frames: SourceFrame[];
  actions: string[];
  completeDetectedAnimationRange: boolean;
  metadata: Record<string, unknown>;
}

export interface Anchor {
  x: number;
  y: number;
  origin: 'top-left' | 'center' | 'feet' | 'custom';
}

export interface FrameCoordinateSpace {
  origin: 'top-left';
  width: number;
  height: number;
  scale: number;
}

export interface CanonicalFrame {
  id: string;
  action: string;
  frameIndex: number;
  partId: string;
  rgbaBuffer: Uint8ClampedArray;
  width: number;
  height: number;
  anchor: Anchor;
  bounds: { left: number; top: number; right: number; bottom: number };
  durationMs?: number;
}

export interface NormalizedFrameSet {
  id: string;
  sourceFrameSetId: string;
  coordinateSpace: FrameCoordinateSpace;
  frames: CanonicalFrame[];
  actions: string[];
  policies: {
    scale: ScalePolicy;
    alpha: AlphaPolicy;
    color: ColorPolicy;
  };
}

export interface ScalePolicy {
  kind: 'exact-no-resample' | 'nearest-neighbor';
  factor: number;
}

export interface AlphaPolicy {
  kind: 'preserve-straight-alpha';
}

export interface ColorPolicy {
  kind: 'srgb-rgba';
}

export interface ValidationPolicy {
  kind: 'exact-rgba' | 'threshold-rgba';
  diffPixels: number;
  maxChannelDelta: number;
}

export interface TargetEditableLayer {
  path: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface TargetTemplatePart {
  id: TargetPartId;
  templatePath: string;
  width: number;
  height: number;
  frameGrid?: FrameGrid;
  editableLayerPaths: string[];
  editableLayers: TargetEditableLayer[];
}

export interface FrameGrid {
  actions: string[];
  cells: Array<{ action: string; frameIndex: number; left: number; top: number; width: number; height: number; layerPath: string }>;
}

export interface MappingPlan {
  id: string;
  sourcePartIds: string[];
  targetPartId: TargetPartId;
  mode: 'part' | 'group' | 'whole-avatar';
  userConfirmedAt: string;
  placement: {
    anchor: Anchor;
    offsetX: number;
    offsetY: number;
  };
}

export interface FrameProjectionCell {
  sourceAction: string;
  sourceFrameIndex: number;
  targetAction: string;
  targetFrameIndex: number;
}

export interface FrameProjectionPlan {
  cells: FrameProjectionCell[];
}

export interface ConversionJob {
  id: string;
  sourceFrameSet: SourceFrameSet;
  normalizedFrameSet: NormalizedFrameSet;
  mappings: MappingPlan[];
  validationPolicy: ValidationPolicy;
  outputDir: string;
  frameProjectionPlan?: FrameProjectionPlan;
}

export interface ValidationFrameResult {
  action: string;
  frameIndex: number;
  pass: boolean;
  diffPixels: number;
  diffRatio: number;
  maxChannelDelta: number;
  diffImagePath?: string;
}

export interface ValidationReport {
  jobId: string;
  policy: ValidationPolicy;
  pass: boolean;
  frames: ValidationFrameResult[];
}
