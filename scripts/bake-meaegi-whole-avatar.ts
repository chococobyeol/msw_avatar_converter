import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas } from 'canvas';
import { PNG } from 'pngjs';
import { readPsd, writePsdBuffer, type Layer, type Psd } from 'ag-psd';
import { ensureCanvasInitialized } from '../packages/psd-gate/src/canvas.js';
import { writeRgbaPng } from '../packages/export/src/png.js';
import { buildMeaegiShareImport, extractMeaegiShareId, MEAEGI_GET_SHARE_ACTION_ID, parseMeaegiFlight } from '../src/meaegiShare.js';

interface BakedCell {
  action: string;
  frameIndex: number;
  col: number;
  row: number;
}

interface LoadedFrame {
  action: string;
  frameIndex: number;
  imageRef: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  bounds: { left: number; top: number; right: number; bottom: number; empty: boolean };
}

type Bounds = LoadedFrame['bounds'];
type FrameCorrection = { dx: number; dy: number; reason: string };
type FixedFramePlacementOffset = { dx: number; dy: number; reason: string };
type Anchor = { x: number; y: number; basis: string };
type PlacementRecord = {
  key: string;
  action: string;
  frameIndex: number;
  col: number;
  row: number;
  targetAnchor: Anchor;
  sourceAnchor: Anchor;
  correction: { dx: number; dy: number } | null;
  destLeft: number;
  destTop: number;
  actualAnchorInCell: { x: number; y: number };
  error: { dx: number; dy: number };
};

interface ComparisonArtifact {
  action: string;
  frameCount: number;
  gifPath: string | null;
  frameDir: string;
  sourceVsConvertedDiffPixels: number;
  sourceVsConvertedMaxDelta: number;
  sourceVsTemplateDiffPixels: number;
  sourceVsTemplateMaxDelta: number;
}

const targetConfigs = {
  cape: {
    templatePath: 'avatartemplate/Avatar_Cape.psd',
    outputName: 'Avatar_Cape.psd',
    editLayerPath: 'edithere:cape_capeOverHead_10',
    expandTargetLayerToCanvas: true,
    promoteTargetLayerToTop: true,
    removeZmapPreset: true,
  },
  'cape-balloon': {
    templatePath: 'avatartemplate/Avatar_Cape_balloon.psd',
    outputName: 'Avatar_Cape_balloon.psd',
    editLayerPath: 'edithere:cape_capeOverHead_10',
    expandTargetLayerToCanvas: true,
    promoteTargetLayerToTop: true,
    removeZmapPreset: true,
  },
  longcoat: {
    templatePath: 'avatartemplate/Avatar_Longcoat.psd',
    outputName: 'Avatar_Longcoat.psd',
    editLayerPath: 'edithere:mailArm_mailArmOverHair_22',
    expandTargetLayerToCanvas: true,
    promoteTargetLayerToTop: true,
    removeZmapPreset: true,
  },
} as const;

export type BakeTarget = keyof typeof targetConfigs;

export interface BakeMeaegiWholeAvatarInput {
  share: string;
  target?: BakeTarget;
  outDir?: string;
}

const cellWidth = 250;
const cellHeight = 250;
const referenceCalibrationShare = 'NvkIKXl2Xw64';

const fixedFramePlacementOffsets: Record<BakeTarget, FixedFramePlacementOffset> = {
  cape: {
    dx: 0,
    dy: 0,
    reason: 'target-level offset after frame anchors are matched from MeAegi reference body to Avatar_Cape.psd guide_character cells',
  },
  'cape-balloon': {
    dx: 0,
    dy: 0,
    reason: 'target-level offset after frame anchors are matched from MeAegi reference body to Avatar_Cape_balloon.psd guide_character cells',
  },
  longcoat: {
    dx: 0,
    dy: 0,
    reason: 'target-level offset after frame anchors are matched from MeAegi reference body to Avatar_Longcoat.psd guide_character cells',
  },
};

const manualFrameCorrections: Partial<Record<BakeTarget, Record<string, FrameCorrection>>> = {};

const bakedCells: BakedCell[] = [
  ...cells('걷기(한손)', 0, 0, 4),
  ...cells('걷기(두손)', 0, 1, 4),
  ...cells('기본(한손)', 0, 2, 3),
  ...cells('기본(두손)', 0, 3, 3),
  ...cells('전투 대기', 0, 4, 3),
  ...cells('스윙O1', 0, 5, 3),
  ...cells('스윙O2', 0, 6, 3),
  ...cells('스윙O3', 0, 7, 3),
  ...cells('스윙OF', 0, 8, 4),
  ...cells('스윙T1', 0, 9, 3),
  ...cells('스윙T2', 0, 10, 3),
  ...cells('스윙T3', 0, 11, 3),
  ...cells('스윙TF', 0, 12, 4),
  ...cells('사다리', 0, 13, 2),
  ...cells('찌르기O1', 5, 0, 2),
  ...cells('찌르기O2', 8, 0, 2),
  ...cells('찌르기T1', 5, 1, 3),
  ...cells('찌르기T2', 5, 2, 3),
  ...cells('엎드리기', 5, 3, 1),
  ...cells('엎드려 찌르기', 6, 3, 1, 1),
  ...cells('찌르기TF', 5, 4, 4),
  ...cells('날기', 5, 5, 2),
  ...cells('점프', 8, 5, 1),
  ...cells('쏘기(활)', 5, 6, 3),
  ...cells('쏘기F', 9, 6, 3),
  ...cells('쏘기(석궁)', 5, 7, 5),
  ...cells('스윙P1', 5, 9, 3),
  ...cells('스윙P2', 5, 10, 3),
  ...cells('스윙PF', 5, 11, 4),
  ...cells('앉기', 10, 11, 1),
  ...cells('찌르기OF', 5, 12, 3),
  ...cells('밧줄', 5, 13, 2),
];

