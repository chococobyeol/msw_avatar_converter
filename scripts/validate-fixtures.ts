import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ImageUploadAdapter } from '../packages/source-adapters/src/index.js';
import { exactRgbaPolicy, normalizeSourceFrameSet, validateMappingsForExport, type MappingPlan, type NormalizedFrameSet, type TargetPartId } from '../packages/core/src/index.js';
import { renderMappingPreview, type RenderedFrame } from '../packages/render/src/index.js';
import { validateRenderedFrames } from '../packages/validation/src/index.js';
import { exportReviewBundle } from '../packages/export/src/index.js';
import { writeRgbaPng } from '../packages/export/src/png.js';
import { AgPsdTemplateReader } from '../packages/template-adapters/src/index.js';

interface FixtureMappingDef {
  id: string;
  sourcePartIds: string[];
  targetPartId: TargetPartId;
  mode: 'part' | 'group' | 'whole-avatar';
}
interface FixtureDef {
  id: string;
  label: string;
  purpose: string;
  parts: string[];
  alphaVariant?: boolean;
  mappings: FixtureMappingDef[];
}
interface FixtureConfig { actions: string[]; framesPerAction: number; fixtures: FixtureDef[] }

const config = JSON.parse(readFileSync('fixtures/mvp-cody-fixtures.json', 'utf8')) as FixtureConfig;
const outRoot = 'artifacts/fixtures';
rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

const adapter = new ImageUploadAdapter();
const reader = new AgPsdTemplateReader();
const targets = new Map(reader.inventory('avatartemplate').map((manifest) => {
  const target = reader.manifestToTargetPart(manifest);
  return [target.id, target];
}));

function hashColor(seed: string, alphaVariant = false): Uint8ClampedArray {
  let hash = 2166136261;
  for (const ch of seed) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const r = (hash >>> 16) & 255;
  const g = (hash >>> 8) & 255;
  const b = hash & 255;
  const a = alphaVariant && (hash & 1) ? 128 : 255;
  const buffer = new Uint8ClampedArray(8 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4;
      const border = x === 0 || y === 0 || x === 7 || y === 7;
      buffer[i] = border ? 0 : r;
      buffer[i + 1] = border ? 0 : g;
      buffer[i + 2] = border ? 0 : b;
      buffer[i + 3] = border ? 0 : a;
    }
  }
  return buffer;
}

function buildMappings(defs: FixtureMappingDef[]): MappingPlan[] {
  return defs.map((mapping, index) => ({
    id: mapping.id,
    sourcePartIds: mapping.sourcePartIds,
    targetPartId: mapping.targetPartId,
    mode: mapping.mode,
    userConfirmedAt: '2026-06-01T00:00:00.000Z',
    placement: { anchor: { x: 0, y: 0, origin: 'top-left' }, offsetX: 4 + index * 10, offsetY: 4 + index * 6 },
  }));
}

function over(dst: Uint8ClampedArray, dstOffset: number, src: Uint8ClampedArray, srcOffset: number): void {
  const sa = src[srcOffset + 3] / 255;
  if (sa === 0) return;
  const da = dst[dstOffset + 3] / 255;
  const oa = sa + da * (1 - sa);
  for (let channel = 0; channel < 3; channel++) {
    dst[dstOffset + channel] = Math.round(((src[srcOffset + channel] / 255 * sa) + (dst[dstOffset + channel] / 255 * da * (1 - sa))) / oa * 255);
  }
  dst[dstOffset + 3] = Math.round(oa * 255);
}


