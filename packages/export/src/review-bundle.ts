import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readPsd, writePsdBuffer, type Layer, type Psd } from 'ag-psd';
import { ensureCanvasInitialized } from '../../psd-gate/src/canvas.js';
import type { MappingPlan, NormalizedFrameSet, TargetEditableLayer, TargetTemplatePart, ValidationFrameResult, ValidationPolicy } from '../../core/src/index.js';
import type { RenderedFrame } from '../../render/src/index.js';
import { writeRgbaPng } from './png.js';

export interface ReviewBundleInput {
  outputDir: string;
  allowedOutputRoot?: string;
  target: TargetTemplatePart;
  normalized: NormalizedFrameSet;
  mappings: MappingPlan[];
  renderedFrames: RenderedFrame[];
  expectedFrames?: RenderedFrame[];
  validationReport: unknown;
  validationPolicy: ValidationPolicy;
  templateInventoryRef: string;
}

export interface EditableLayerSlot {
  layer: TargetEditableLayer;
  frame: RenderedFrame;
  slotIndex: number;
}

function cropRenderedFrame(frame: RenderedFrame, left: number, top: number, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sourceY = top + y;
    if (sourceY < 0 || sourceY >= frame.height) continue;
    for (let x = 0; x < width; x++) {
      const sourceX = left + x;
      if (sourceX < 0 || sourceX >= frame.width) continue;
      const sourceOffset = (sourceY * frame.width + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      out[targetOffset] = frame.rgbaBuffer[sourceOffset];
      out[targetOffset + 1] = frame.rgbaBuffer[sourceOffset + 1];
      out[targetOffset + 2] = frame.rgbaBuffer[sourceOffset + 2];
      out[targetOffset + 3] = frame.rgbaBuffer[sourceOffset + 3];
    }
  }
  return out;
}

function layerPath(parent: string, layer: Layer): string {
  return parent ? `${parent}/${layer.name}` : layer.name ?? '';
}


function safeFrameFileName(action: string, frameIndex: number): string {
  const encodedAction = Buffer.from(action, 'utf8').toString('base64url');
  return `${encodedAction}-${frameIndex}.png`;
}

function safeJoinUnder(root: string, filename: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, filename);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Unsafe output path: ${filename}`);
  return resolved;
}

function resolveUnderRoot(root: string, child: string, label: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, child);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Unsafe ${label}: ${child}`);
  return resolved;
}