function cells(action: string, startCol: number, row: number, count: number, sourceFrameStart = 0): BakedCell[] {
  return Array.from({ length: count }, (_, index) => ({ action, frameIndex: sourceFrameStart + index, col: startCol + index, row }));
}

function parseArgs() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    args.set(rawKey, inline ?? process.argv[i + 1] ?? '');
    if (inline === undefined) i += 1;
  }
  const share = extractMeaegiShareId(args.get('share') ?? args.get('url') ?? 'https://meaegi.com/dressing-room?share=5gcTvkPmcFn5');
  const target = (args.get('target') ?? 'cape') as BakeTarget;
  if (!(target in targetConfigs)) throw new Error(`Unknown target "${target}". Use cape, cape-balloon, or longcoat.`);
  return {
    share,
    target,
    outDir: args.get('out') ?? path.join('artifacts/whole-avatar-bake', share, target),
  };
}

async function loadMeaegiImport(share: string) {
  const upstream = await fetch('https://meaegi.com/dressing-room', {
    method: 'POST',
    headers: {
      'Next-Action': MEAEGI_GET_SHARE_ACTION_ID,
      'Content-Type': 'text/plain;charset=UTF-8',
      Accept: 'text/x-component',
    },
    body: JSON.stringify([share]),
  });
  const text = await upstream.text();
  if (!upstream.ok) throw new Error(`MeAegi returned HTTP ${upstream.status}.`);
  return buildMeaegiShareImport(share, parseMeaegiFlight(text));
}