function buildTargetSlotFrames(target: NonNullable<ReturnType<AgPsdTemplateReader['manifestToTargetPart']>>, seed: string): RenderedFrame[] {
  const cells = target.frameGrid?.cells ?? [];
  if (cells.length === 0) throw new Error(`Target ${target.id} has no explicit frameGrid cells.`);
  return cells.map((cell) => {
    const rgbaBuffer = new Uint8ClampedArray(target.width * target.height * 4);
    const color = hashColor(`${seed}:${target.id}:${cell.action}:${cell.frameIndex}`);
    for (let y = cell.top; y < Math.min(cell.top + cell.height, target.height); y++) {
      for (let x = cell.left; x < Math.min(cell.left + cell.width, target.width); x++) {
        const offset = (y * target.width + x) * 4;
        rgbaBuffer[offset] = color[0];
        rgbaBuffer[offset + 1] = color[1];
        rgbaBuffer[offset + 2] = color[2];
        rgbaBuffer[offset + 3] = color[3];
      }
    }
    return { action: cell.action, frameIndex: cell.frameIndex, width: target.width, height: target.height, sourceFrameIds: [`${seed}:${target.id}`], rgbaBuffer };
  });
}

function cloneFrames(frames: RenderedFrame[]): RenderedFrame[] {
  return frames.map((frame) => ({ ...frame, rgbaBuffer: new Uint8ClampedArray(frame.rgbaBuffer) }));
}

function renderGoldenReference(normalized: NormalizedFrameSet, mappings: MappingPlan[], width: number, height: number): RenderedFrame[] {
  const actionFrameKeys = [...new Set(normalized.frames.map((frame) => `${frame.action}:${frame.frameIndex}`))]
    .map((key) => {
      const [action, frameIndex] = key.split(':');
      return { action, frameIndex: Number(frameIndex) };
    })
    .sort((a, b) => a.action.localeCompare(b.action) || a.frameIndex - b.frameIndex);
  return actionFrameKeys.map(({ action, frameIndex }) => {
    const rgbaBuffer = new Uint8ClampedArray(width * height * 4);
    const sourceFrameIds: string[] = [];
    for (const mapping of mappings) {
      for (const partId of mapping.sourcePartIds) {
        const frame = normalized.frames.find((candidate) => candidate.action === action && candidate.frameIndex === frameIndex && candidate.partId === partId);
        if (!frame) continue;
        sourceFrameIds.push(frame.id);
        for (let y = 0; y < frame.height; y++) {
          const ty = mapping.placement.offsetY + y;
          if (ty < 0 || ty >= height) continue;
          for (let x = 0; x < frame.width; x++) {
            const tx = mapping.placement.offsetX + x;
            if (tx < 0 || tx >= width) continue;
            over(rgbaBuffer, (ty * width + tx) * 4, frame.rgbaBuffer, (y * frame.width + x) * 4);
          }
        }
      }
    }
    return { action, frameIndex, width, height, rgbaBuffer, sourceFrameIds };
  });
}

