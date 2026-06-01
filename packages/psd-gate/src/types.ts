export interface LayerManifest {
  name: string;
  path: string;
  kind: 'group' | 'layer';
  top: number | null;
  left: number | null;
  bottom: number | null;
  right: number | null;
  width: number | null;
  height: number | null;
  hidden: boolean;
  opacity: number | null;
  blendMode: string | null;
  childCount: number;
  hasImageData: boolean;
  hasRawData: boolean;
  rawChannelCount: number;
}

export interface PsdManifest {
  file: string;
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  channels: number | null;
  bitsPerChannel: number | null;
  colorMode: number | null;
  childCount: number;
  layerCount: number;
  groupCount: number;
  maxDepth: number;
  layers: LayerManifest[];
  hasCompositeImageData: boolean;
  compositeHash: string | null;
  warnings: string[];
}

export interface DiffMetric {
  template: string;
  pass: boolean;
  originalBytes: number;
  roundtripBytes: number;
  originalSha256: string;
  roundtripSha256: string;
  dimensionsMatch: boolean;
  channelsMatch: boolean;
  bitsPerChannelMatch: boolean;
  colorModeMatch: boolean;
  layerTreeMatch: boolean;
  layerTreeDiffs: string[];
  compositeComparable: boolean;
  compositeDiffPixels: number | null;
  compositeDiffRatio: number | null;
  maxChannelDelta: number | null;
  warnings: string[];
}