async function loadPng(url: string): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Frame fetch failed ${response.status}: ${url}`);
  const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));
  return { width: png.width, height: png.height, rgba: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
}

function alphaBounds(width: number, height: number, rgba: Uint8ClampedArray): LoadedFrame['bounds'] {
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return { left, top, right, bottom, empty: right <= left || bottom <= top };
}

function over(dst: Uint8ClampedArray, dstOffset: number, src: Uint8ClampedArray, srcOffset: number): void {
  const sa = src[srcOffset + 3] / 255;
  if (sa <= 0) return;
  const da = dst[dstOffset + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    dst[dstOffset + channel] = Math.round((((src[srcOffset + channel] / 255) * sa) + ((dst[dstOffset + channel] / 255) * da * (1 - sa))) / oa * 255);
  }
  dst[dstOffset + 3] = Math.round(oa * 255);
}

function correctionKey(cell: Pick<BakedCell, 'action' | 'frameIndex'>): string {
  return `${cell.action}:${cell.frameIndex}`;
}

function anchorFromBounds(bounds: Bounds | undefined, fallback: Anchor, basis: string): Anchor {
  if (!bounds || bounds.empty) return fallback;
  return {
    x: Math.round((bounds.left + bounds.right - 1) / 2),
    y: bounds.bottom - 1,
    basis,
  };
}

function placementForCell(cell: BakedCell, targetAnchor: Anchor, sourceAnchor: Anchor, correction?: FrameCorrection, fixedOffset?: FixedFramePlacementOffset): PlacementRecord {
  const cellLeft = cell.col * cellWidth;
  const cellTop = cell.row * cellHeight;
  const correctionDx = correction?.dx ?? 0;
  const correctionDy = correction?.dy ?? 0;
  const fixedDx = fixedOffset?.dx ?? 0;
  const fixedDy = fixedOffset?.dy ?? 0;
  const destLeft = Math.round(cellLeft + targetAnchor.x - sourceAnchor.x + fixedDx + correctionDx);
  const destTop = Math.round(cellTop + targetAnchor.y - sourceAnchor.y + fixedDy + correctionDy);
  const actualAnchorInCell = {
    x: destLeft + sourceAnchor.x - cellLeft,
    y: destTop + sourceAnchor.y - cellTop,
  };
  return {
    key: correctionKey(cell),
    action: cell.action,
    frameIndex: cell.frameIndex,
    col: cell.col,
    row: cell.row,
    targetAnchor,
    sourceAnchor,
    correction: correction ? { dx: correction.dx, dy: correction.dy } : null,
    destLeft,
    destTop,
    actualAnchorInCell,
    error: {
      dx: actualAnchorInCell.x - targetAnchor.x - fixedDx - correctionDx,
      dy: actualAnchorInCell.y - targetAnchor.y - fixedDy - correctionDy,
    },
  };
}

function drawFrame(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, frame: LoadedFrame, placement: PlacementRecord): void {
  for (let y = 0; y < frame.height; y += 1) {
    const ty = placement.destTop + y;
    if (ty < 0 || ty >= sheetHeight) continue;
    for (let x = 0; x < frame.width; x += 1) {
      const tx = placement.destLeft + x;
      if (tx < 0 || tx >= sheetWidth) continue;
      over(sheet, (ty * sheetWidth + tx) * 4, frame.rgba, (y * frame.width + x) * 4);
    }
  }
}

async function loadFrameSetForCells(share: string, cellsToLoad: BakedCell[]): Promise<Map<string, LoadedFrame>> {
  const imported = await loadMeaegiImport(share);
  const uniqueFrames = new Map<string, { action: string; frameIndex: number; imageRef: string }>();
  for (const frame of imported.frames) {
    const key = `${frame.action}:${frame.frameIndex}`;
    if (!uniqueFrames.has(key) && frame.imageRef) uniqueFrames.set(key, { action: frame.action, frameIndex: frame.frameIndex, imageRef: frame.imageRef });
  }
  return loadFramesFromUniqueMap(uniqueFrames, cellsToLoad);
}

async function loadFramesFromUniqueMap(uniqueFrames: Map<string, { action: string; frameIndex: number; imageRef: string }>, cellsToLoad: BakedCell[]): Promise<Map<string, LoadedFrame>> {
  const frameByKey = new Map<string, LoadedFrame>();
  await Promise.all(cellsToLoad.map(async (cell) => {
    const key = `${cell.action}:${cell.frameIndex}`;
    const source = uniqueFrames.get(key);
    if (!source) throw new Error(`Missing MeAegi frame for supported template cell: ${key}`);
    if (frameByKey.has(key)) return;
    const loaded = await loadPng(source.imageRef);
    frameByKey.set(key, { ...source, ...loaded, bounds: alphaBounds(loaded.width, loaded.height, loaded.rgba) });
  }));
  return frameByKey;
}

function flatten(layers: Layer[] | undefined, parent = ''): Array<{ path: string; layer: Layer }> {
  const out: Array<{ path: string; layer: Layer }> = [];
  for (const layer of layers ?? []) {
    const current = parent ? `${parent}/${layer.name}` : layer.name ?? '';
    out.push({ path: current, layer });
    out.push(...flatten(layer.children, current));
  }
  return out;
}

function hideGuides(layers: Layer[] | undefined): void {
  for (const layer of layers ?? []) {
    if ((layer.name ?? '').startsWith('guide')) layer.hidden = true;
    hideGuides(layer.children);
  }
}

function promoteLayerToTop(psd: Psd, layerPath: string): void {
  if (!psd.children) return;
  const targetName = layerPath.split('/').at(-1);
  const index = psd.children.findIndex((layer) => layer.name === targetName);
  if (index <= 0) return;
  const [layer] = psd.children.splice(index, 1);
  psd.children.unshift(layer);
}

function removeZmapPresetLayers(layers: Layer[] | undefined): Layer[] | undefined {
  if (!layers) return layers;
  return layers
    .filter((layer) => {
      const name = layer.name ?? '';
      return !name.includes('data:use_zmap_preset') && !name.includes('zmap_preset');
    })
    .map((layer) => {
      layer.children = removeZmapPresetLayers(layer.children);
      return layer;
    });
}

function cropSheet(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, left: number, top: number, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = top + y;
    if (sourceY < 0 || sourceY >= sheetHeight) continue;
    for (let x = 0; x < width; x += 1) {
      const sourceX = left + x;
      if (sourceX < 0 || sourceX >= sheetWidth) continue;
      const sourceOffset = (sourceY * sheetWidth + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      out[targetOffset] = sheet[sourceOffset];
      out[targetOffset + 1] = sheet[sourceOffset + 1];
      out[targetOffset + 2] = sheet[sourceOffset + 2];
      out[targetOffset + 3] = sheet[sourceOffset + 3];
    }
  }
  return out;
}

function blitLayerToSheet(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, layer: Layer): void {
  const image = layer.imageData;
  if (!image?.data) return;
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  const data = image.data;
  for (let y = 0; y < image.height; y += 1) {
    const targetY = top + y;
    if (targetY < 0 || targetY >= sheetHeight) continue;
    for (let x = 0; x < image.width; x += 1) {
      const targetX = left + x;
      if (targetX < 0 || targetX >= sheetWidth) continue;
      const sourceOffset = (y * image.width + x) * 4;
      const targetOffset = (targetY * sheetWidth + targetX) * 4;
      if (data[sourceOffset + 3] === 0) continue;
      sheet[targetOffset] = data[sourceOffset];
      sheet[targetOffset + 1] = data[sourceOffset + 1];
      sheet[targetOffset + 2] = data[sourceOffset + 2];
      sheet[targetOffset + 3] = data[sourceOffset + 3];
    }
  }
}

function renderLayerSheet(psd: Psd, predicate: (entry: { path: string; layer: Layer }) => boolean): Uint8ClampedArray {
  const sheet = new Uint8ClampedArray(psd.width * psd.height * 4);
  for (const entry of flatten(psd.children)) {
    if (!predicate(entry)) continue;
    if (entry.layer.hidden || !entry.layer.imageData?.data) continue;
    blitLayerToSheet(sheet, psd.width, psd.height, entry.layer);
  }
  return sheet;
}

function renderEditableSheet(psd: Psd): Uint8ClampedArray {
  return renderLayerSheet(psd, (entry) => entry.path.includes('edithere:'));
}

function renderTemplateReferenceSheet(psd: Psd): Uint8ClampedArray {
  return renderLayerSheet(psd, (entry) => {
    const name = entry.layer.name ?? '';
    if (entry.path.startsWith('data/') || entry.path === 'data') return false;
    if (name === 'guide_background' || name === 'guide_grid') return false;
    return Boolean(entry.layer.imageData?.data);
  });
}

function installSheetLayer(psd: Psd, layerPath: string, sheet: Uint8ClampedArray, expandTargetLayerToCanvas: boolean): void {
  const entries = flatten(psd.children);
  const target = entries.find((entry) => entry.path === layerPath)?.layer;
  if (!target) throw new Error(`Layer not found: ${layerPath}`);
  for (const entry of entries.filter((candidate) => candidate.path.includes('edithere:'))) {
    const layer = entry.layer;
    layer.hidden = false;
    if (entry.path === layerPath && expandTargetLayerToCanvas) {
      layer.left = 0;
      layer.top = 0;
      layer.right = psd.width;
      layer.bottom = psd.height;
      layer.imageData = { width: psd.width, height: psd.height, data: sheet };
    } else {
      const left = layer.left ?? 0;
      const top = layer.top ?? 0;
      const width = Math.max(1, (layer.right ?? left + 1) - left);
      const height = Math.max(1, (layer.bottom ?? top + 1) - top);
      layer.imageData = {
        width,
        height,
        data: entry.path === layerPath ? cropSheet(sheet, psd.width, psd.height, left, top, width, height) : new Uint8ClampedArray(width * height * 4),
      };
    }
  }
  hideGuides(psd.children);
}

function diffBuffers(width: number, height: number, expected: Uint8ClampedArray, actual: Uint8ClampedArray) {
  const diff = new Uint8ClampedArray(width * height * 4);
  let diffPixels = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < expected.length; i += 4) {
    let pixelDifferent = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(expected[i + channel] - actual[i + channel]);
      if (delta > 0) pixelDifferent = true;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (pixelDifferent) {
      diffPixels += 1;
      diff[i] = 255;
      diff[i + 3] = 255;
    }
  }
  return { diff, diffPixels, maxChannelDelta, pass: diffPixels === 0 && maxChannelDelta === 0 };
}

function safeFrameFileName(action: string, frameIndex: number): string {
  return `${Buffer.from(action, 'utf8').toString('base64url')}-${frameIndex}.png`;
}

function cropCell(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, cell: BakedCell): Uint8ClampedArray {
  return cropSheet(sheet, sheetWidth, sheetHeight, cell.col * cellWidth, cell.row * cellHeight, cellWidth, cellHeight);
}

function cellBounds(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, cell: BakedCell): Bounds {
  return alphaBounds(cellWidth, cellHeight, cropCell(sheet, sheetWidth, sheetHeight, cell));
}

function safePathSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}


function overlayBuffers(base: Uint8ClampedArray, overlay: Uint8ClampedArray, overlayOpacity = 0.75): Uint8ClampedArray {
  const out = new Uint8ClampedArray(base);
  for (let i = 0; i < overlay.length; i += 4) {
    const adjusted = new Uint8ClampedArray(4);
    adjusted[0] = overlay[i];
    adjusted[1] = overlay[i + 1];
    adjusted[2] = overlay[i + 2];
    adjusted[3] = Math.round(overlay[i + 3] * overlayOpacity);
    over(out, i, adjusted, 0);
  }
  return out;
}

function markRedDot(buffer: Uint8ClampedArray, width: number, height: number, x: number, y: number, color: [number, number, number, number] = [255, 0, 0, 255]): void {
  const px = Math.round(x);
  const py = Math.round(y);
  for (let dotY = py - 4; dotY <= py + 4; dotY += 1) {
    if (dotY < 0 || dotY >= height) continue;
    for (let dotX = px - 4; dotX <= px + 4; dotX += 1) {
      if (dotX < 0 || dotX >= width || dotY < 0 || dotY >= height) continue;
      const distance = Math.abs(dotX - px) + Math.abs(dotY - py);
      const offset = (dotY * width + dotX) * 4;
      if (distance === 5) {
        buffer[offset] = 255;
        buffer[offset + 1] = 255;
        buffer[offset + 2] = 255;
        buffer[offset + 3] = 255;
        continue;
      }
      if (distance > 4) continue;
      buffer[offset] = color[0];
      buffer[offset + 1] = color[1];
      buffer[offset + 2] = color[2];
      buffer[offset + 3] = color[3];
    }
  }
}

function markCellRedDot(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, cell: BakedCell, anchor: Pick<Anchor, 'x' | 'y'>): void {
  markRedDot(sheet, sheetWidth, sheetHeight, cell.col * cellWidth + anchor.x, cell.row * cellHeight + anchor.y);
}

function writeRedDotSheets(
  sourceBakedSheet: Uint8ClampedArray,
  originalTemplateGuideSheet: Uint8ClampedArray,
  convertedEditableSheet: Uint8ClampedArray,
  sheetWidth: number,
  sheetHeight: number,
  records: PlacementRecord[],
  outDir: string,
) {
  const sourceRedDots = new Uint8ClampedArray(sourceBakedSheet);
  const templateRedDots = new Uint8ClampedArray(originalTemplateGuideSheet);
  const convertedRedDots = new Uint8ClampedArray(convertedEditableSheet);
  const overlayRedDots = overlayBuffers(originalTemplateGuideSheet, convertedEditableSheet, 0.75);
  const coordinates = records.map((record) => ({
    key: record.key,
    action: record.action,
    frameIndex: record.frameIndex,
    col: record.col,
    row: record.row,
    templateRedDot: {
      sheetX: record.col * cellWidth + record.targetAnchor.x,
      sheetY: record.row * cellHeight + record.targetAnchor.y,
      cellX: record.targetAnchor.x,
      cellY: record.targetAnchor.y,
    },
    sourceBakedRedDot: {
      sheetX: record.col * cellWidth + record.actualAnchorInCell.x,
      sheetY: record.row * cellHeight + record.actualAnchorInCell.y,
      cellX: record.actualAnchorInCell.x,
      cellY: record.actualAnchorInCell.y,
    },
    convertedRedDot: {
      sheetX: record.col * cellWidth + record.actualAnchorInCell.x,
      sheetY: record.row * cellHeight + record.actualAnchorInCell.y,
      cellX: record.actualAnchorInCell.x,
      cellY: record.actualAnchorInCell.y,
    },
    deltaConvertedMinusTemplate: record.error,
    suggestedCorrectionToApplyToConverted: {
      dx: -record.error.dx,
      dy: -record.error.dy,
    },
  }));
  for (const record of records) {
    const cell = { action: record.action, frameIndex: record.frameIndex, col: record.col, row: record.row };
    markCellRedDot(sourceRedDots, sheetWidth, sheetHeight, cell, record.actualAnchorInCell);
    markCellRedDot(templateRedDots, sheetWidth, sheetHeight, cell, record.targetAnchor);
    markCellRedDot(convertedRedDots, sheetWidth, sheetHeight, cell, record.actualAnchorInCell);
    markCellRedDot(overlayRedDots, sheetWidth, sheetHeight, cell, record.targetAnchor);
    markCellRedDot(overlayRedDots, sheetWidth, sheetHeight, cell, record.actualAnchorInCell);
  }
  writeRgbaPng(path.join(outDir, 'red-dot-source-baked-sheet.png'), sheetWidth, sheetHeight, sourceRedDots);
  writeRgbaPng(path.join(outDir, 'red-dot-template-guide-sheet.png'), sheetWidth, sheetHeight, templateRedDots);
  writeRgbaPng(path.join(outDir, 'red-dot-converted-sheet.png'), sheetWidth, sheetHeight, convertedRedDots);
  writeRgbaPng(path.join(outDir, 'red-dot-template-vs-converted-overlay-sheet.png'), sheetWidth, sheetHeight, overlayRedDots);
  writeFileSync(path.join(outDir, 'red-dot-coordinates.json'), JSON.stringify(coordinates, null, 2));
  return {
    sourceBakedSheet: 'red-dot-source-baked-sheet.png',
    templateGuideSheet: 'red-dot-template-guide-sheet.png',
    convertedSheet: 'red-dot-converted-sheet.png',
    overlaySheet: 'red-dot-template-vs-converted-overlay-sheet.png',
    coordinates: 'red-dot-coordinates.json',
  };
}

function writeOverlayStrip(filePath: string, title: string, frames: Uint8ClampedArray[]): void {
  const scale = 2;
  const labelHeight = 36;
  const width = Math.max(1, frames.length) * cellWidth * scale;
  const height = labelHeight + cellHeight * scale;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(title, 12, 24);
  frames.forEach((frame, index) => {
    const cellCanvas = createCanvas(cellWidth, cellHeight);
    const cellCtx = cellCanvas.getContext('2d');
    const imageData = cellCtx.createImageData(cellWidth, cellHeight);
    imageData.data.set(frame);
    cellCtx.putImageData(imageData, 0, 0);
    ctx.drawImage(cellCanvas, index * cellWidth * scale, labelHeight, cellWidth * scale, cellHeight * scale);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '16px sans-serif';
    ctx.fillText(String(index), index * cellWidth * scale + 8, labelHeight + 22);
  });
  writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function writePlacementOverlays(templateSheet: Uint8ClampedArray, convertedSheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, outDir: string) {
  const overlayRoot = path.join(outDir, 'placement-overlays');
  mkdirSync(overlayRoot, { recursive: true });
  const overlaysByAction = new Map<string, Uint8ClampedArray[]>();
  for (const cell of bakedCells) {
    const template = cropCell(templateSheet, sheetWidth, sheetHeight, cell);
    const converted = cropCell(convertedSheet, sheetWidth, sheetHeight, cell);
    const overlay = overlayBuffers(template, converted, 0.75);
    const actionDir = path.join(overlayRoot, safePathSegment(cell.action));
    mkdirSync(actionDir, { recursive: true });
    const fileName = `${String(cell.frameIndex).padStart(2, '0')}.png`;
    writeRgbaPng(path.join(actionDir, fileName), cellWidth, cellHeight, overlay);
    const actionOverlays = overlaysByAction.get(cell.action) ?? [];
    actionOverlays[cell.frameIndex] = overlay;
    overlaysByAction.set(cell.action, actionOverlays);
  }
  const stand1Overlays = overlaysByAction.get('기본(한손)')?.filter(Boolean) ?? [];
  const stand1OverlayStripPath = stand1Overlays.length > 0 ? path.join(outDir, 'placement-overlay-stand1.png') : null;
  if (stand1OverlayStripPath) writeOverlayStrip(stand1OverlayStripPath, 'Template + converted overlay: 기본(한손)', stand1Overlays);
  return {
    overlayRoot: path.relative(outDir, overlayRoot),
    stand1OverlayStrip: stand1OverlayStripPath ? path.relative(outDir, stand1OverlayStripPath) : null,
  };
}

function writeComparisonFramePng(filePath: string, action: string, frameIndex: number, source: Uint8ClampedArray, template: Uint8ClampedArray, converted: Uint8ClampedArray): void {
  const scale = 2;
  const labelHeight = 42;
  const gap = 18;
  const panelWidth = cellWidth * scale;
  const panelHeight = cellHeight * scale;
  const width = gap + panelWidth + gap + panelWidth + gap + panelWidth + gap;
  const height = labelHeight + panelHeight + gap;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(`${action} #${frameIndex}`, gap, 26);

  const labels = ['MeAegi input', 'Original template', 'Converted PSD'];
  const cellsToDraw = [source, template, converted];
  for (let index = 0; index < cellsToDraw.length; index += 1) {
    const left = gap + index * (panelWidth + gap);
    const top = labelHeight;
    ctx.fillStyle = '#020617';
    ctx.fillRect(left, top, panelWidth, panelHeight);
    ctx.strokeStyle = index === 0 ? '#38bdf8' : index === 1 ? '#f59e0b' : '#22c55e';
    ctx.lineWidth = 3;
    ctx.strokeRect(left, top, panelWidth, panelHeight);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '14px sans-serif';
    ctx.fillText(labels[index], left + 8, top + 20);

    const cellCanvas = createCanvas(cellWidth, cellHeight);
    const cellCtx = cellCanvas.getContext('2d');
    const imageData = cellCtx.createImageData(cellWidth, cellHeight);
    imageData.data.set(cellsToDraw[index]);
    cellCtx.putImageData(imageData, 0, 0);
    ctx.drawImage(cellCanvas, left, top, panelWidth, panelHeight);
  }
  writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function makeGif(framePaths: string[], gifPath: string): string | null {
  if (framePaths.length === 0) return null;
  try {
    execFileSync('magick', ['-delay', '18', '-loop', '0', ...framePaths, gifPath], { stdio: 'ignore' });
    return gifPath;
  } catch {
    return null;
  }
}

