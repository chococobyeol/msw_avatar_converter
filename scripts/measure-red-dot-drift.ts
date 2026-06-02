import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { readPsd, type Layer, type Psd } from 'ag-psd';
import { ensureCanvasInitialized } from '../packages/psd-gate/src/canvas.js';

interface CellDef {
  action: string;
  frameIndex: number;
  col: number;
  row: number;
}

interface DotPoint {
  sheetX: number;
  sheetY: number;
  cellX: number;
  cellY: number;
  pixels: number;
}

const cellWidth = 250;
const cellHeight = 250;
const dotThresholds = {
  red: { rMin: 240, gMax: 40, bMax: 40, aMin: 200 },
  green: { rMax: 40, gMin: 240, bMax: 40, aMin: 200 },
};

const bakedCells: CellDef[] = [
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

function cells(action: string, startCol: number, row: number, count: number, sourceFrameStart = 0): CellDef[] {
  return Array.from({ length: count }, (_, index) => ({ action, frameIndex: sourceFrameStart + index, col: startCol + index, row }));
}

function parseArgs() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    args.set(key, inline ?? process.argv[i + 1] ?? '');
    if (inline === undefined) i += 1;
  }
  const expected = args.get('expected');
  const actual = args.get('actual');
  if (!expected || !actual) throw new Error('Usage: npm/tsx scripts/measure-red-dot-drift.ts --expected <template-red-dot.png|psd> --actual <adjusted-red-dot.png|psd> [--out report.json]');
  return { expected, actual, out: args.get('out') };
}

function flatten(layers: Layer[] | undefined, parent = ''): Array<{ path: string; layer: Layer }> {
  const out: Array<{ path: string; layer: Layer }> = [];
  for (const layer of layers ?? []) {
    const current = parent ? `${parent}/${layer.name ?? ''}` : layer.name ?? '';
    out.push({ path: current, layer });
    out.push(...flatten(layer.children, current));
  }
  return out;
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

function blitLayer(psd: Psd, sheet: Uint8ClampedArray, layer: Layer): void {
  const image = layer.imageData;
  if (!image?.data) return;
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  for (let y = 0; y < image.height; y += 1) {
    const targetY = top + y;
    if (targetY < 0 || targetY >= psd.height) continue;
    for (let x = 0; x < image.width; x += 1) {
      const targetX = left + x;
      if (targetX < 0 || targetX >= psd.width) continue;
      const sourceOffset = (y * image.width + x) * 4;
      if (image.data[sourceOffset + 3] === 0) continue;
      over(sheet, (targetY * psd.width + targetX) * 4, image.data as Uint8ClampedArray, sourceOffset);
    }
  }
}

function readImage(filePath: string): { width: number; height: number; rgba: Uint8ClampedArray } {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') {
    const png = PNG.sync.read(readFileSync(filePath));
    return { width: png.width, height: png.height, rgba: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
  }
  if (ext === '.psd') {
    ensureCanvasInitialized();
    const psd = readPsd(readFileSync(filePath), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
    const rgba = new Uint8ClampedArray(psd.width * psd.height * 4);
    for (const entry of flatten(psd.children).reverse()) {
      if (entry.layer.hidden) continue;
      blitLayer(psd, rgba, entry.layer);
    }
    return { width: psd.width, height: psd.height, rgba };
  }
  throw new Error(`Unsupported red-dot file type: ${filePath}`);
}

type DotColor = keyof typeof dotThresholds;

function isDotPixel(rgba: Uint8ClampedArray, offset: number, color: DotColor): boolean {
  if (color === 'red') {
    const threshold = dotThresholds.red;
    return rgba[offset] >= threshold.rMin && rgba[offset + 1] <= threshold.gMax && rgba[offset + 2] <= threshold.bMax && rgba[offset + 3] >= threshold.aMin;
  }
  const threshold = dotThresholds.green;
  return rgba[offset] <= threshold.rMax && rgba[offset + 1] >= threshold.gMin && rgba[offset + 2] <= threshold.bMax && rgba[offset + 3] >= threshold.aMin;
}

function findDotInCell(image: { width: number; height: number; rgba: Uint8ClampedArray }, cell: CellDef, color: DotColor): DotPoint | null {
  const left = cell.col * cellWidth;
  const top = cell.row * cellHeight;
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < cellHeight; y += 1) {
    const sheetY = top + y;
    if (sheetY < 0 || sheetY >= image.height) continue;
    for (let x = 0; x < cellWidth; x += 1) {
      const sheetX = left + x;
      if (sheetX < 0 || sheetX >= image.width) continue;
      const offset = (sheetY * image.width + sheetX) * 4;
      if (!isDotPixel(image.rgba, offset, color)) continue;
      count += 1;
      sumX += sheetX;
      sumY += sheetY;
    }
  }
  if (count === 0) return null;
  const sheetX = Math.round(sumX / count);
  const sheetY = Math.round(sumY / count);
  return { sheetX, sheetY, cellX: sheetX - left, cellY: sheetY - top, pixels: count };
}

export function measureRedDotDrift(expectedPath: string, actualPath: string) {
  const expectedImage = readImage(expectedPath);
  const actualImage = readImage(actualPath);
  const frames = bakedCells.map((cell) => {
    const expected = findDotInCell(expectedImage, cell, 'red') ?? findDotInCell(expectedImage, cell, 'green');
    const actual = findDotInCell(actualImage, cell, 'green') ?? findDotInCell(actualImage, cell, 'red');
    const delta = expected && actual ? { dx: actual.cellX - expected.cellX, dy: actual.cellY - expected.cellY } : null;
    return {
      key: `${cell.action}:${cell.frameIndex}`,
      action: cell.action,
      frameIndex: cell.frameIndex,
      col: cell.col,
      row: cell.row,
      expected,
      actual,
      deltaActualMinusExpected: delta,
      suggestedCorrectionToApplyToActual: delta ? { dx: -delta.dx, dy: -delta.dy } : null,
      pass: Boolean(delta && delta.dx === 0 && delta.dy === 0),
    };
  });
  const compared = frames.filter((frame) => frame.deltaActualMinusExpected);
  const failed = frames.filter((frame) => !frame.pass);
  return {
    expectedPath,
    actualPath,
    cellWidth,
    cellHeight,
    dotThresholds,
    pass: failed.length === 0,
    comparedFrames: compared.length,
    missingFrames: frames.length - compared.length,
    failedFrames: failed.length,
    maxAbsDx: Math.max(0, ...compared.map((frame) => Math.abs(frame.deltaActualMinusExpected!.dx))),
    maxAbsDy: Math.max(0, ...compared.map((frame) => Math.abs(frame.deltaActualMinusExpected!.dy))),
    frames,
  };
}

async function main() {
  const { expected, actual, out } = parseArgs();
  const report = measureRedDotDrift(expected, actual);
  const json = JSON.stringify(report, null, 2);
  if (out) writeFileSync(out, json);
  console.log(json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