function assertTrustedTemplatePath(templatePath: string): void {
  const root = path.resolve('avatartemplate');
  const resolved = path.resolve(templatePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe template path: ${templatePath}`);
}

function layerByPath(target: TargetTemplatePart): Map<string, TargetEditableLayer> {
  return new Map(target.editableLayers.map((layer) => [layer.path, layer]));
}

export function buildEditableLayerSlots(target: TargetTemplatePart, renderedFrames: RenderedFrame[]): EditableLayerSlot[] {
  if (renderedFrames.length === 0) throw new Error('Cannot export PSD without rendered frames.');
  const layers = layerByPath(target);
  const cells = target.frameGrid?.cells;
  if (!cells?.length) throw new Error(`Template ${target.templatePath} has no explicit frameGrid cells.`);
  return [...cells]
    .sort((a, b) => a.frameIndex - b.frameIndex || a.layerPath.localeCompare(b.layerPath))
    .map((cell, slotIndex) => {
      const layer = layers.get(cell.layerPath);
      if (!layer) throw new Error(`Template frameGrid references unknown editable layer: ${cell.layerPath}`);
      const frame = renderedFrames.find((candidate) => candidate.action === cell.action && candidate.frameIndex === cell.frameIndex);
      if (!frame) throw new Error(`Missing rendered frame for frameGrid cell ${cell.action}:${cell.frameIndex} (${cell.layerPath}).`);
      if (cell.left !== layer.left || cell.top !== layer.top || cell.width !== layer.width || cell.height !== layer.height) {
        throw new Error(`FrameGrid cell geometry does not match editable layer ${cell.layerPath}.`);
      }
      return { layer, frame, slotIndex };
    });
}

function replaceEditableLayers(layers: Layer[] | undefined, slots: Map<string, EditableLayerSlot>, parent = ''): number {
  if (!layers) return 0;
  let replaced = 0;
  for (const layer of layers) {
    const currentPath = layerPath(parent, layer);
    if (layer.children) replaced += replaceEditableLayers(layer.children, slots, currentPath);
    const slot = slots.get(currentPath);
    if (slot) {
      const width = Math.max(1, (layer.right ?? 0) - (layer.left ?? 0));
      const height = Math.max(1, (layer.bottom ?? 0) - (layer.top ?? 0));
      layer.imageData = { width, height, data: cropRenderedFrame(slot.frame, layer.left ?? 0, layer.top ?? 0, width, height) };
      replaced += 1;
    }
  }
  return replaced;
}

export function writeRenderedFramesToEditableLayers(psd: Psd, target: TargetTemplatePart, renderedFrames: RenderedFrame[]): number {
  const slots = new Map(buildEditableLayerSlots(target, renderedFrames).map((slot) => [slot.layer.path, slot]));
  const replaced = replaceEditableLayers(psd.children, slots);
  if (replaced !== slots.size) throw new Error(`Editable layer write mismatch for ${target.templatePath}: wrote ${replaced}/${slots.size}.`);
  return replaced;
}

function findFrame(frames: RenderedFrame[] | undefined, result: ValidationFrameResult): RenderedFrame | undefined {
  return frames?.find((frame) => frame.action === result.action && frame.frameIndex === result.frameIndex);
}

function makeDiffImage(result: ValidationFrameResult, expected: RenderedFrame | undefined, actual: RenderedFrame | undefined): { width: number; height: number; data: Uint8ClampedArray } {
  const width = expected?.width ?? actual?.width ?? 1;
  const height = expected?.height ?? actual?.height ?? 1;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const er = expected?.rgbaBuffer[i] ?? 0;
    const eg = expected?.rgbaBuffer[i + 1] ?? 0;
    const eb = expected?.rgbaBuffer[i + 2] ?? 0;
    const ea = expected?.rgbaBuffer[i + 3] ?? 0;
    const ar = actual?.rgbaBuffer[i] ?? 0;
    const ag = actual?.rgbaBuffer[i + 1] ?? 0;
    const ab = actual?.rgbaBuffer[i + 2] ?? 0;
    const aa = actual?.rgbaBuffer[i + 3] ?? 0;
    const delta = Math.max(Math.abs(er - ar), Math.abs(eg - ag), Math.abs(eb - ab), Math.abs(ea - aa));
    if (delta > 0 || !result.pass) {
      data[i] = 255;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function validationFrames(report: unknown): ValidationFrameResult[] {
  if (typeof report !== 'object' || report === null || !('frames' in report)) return [];
  const frames = (report as { frames?: unknown }).frames;
  return Array.isArray(frames) ? frames as ValidationFrameResult[] : [];
}

export function exportReviewBundle(input: ReviewBundleInput): void {
  ensureCanvasInitialized();
  assertTrustedTemplatePath(input.target.templatePath);
  const outputDir = input.allowedOutputRoot ? resolveUnderRoot(input.allowedOutputRoot, input.outputDir, 'output directory') : path.resolve(input.outputDir);
  mkdirSync(outputDir, { recursive: true });
  const previewDir = path.join(outputDir, 'preview');
  const diffDir = path.join(outputDir, 'diff');
  mkdirSync(previewDir, { recursive: true });
  mkdirSync(diffDir, { recursive: true });

  for (const frame of input.renderedFrames) {
    writeRgbaPng(safeJoinUnder(previewDir, safeFrameFileName(frame.action, frame.frameIndex)), frame.width, frame.height, frame.rgbaBuffer);
  }
  for (const frame of validationFrames(input.validationReport)) {
    const diff = makeDiffImage(frame, findFrame(input.expectedFrames, frame), findFrame(input.renderedFrames, frame));
    const diffFileName = safeFrameFileName(frame.action, frame.frameIndex);
    writeRgbaPng(safeJoinUnder(diffDir, diffFileName), diff.width, diff.height, diff.data);
    frame.diffImagePath = `diff/${diffFileName}`;
  }

  const psd = readPsd(readFileSync(input.target.templatePath), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const editableLayersWritten = writeRenderedFramesToEditableLayers(psd, input.target, input.renderedFrames);
  writeFileSync(path.join(outputDir, path.basename(input.target.templatePath)), writePsdBuffer(psd, { generateThumbnail: false, trimImageData: false }));

  writeFileSync(path.join(outputDir, 'mapping-plan.json'), JSON.stringify({ mappings: input.mappings }, null, 2));
  writeFileSync(path.join(outputDir, 'validation-report.json'), JSON.stringify({ ...input.validationReport as object, editableLayersWritten }, null, 2));
  writeFileSync(path.join(outputDir, 'validation-policy.json'), JSON.stringify(input.validationPolicy, null, 2));
  writeFileSync(path.join(outputDir, 'template-inventory-ref.txt'), `${input.templateInventoryRef}\n`);
  writeFileSync(path.join(outputDir, 'manual-review-checklist.md'), readFileSync('docs/manual-review-checklist.md', 'utf8'));
  writeFileSync(path.join(outputDir, 'human-signoff.json'), JSON.stringify({ status: 'pending', reviewedAt: null, reviewer: null, notes: '' }, null, 2));
}