function writeMotionComparisons(sourceSheet: Uint8ClampedArray, templateSheet: Uint8ClampedArray, convertedSheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, outDir: string): ComparisonArtifact[] {
  const frameRoot = path.join(outDir, 'motion-comparison-frames');
  const gifRoot = path.join(outDir, 'motion-comparison-gifs');
  mkdirSync(frameRoot, { recursive: true });
  mkdirSync(gifRoot, { recursive: true });
  const actions = [...new Set(bakedCells.map((cell) => cell.action))];
  return actions.map((action) => {
    const actionCells = bakedCells.filter((cell) => cell.action === action).sort((a, b) => a.frameIndex - b.frameIndex);
    const actionDir = path.join(frameRoot, safePathSegment(action));
    mkdirSync(actionDir, { recursive: true });
    const framePaths: string[] = [];
    let sourceVsConvertedDiffPixels = 0;
    let sourceVsConvertedMaxDelta = 0;
    let sourceVsTemplateDiffPixels = 0;
    let sourceVsTemplateMaxDelta = 0;
    for (const cell of actionCells) {
      const source = cropCell(sourceSheet, sheetWidth, sheetHeight, cell);
      const template = cropCell(templateSheet, sheetWidth, sheetHeight, cell);
      const converted = cropCell(convertedSheet, sheetWidth, sheetHeight, cell);
      const convertedDiff = diffBuffers(cellWidth, cellHeight, source, converted);
      const templateDiff = diffBuffers(cellWidth, cellHeight, source, template);
      sourceVsConvertedDiffPixels += convertedDiff.diffPixels;
      sourceVsConvertedMaxDelta = Math.max(sourceVsConvertedMaxDelta, convertedDiff.maxChannelDelta);
      sourceVsTemplateDiffPixels += templateDiff.diffPixels;
      sourceVsTemplateMaxDelta = Math.max(sourceVsTemplateMaxDelta, templateDiff.maxChannelDelta);
      const framePath = path.join(actionDir, `${String(cell.frameIndex).padStart(2, '0')}.png`);
      writeComparisonFramePng(framePath, action, cell.frameIndex, source, template, converted);
      framePaths.push(framePath);
    }
    const gifPath = path.join(gifRoot, `${safePathSegment(action)}.gif`);
    const maybeGif = makeGif(framePaths, gifPath);
    return {
      action,
      frameCount: actionCells.length,
      gifPath: maybeGif ? path.relative(outDir, maybeGif) : null,
      frameDir: path.relative(outDir, actionDir),
      sourceVsConvertedDiffPixels,
      sourceVsConvertedMaxDelta,
      sourceVsTemplateDiffPixels,
      sourceVsTemplateMaxDelta,
    };
  });
}

