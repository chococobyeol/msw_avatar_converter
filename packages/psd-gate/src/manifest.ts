import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { readPsd, type Layer, type Psd } from 'ag-psd';
import { ensureCanvasInitialized } from './canvas.js';
import type { LayerManifest, PsdManifest } from './types.js';

export function sha256(buffer: Uint8Array | Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function listTemplatePaths(root = 'avatartemplate'): string[] {
  return readdirSync(root)
    .filter((name) => name.toLowerCase().endsWith('.psd'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(root, name));
}

function flattenLayers(layers: Layer[] | undefined, parentPath = '', depth = 1): { flat: LayerManifest[]; maxDepth: number } {
  const result: LayerManifest[] = [];
  let maxDepth = depth - 1;
  for (const layer of layers ?? []) {
    const name = layer.name ?? '<unnamed>';
    const layerPath = parentPath ? `${parentPath}/${name}` : name;
    const hasChildren = Array.isArray(layer.children) && layer.children.length > 0;
    const top = layer.top ?? null;
    const left = layer.left ?? null;
    const bottom = layer.bottom ?? null;
    const right = layer.right ?? null;
    result.push({
      name,
      path: layerPath,
      kind: hasChildren ? 'group' : 'layer',
      top,
      left,
      bottom,
      right,
      width: left == null || right == null ? null : right - left,
      height: top == null || bottom == null ? null : bottom - top,
      hidden: Boolean(layer.hidden),
      opacity: layer.opacity ?? null,
      blendMode: layer.blendMode ?? null,
      childCount: layer.children?.length ?? 0,
      hasImageData: Boolean(layer.imageData),
      hasRawData: Boolean(layer.rawData),
      rawChannelCount: layer.rawData?.channels?.length ?? 0,
    });
    maxDepth = Math.max(maxDepth, depth);
    const children = flattenLayers(layer.children, layerPath, depth + 1);
    result.push(...children.flat);
    maxDepth = Math.max(maxDepth, children.maxDepth);
  }
  return { flat: result, maxDepth };
}

export function readTemplate(file: string, options: { useImageData?: boolean; useRawData?: boolean } = {}): Psd {
  ensureCanvasInitialized();
  const buffer = readFileSync(file);
  return readPsd(buffer, {
    skipThumbnail: true,
    skipLinkedFilesData: true,
    useImageData: options.useImageData ?? true,
    useRawData: options.useRawData ?? false,
    logMissingFeatures: true,
  });
}

export function manifestFor(file: string, psd = readTemplate(file)): PsdManifest {
  const buffer = readFileSync(file);
  const layers = flattenLayers(psd.children);
  const groups = layers.flat.filter((layer) => layer.kind === 'group').length;
  const compositeHash = psd.imageData?.data ? sha256(Buffer.from(psd.imageData.data.buffer, psd.imageData.data.byteOffset, psd.imageData.data.byteLength)) : null;
  return {
    file,
    sizeBytes: statSync(file).size,
    sha256: sha256(buffer),
    width: psd.width,
    height: psd.height,
    channels: psd.channels ?? null,
    bitsPerChannel: psd.bitsPerChannel ?? null,
    colorMode: psd.colorMode ?? null,
    childCount: psd.children?.length ?? 0,
    layerCount: layers.flat.length - groups,
    groupCount: groups,
    maxDepth: layers.maxDepth,
    layers: layers.flat,
    hasCompositeImageData: Boolean(psd.imageData),
    compositeHash,
    warnings: [],
  };
}

export function comparableLayerSignature(manifest: PsdManifest): string[] {
  return manifest.layers.map((layer) => [
    layer.path,
    layer.kind,
    layer.top,
    layer.left,
    layer.bottom,
    layer.right,
    layer.hidden,
    layer.opacity,
    layer.blendMode,
    layer.childCount,
  ].join('|'));
}