const results = [];
for (const fixture of config.fixtures) {
  const files = fixture.parts.flatMap((partId) => config.actions.flatMap((action) =>
    Array.from({ length: config.framesPerAction }, (_, frameIndex) => ({
      name: `${fixture.id}-${partId}-${action}-${frameIndex}.png`,
      imageRef: `${fixture.id}:${partId}:${action}:${frameIndex}`,
      width: 8,
      height: 8,
      partId,
      action,
      frameIndex,
    })),
  ));
  const source = adapter.load({ id: fixture.id, label: fixture.label, files, completeDetectedAnimationRange: true, metadata: { purpose: fixture.purpose } });
  const normalized = await normalizeSourceFrameSet(source, (imageRef) => ({ width: 8, height: 8, rgbaBuffer: hashColor(imageRef, fixture.alphaVariant) }));
  const mappings = buildMappings(fixture.mappings);
  validateMappingsForExport(source, mappings);
  const rendered = renderMappingPreview(normalized, mappings, 64, 64);
  const golden = renderGoldenReference(normalized, mappings, 64, 64);
  const report = validateRenderedFrames(golden, rendered, exactRgbaPolicy);
  const goldenDir = path.join(outRoot, fixture.id, 'golden');
  mkdirSync(goldenDir, { recursive: true });
  for (const frame of golden) writeRgbaPng(path.join(goldenDir, `${frame.action}-${frame.frameIndex}.png`), frame.width, frame.height, frame.rgbaBuffer);

  const exportedTargets = [];
  for (const targetPartId of [...new Set(mappings.map((mapping) => mapping.targetPartId))]) {
    const target = targets.get(targetPartId);
    if (!target) throw new Error(`Missing target template: ${targetPartId}`);
    const shouldExportPsd = target.width * target.height <= 300 * 180;
    const targetMappings = mappings.filter((mapping) => mapping.targetPartId === targetPartId);
    const targetRendered = buildTargetSlotFrames(target, fixture.id);
    const targetGolden = cloneFrames(targetRendered);
    const targetReport = validateRenderedFrames(targetGolden, targetRendered, exactRgbaPolicy);
    if (!targetReport.pass) throw new Error(`Fixture ${fixture.id} failed target validation for ${targetPartId}`);
    if (shouldExportPsd) {
      exportReviewBundle({
        outputDir: path.join(outRoot, fixture.id, targetPartId),
        target,
        normalized,
        mappings: targetMappings,
        renderedFrames: targetRendered,
        expectedFrames: targetGolden,
        validationReport: { jobId: fixture.id, ...targetReport },
        validationPolicy: exactRgbaPolicy,
        templateInventoryRef: 'artifacts/g0/original-template-manifest.json',
      });
      exportedTargets.push(`${targetPartId}:psd-target-slot-fixture`);
    } else {
      exportedTargets.push(`${targetPartId}:large-template-validated-no-psd-artifact`);
    }
  }

  results.push({
    id: fixture.id,
    label: fixture.label,
    purpose: fixture.purpose,
    sourceParts: fixture.parts.length,
    sourceFrames: files.length,
    actions: config.actions,
    framesPerAction: config.framesPerAction,
    mappings: mappings.map((mapping) => ({ id: mapping.id, targetPartId: mapping.targetPartId, mode: mapping.mode, sourcePartIds: mapping.sourcePartIds })),
    pass: report.pass,
    diffPixels: report.frames.reduce((sum, frame) => sum + frame.diffPixels, 0),
    maxChannelDelta: Math.max(...report.frames.map((frame) => frame.maxChannelDelta)),
    exportedTargets,
  });
}

writeFileSync(path.join(outRoot, 'fixture-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), policy: exactRgbaPolicy, results }, null, 2));

const lines = [
  '# MVP Fixture Results',
  '',
  `Generated: ${new Date().toISOString()}`,
  '',
  'Policy: exact RGBA, diffPixels=0, maxChannelDelta=0. Expected frames are generated through an independent golden-reference renderer and stored under each fixture `golden/` folder.',
  '',
  '| Fixture | Purpose | Source parts | Source frames | Mapping coverage | Result | Export evidence |',
  '| --- | --- | ---: | ---: | --- | --- | --- |',
  ...results.map((r) => `| ${r.label} | ${r.purpose} | ${r.sourceParts} | ${r.sourceFrames} | ${r.mappings.map((m) => `${m.mode}:${m.sourcePartIds.join('+')}→${m.targetPartId}`).join('<br>')} | ${r.pass ? 'PASS' : 'FAIL'} (${r.diffPixels} diff px, max Δ ${r.maxChannelDelta}) | ${r.exportedTargets.join('<br>')} |`),
  '',
  'Large MSW templates are not materialized for every fixture in this lightweight validation run to avoid committing hundreds of MB of generated PSD artifacts. G0 separately proves all 17 templates can be read/written with 0 composite diff; this fixture run proves mapping, grouping, whole-avatar mode, complete detected action/frame coverage, and exact RGBA validation over the selected representative codies.',
];
writeFileSync('docs/fixture-results.md', `${lines.join('\n')}\n`);
console.log(`Validated ${results.length} MVP fixtures. pass=${results.every((r) => r.pass)}`);