function validateCells(expectedSheet: Uint8ClampedArray, readbackSheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, outDir: string) {
  const expectedDir = path.join(outDir, 'source-frame-cells');
  const actualDir = path.join(outDir, 'psd-frame-cells');
  const diffDir = path.join(outDir, 'frame-diff');
  let totalDiffPixels = 0;
  let maxChannelDelta = 0;
  const frames = bakedCells.map((cell) => {
    const expected = cropCell(expectedSheet, sheetWidth, sheetHeight, cell);
    const actual = cropCell(readbackSheet, sheetWidth, sheetHeight, cell);
    const diff = diffBuffers(cellWidth, cellHeight, expected, actual);
    totalDiffPixels += diff.diffPixels;
    maxChannelDelta = Math.max(maxChannelDelta, diff.maxChannelDelta);
    const fileName = safeFrameFileName(cell.action, cell.frameIndex);
    writeRgbaPng(path.join(expectedDir, fileName), cellWidth, cellHeight, expected);
    writeRgbaPng(path.join(actualDir, fileName), cellWidth, cellHeight, actual);
    writeRgbaPng(path.join(diffDir, fileName), cellWidth, cellHeight, diff.diff);
    return {
      action: cell.action,
      frameIndex: cell.frameIndex,
      pass: diff.pass,
      diffPixels: diff.diffPixels,
      maxChannelDelta: diff.maxChannelDelta,
      sourceFramePath: `source-frame-cells/${fileName}`,
      psdFramePath: `psd-frame-cells/${fileName}`,
      diffPath: `frame-diff/${fileName}`,
    };
  });
  return {
    pass: frames.every((frame) => frame.pass),
    totalDiffPixels,
    maxChannelDelta,
    frames,
  };
}

function validatePlacementRecords(records: PlacementRecord[], sheetWidth: number, sheetHeight: number) {
  const frames = records.map((record) => ({
    key: record.key,
    action: record.action,
    frameIndex: record.frameIndex,
    col: record.col,
    row: record.row,
    targetAnchor: record.targetAnchor,
    sourceAnchor: record.sourceAnchor,
    destLeft: record.destLeft,
    destTop: record.destTop,
    actualAnchorInCell: record.actualAnchorInCell,
    error: record.error,
    sheetAnchor: {
      x: record.col * cellWidth + record.actualAnchorInCell.x,
      y: record.row * cellHeight + record.actualAnchorInCell.y,
    },
    cellFullyInsideSheet: (record.col + 1) * cellWidth <= sheetWidth && (record.row + 1) * cellHeight <= sheetHeight,
    anchorInsideSheet:
      record.col * cellWidth + record.actualAnchorInCell.x >= 0 &&
      record.col * cellWidth + record.actualAnchorInCell.x < sheetWidth &&
      record.row * cellHeight + record.actualAnchorInCell.y >= 0 &&
      record.row * cellHeight + record.actualAnchorInCell.y < sheetHeight,
  })).map((frame) => ({
    ...frame,
    pass: frame.error.dx === 0 && frame.error.dy === 0 && frame.cellFullyInsideSheet && frame.anchorInsideSheet,
  }));
  return {
    pass: frames.every((frame) => frame.pass),
    maxAbsDx: Math.max(0, ...frames.map((frame) => Math.abs(frame.error.dx))),
    maxAbsDy: Math.max(0, ...frames.map((frame) => Math.abs(frame.error.dy))),
    frames,
  };
}

export async function bakeMeaegiWholeAvatar(input: BakeMeaegiWholeAvatarInput) {
  ensureCanvasInitialized();
  const share = extractMeaegiShareId(input.share);
  const target = input.target ?? 'cape';
  if (!(target in targetConfigs)) throw new Error(`Unknown target "${target}". Use cape, cape-balloon, or longcoat.`);
  const outDir = input.outDir ?? path.join('artifacts/whole-avatar-bake', share, target);
  const config = targetConfigs[target];
  const imported = await loadMeaegiImport(share);
  const uniqueFrames = new Map<string, { action: string; frameIndex: number; imageRef: string }>();
  for (const frame of imported.frames) {
    const key = `${frame.action}:${frame.frameIndex}`;
    if (!uniqueFrames.has(key) && frame.imageRef) uniqueFrames.set(key, { action: frame.action, frameIndex: frame.frameIndex, imageRef: frame.imageRef });
  }
  const frameByKey = await loadFramesFromUniqueMap(uniqueFrames, bakedCells);
  const referenceFrameByKey = await loadFrameSetForCells(referenceCalibrationShare, bakedCells);

  const psd = readPsd(readFileSync(config.templatePath), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const originalTemplateGuideSheet = renderLayerSheet(psd, (entry) => entry.path.includes('guide_character'));
  const originalTemplateReferenceSheet = renderTemplateReferenceSheet(psd);
  const originalTemplateEditableSheet = renderEditableSheet(psd);
  const guideBoundsByCell = new Map<string, Bounds>(bakedCells.map((cell) => [`${cell.action}:${cell.frameIndex}`, cellBounds(originalTemplateGuideSheet, psd.width, psd.height, cell)]));
  const targetFixedOffset = fixedFramePlacementOffsets[target];
  const targetManualCorrections = manualFrameCorrections[target] ?? {};
  const placementRecords: PlacementRecord[] = [];
  const sheet = new Uint8ClampedArray(psd.width * psd.height * 4);
  const referenceAlignmentSheet = new Uint8ClampedArray(psd.width * psd.height * 4);
  for (const cell of bakedCells) {
    const key = correctionKey(cell);
    const guideBounds = guideBoundsByCell.get(key);
    const targetAnchor = anchorFromBounds(guideBounds, { x: cellWidth / 2, y: cellHeight * 0.6, basis: 'fallback-cell-center' }, 'template-guide-character-center-bottom');
    const referenceFrame = referenceFrameByKey.get(key)!;
    const sourceAnchor = anchorFromBounds(referenceFrame.bounds, { x: referenceFrame.width / 2, y: referenceFrame.height * 2 / 3, basis: 'fallback-reference-frame-origin' }, `reference-share-${referenceCalibrationShare}-alpha-center-bottom`);
    const placement = placementForCell(cell, targetAnchor, sourceAnchor, targetManualCorrections[key], targetFixedOffset);
    placementRecords.push(placement);
    drawFrame(sheet, psd.width, psd.height, frameByKey.get(key)!, placement);
    drawFrame(referenceAlignmentSheet, psd.width, psd.height, referenceFrame, placement);
  }
  installSheetLayer(psd, config.editLayerPath, sheet, config.expandTargetLayerToCanvas);
  if (config.removeZmapPreset) psd.children = removeZmapPresetLayers(psd.children);
  if (config.promoteTargetLayerToTop) promoteLayerToTop(psd, config.editLayerPath);
  mkdirSync(outDir, { recursive: true });
  const psdPath = path.join(outDir, config.outputName);
  writeFileSync(psdPath, writePsdBuffer(psd, { generateThumbnail: false, trimImageData: false }));
  writeRgbaPng(path.join(outDir, 'expected-sheet.png'), psd.width, psd.height, sheet);
  writeRgbaPng(path.join(outDir, 'reference-alignment-sheet.png'), psd.width, psd.height, referenceAlignmentSheet);
  writeRgbaPng(path.join(outDir, 'reference-guide-overlay-sheet.png'), psd.width, psd.height, overlayBuffers(originalTemplateGuideSheet, referenceAlignmentSheet, 0.75));
  writeRgbaPng(path.join(outDir, 'original-template-guide-sheet.png'), psd.width, psd.height, originalTemplateGuideSheet);
  writeRgbaPng(path.join(outDir, 'original-template-reference-sheet.png'), psd.width, psd.height, originalTemplateReferenceSheet);
  writeRgbaPng(path.join(outDir, 'original-template-editable-sheet.png'), psd.width, psd.height, originalTemplateEditableSheet);

  const readback = readPsd(readFileSync(psdPath), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const readbackLayer = flatten(readback.children).find((entry) => entry.path === config.editLayerPath)?.layer;
  if (!readbackLayer?.imageData?.data) throw new Error('Readback layer imageData missing.');
  const readbackData = new Uint8ClampedArray(readbackLayer.imageData.data.buffer, readbackLayer.imageData.data.byteOffset, readbackLayer.imageData.data.byteLength);
  writeRgbaPng(path.join(outDir, 'readback-layer.png'), readbackLayer.imageData.width, readbackLayer.imageData.height, readbackData);
  const readbackSheet = new Uint8ClampedArray(psd.width * psd.height * 4);
  blitLayerToSheet(readbackSheet, psd.width, psd.height, readbackLayer);
  writeRgbaPng(path.join(outDir, 'readback-sheet.png'), psd.width, psd.height, readbackSheet);
  const convertedEditableSheet = renderEditableSheet(readback);
  writeRgbaPng(path.join(outDir, 'converted-editable-sheet.png'), psd.width, psd.height, convertedEditableSheet);
  const diff = diffBuffers(psd.width, psd.height, sheet, convertedEditableSheet);
  writeRgbaPng(path.join(outDir, 'diff.png'), psd.width, psd.height, diff.diff);
  const frameValidation = validateCells(sheet, convertedEditableSheet, psd.width, psd.height, outDir);
  const placementValidation = validatePlacementRecords(placementRecords, psd.width, psd.height);
  const redDotArtifacts = writeRedDotSheets(sheet, originalTemplateGuideSheet, convertedEditableSheet, psd.width, psd.height, placementRecords, outDir);
  const motionComparisons = writeMotionComparisons(sheet, originalTemplateReferenceSheet, convertedEditableSheet, psd.width, psd.height, outDir);
  const placementOverlays = writePlacementOverlays(originalTemplateReferenceSheet, convertedEditableSheet, psd.width, psd.height, outDir);

  const supportedKeys = new Set(bakedCells.map((cell) => `${cell.action}:${cell.frameIndex}`));
  const representedDuplicateKeys = new Map<string, string>([
    ['엎드려 찌르기:0', '엎드리기:0'],
  ]);
  const duplicateRepresentedFrames = [...uniqueFrames.values()]
    .filter((frame) => representedDuplicateKeys.has(`${frame.action}:${frame.frameIndex}`))
    .map((frame) => ({ action: frame.action, frameIndex: frame.frameIndex, representedBy: representedDuplicateKeys.get(`${frame.action}:${frame.frameIndex}`)! }));
  const skipped = [...uniqueFrames.values()]
    .filter((frame) => {
      const key = `${frame.action}:${frame.frameIndex}`;
      return !supportedKeys.has(key) && !representedDuplicateKeys.has(key) && !frame.action.includes('눈깜빡임');
    })
    .map((frame) => ({ action: frame.action, frameIndex: frame.frameIndex }));
  const report = {
    share,
    target,
    templatePath: config.templatePath,
    editLayerPath: config.editLayerPath,
    outputPsd: psdPath,
    sourceActionFrames: uniqueFrames.size,
    bakedFrames: bakedCells.length,
    skippedFrames: skipped.length,
    skipped,
    duplicateRepresentedFrames,
    excludedExpressionFrames: [...uniqueFrames.values()].filter((frame) => frame.action.includes('눈깜빡임')).length,
    placement: {
      cellWidth,
      cellHeight,
      referenceCalibrationShare,
      anchor: 'per-frame-template-guide-character-anchor-matched-to-reference-meaegi-body-anchor',
      zmapPresetRemoved: config.removeZmapPreset,
      targetLayerPromotedToTop: config.promoteTargetLayerToTop,
      fixedFramePlacementOffset: targetFixedOffset ? { ...targetFixedOffset } : null,
      manualFrameCorrections: Object.entries(targetManualCorrections).map(([key, correction]) => ({ key, ...correction })),
      placementValidation,
      redDotArtifacts,
    },
    validation: {
      readbackLayerExactMatch: frameValidation.pass,
      diffPixels: diff.diffPixels,
      maxChannelDelta: diff.maxChannelDelta,
      frameCellsPass: frameValidation.pass,
      frameCellDiffPixels: frameValidation.totalDiffPixels,
      frameCellMaxChannelDelta: frameValidation.maxChannelDelta,
      frameCells: frameValidation.frames,
      motionComparisonGifsGenerated: motionComparisons.filter((artifact) => artifact.gifPath).length,
      placementOverlays,
      motionComparisons,
    },
    warnings: [
      'This is a whole-avatar bake: it writes full-character frames into one expanded MSW editable layer rather than isolating worn source parts.',
      'MSW upload/runtime validation is still manual; this script now emits MeAegi/template/converted motion GIFs so placement can be visually checked before upload.',
      'Blink/expression frames are intentionally excluded.',
      'Heal and ghost actions are not represented by the current MSW avatar template grid and are skipped in this first bake.',
    ],
  };
  writeFileSync(path.join(outDir, 'validation-report.json'), JSON.stringify(report, null, 2));
  return { report, psdPath, expectedSheetPath: path.join(outDir, 'expected-sheet.png'), readbackLayerPath: path.join(outDir, 'readback-layer.png'), diffPath: path.join(outDir, 'diff.png') };
}

async function main() {
  const { share, target, outDir } = parseArgs();
  const { report } = await bakeMeaegiWholeAvatar({ share, target, outDir });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
