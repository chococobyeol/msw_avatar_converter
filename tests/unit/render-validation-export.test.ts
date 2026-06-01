import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { ImageUploadAdapter } from '../../packages/source-adapters/src/index.js';
import { exactRgbaPolicy, normalizeSourceFrameSet, validateMappingsForExport, type MappingPlan } from '../../packages/core/src/index.js';
import { renderMappingPreview } from '../../packages/render/src/index.js';
import { validateRenderedFrames } from '../../packages/validation/src/index.js';
import { exportReviewBundle } from '../../packages/export/src/index.js';
import { AgPsdTemplateReader } from '../../packages/template-adapters/src/index.js';

test('renders mapped canonical frames and validates exact pixel match', async () => {
  const source = new ImageUploadAdapter().load({ id: 'fixture', label: 'Fixture', completeDetectedAnimationRange: true, files: [
    { name: 'part.png', imageRef: 'part', width: 1, height: 1, partId: 'part', action: 'stand', frameIndex: 0 },
  ] });
  const normalized = await normalizeSourceFrameSet(source, () => ({ width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([255, 0, 0, 255]) }));
  const mappings: MappingPlan[] = [{ id: 'm1', sourcePartIds: ['part'], targetPartId: 'longcoat', mode: 'part', userConfirmedAt: new Date().toISOString(), placement: { anchor: { x: 0, y: 0, origin: 'top-left' }, offsetX: 0, offsetY: 0 } }];
  const rendered = renderMappingPreview(normalized, mappings, 1, 1);
  const report = validateRenderedFrames(rendered, rendered, exactRgbaPolicy);
  assert.equal(report.pass, true);
  assert.equal(rendered[0].rgbaBuffer[0], 255);
});

test('exports a manual review bundle with PSD and sidecars', async () => {
  const out = 'artifacts/test-review-bundle';
  rmSync(out, { recursive: true, force: true });
  const source = new ImageUploadAdapter().load({ id: 'fixture', label: 'Fixture', completeDetectedAnimationRange: true, files: [
    { name: 'part.png', imageRef: 'part', width: 1, height: 1, partId: 'part', action: 'stand', frameIndex: 0 },
  ] });
  const normalized = await normalizeSourceFrameSet(source, () => ({ width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([0, 255, 0, 255]) }));
  const mappings: MappingPlan[] = [{ id: 'm1', sourcePartIds: ['part'], targetPartId: 'hair', mode: 'part', userConfirmedAt: new Date().toISOString(), placement: { anchor: { x: 0, y: 0, origin: 'top-left' }, offsetX: 0, offsetY: 0 } }];
  const reader = new AgPsdTemplateReader();
  const target = reader.manifestToTargetPart(reader.inventory('avatartemplate').find((m) => m.file.endsWith('Avatar_Hair.psd'))!);
  const baseRendered = renderMappingPreview(normalized, mappings, 300, 180)[0];
  const rendered = target.frameGrid!.cells.map((cell) => ({ ...baseRendered, action: cell.action, frameIndex: cell.frameIndex }));
  const validationReport = validateRenderedFrames(rendered, rendered, exactRgbaPolicy);
  exportReviewBundle({ outputDir: out, target, normalized, mappings, renderedFrames: rendered, expectedFrames: rendered.map((frame) => ({ ...frame, rgbaBuffer: new Uint8ClampedArray(frame.rgbaBuffer) })), validationReport, validationPolicy: exactRgbaPolicy, templateInventoryRef: 'artifacts/g0/original-template-manifest.json' });
  assert.equal(existsSync(`${out}/Avatar_Hair.psd`), true);
  assert.equal(existsSync(`${out}/mapping-plan.json`), true);
  assert.equal(existsSync(`${out}/validation-report.json`), true);
  assert.equal(existsSync(`${out}/human-signoff.json`), true);
});

import { readFileSync } from 'node:fs';
import { readPsd, type Layer } from 'ag-psd';
import { diffFrames } from '../../packages/validation/src/index.js';
import { writeRenderedFramesToEditableLayers } from '../../packages/export/src/index.js';

test('pixel validation fails missing expected frames and one-pixel drift', () => {
  const expected = [
    { action: 'stand', frameIndex: 0, width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([1, 2, 3, 255]) },
    { action: 'walk', frameIndex: 0, width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([1, 2, 3, 255]) },
  ];
  const actual = [{ action: 'stand', frameIndex: 0, width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([1, 2, 4, 255]) }];
  const report = validateRenderedFrames(expected, actual, exactRgbaPolicy);
  assert.equal(report.pass, false);
  assert.equal(report.frames.length, 2);
  assert.equal(diffFrames(expected[0], actual[0], exactRgbaPolicy).diffPixels, 1);
  const duplicateReport = validateRenderedFrames([expected[0], expected[0]], [actual[0]], exactRgbaPolicy);
  assert.equal(duplicateReport.pass, false);
});

test('mapping validation rejects duplicate and invalid whole-avatar mappings', () => {
  const source = new ImageUploadAdapter().load({ id: 'fixture-invalid', label: 'Fixture', completeDetectedAnimationRange: true, files: [
    { name: 'a.png', imageRef: 'a', width: 1, height: 1, partId: 'a', action: 'stand', frameIndex: 0 },
    { name: 'b.png', imageRef: 'b', width: 1, height: 1, partId: 'b', action: 'stand', frameIndex: 0 },
  ] });
  const base = { userConfirmedAt: new Date().toISOString(), placement: { anchor: { x: 0, y: 0, origin: 'top-left' as const }, offsetX: 0, offsetY: 0 } };
  assert.throws(() => validateMappingsForExport(source, [
    { id: 'a1', sourcePartIds: ['a'], targetPartId: 'hair', mode: 'part', ...base },
    { id: 'a2', sourcePartIds: ['a'], targetPartId: 'cap-a1', mode: 'part', ...base },
    { id: 'b1', sourcePartIds: ['b'], targetPartId: 'pants', mode: 'part', ...base },
  ]), /more than once/);
  assert.throws(() => validateMappingsForExport(source, [
    { id: 'whole', sourcePartIds: ['a'], targetPartId: 'longcoat', mode: 'whole-avatar', ...base },
    { id: 'b1', sourcePartIds: ['b'], targetPartId: 'pants', mode: 'part', ...base },
  ]), /Whole-avatar/);
});

function findLayerByPath(layers: Layer[] | undefined, wantedPath: string, parent = ''): Layer | undefined {
  for (const layer of layers ?? []) {
    const current = parent ? `${parent}/${layer.name}` : layer.name ?? '';
    if (current === wantedPath) return layer;
    const nested = findLayerByPath(layer.children, wantedPath, current);
    if (nested) return nested;
  }
  return undefined;
}

test('writes rendered pixels into template editable layers', () => {
  const reader = new AgPsdTemplateReader();
  const target = reader.manifestToTargetPart(reader.inventory('avatartemplate').find((m) => m.file.endsWith('Avatar_Hair.psd'))!);
  const slot = target.editableLayers[0];
  const psd = readPsd(readFileSync(target.templatePath), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const rendered = target.frameGrid!.cells.map((cell) => ({
    action: cell.action,
    frameIndex: cell.frameIndex,
    width: target.width,
    height: target.height,
    sourceFrameIds: ['fixture'],
    rgbaBuffer: new Uint8ClampedArray(target.width * target.height * 4),
  }));
  const offset = (slot.top * target.width + slot.left) * 4;
  rendered[0].rgbaBuffer[offset] = 9;
  rendered[0].rgbaBuffer[offset + 1] = 200;
  rendered[0].rgbaBuffer[offset + 2] = 40;
  rendered[0].rgbaBuffer[offset + 3] = 255;
  const replaced = writeRenderedFramesToEditableLayers(psd, target, rendered);
  const edited = findLayerByPath(psd.children, slot.path)!;
  assert.ok(replaced > 0);
  assert.equal(edited.imageData?.data[0], 9);
  assert.equal(edited.imageData?.data[1], 200);
  assert.equal(edited.imageData?.data[2], 40);
  assert.equal(edited.imageData?.data[3], 255);
});

import { buildEditableLayerSlots } from '../../packages/export/src/index.js';
import { projectFramesToTargetGrid, runConversionPipeline } from '../../packages/conversion/src/index.js';

function projectionPlanForTarget(target: ReturnType<AgPsdTemplateReader['manifestToTargetPart']>, sourceAction = 'stand') {
  return {
    cells: target.frameGrid!.cells.map((cell) => ({
      sourceAction,
      sourceFrameIndex: cell.frameIndex,
      targetAction: cell.action,
      targetFrameIndex: cell.frameIndex,
    })),
  };
}

function expectedSolidFrames(target: ReturnType<AgPsdTemplateReader['manifestToTargetPart']>, color: [number, number, number, number], sourceAction = 'stand') {
  return target.frameGrid!.cells.map((cell) => {
    const rgbaBuffer = new Uint8ClampedArray(target.width * target.height * 4);
    rgbaBuffer[0] = color[0];
    rgbaBuffer[1] = color[1];
    rgbaBuffer[2] = color[2];
    rgbaBuffer[3] = color[3];
    return { action: sourceAction, frameIndex: cell.frameIndex, width: target.width, height: target.height, sourceFrameIds: ['expected'], rgbaBuffer };
  });
}

test('pipeline rejects independent golden drift and mismatched export targets', async () => {
  const out = 'artifacts/test-pipeline-guard';
  rmSync(out, { recursive: true, force: true });
  const reader = new AgPsdTemplateReader();
  const target = reader.manifestToTargetPart(reader.inventory('avatartemplate').find((m) => m.file.endsWith('Avatar_Hair.psd'))!);
  const source = new ImageUploadAdapter().load({ id: 'guard', label: 'Guard', completeDetectedAnimationRange: true, files: target.frameGrid!.cells.map((cell) => ({
    name: `part-${cell.frameIndex}.png`,
    imageRef: `part-${cell.frameIndex}`,
    width: 1,
    height: 1,
    partId: 'part',
    action: 'stand',
    frameIndex: cell.frameIndex,
  })) });
  const normalized = await normalizeSourceFrameSet(source, () => ({ width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([10, 0, 0, 255]) }));
  const mapping: MappingPlan = { id: 'm1', sourcePartIds: ['part'], targetPartId: 'hair', mode: 'part', userConfirmedAt: new Date().toISOString(), placement: { anchor: { x: 0, y: 0, origin: 'top-left' }, offsetX: 0, offsetY: 0 } };
  const job = { id: 'guard-job', sourceFrameSet: source, normalizedFrameSet: normalized, mappings: [mapping], validationPolicy: exactRgbaPolicy, outputDir: out, frameProjectionPlan: projectionPlanForTarget(target) };
  assert.throws(() => runConversionPipeline({ job, target, templateInventoryRef: 'artifacts/g0/original-template-manifest.json', goldenFrames: () => expectedSolidFrames(target, [11, 0, 0, 255]) }), /source action frames/);
  assert.throws(() => runConversionPipeline({ job: { ...job, mappings: [{ ...mapping, targetPartId: 'pants' }] }, target, templateInventoryRef: 'artifacts/g0/original-template-manifest.json', goldenFrames: () => expectedSolidFrames(target, [10, 0, 0, 255]) }), /not export target/);
});

test('validation fails corrupt rgba buffer lengths and invalid target ids', () => {
  const expected = { action: 'stand', frameIndex: 0, width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([1, 2, 3, 255]) };
  const corrupt = { action: 'stand', frameIndex: 0, width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([]) };
  assert.equal(diffFrames(expected, corrupt, exactRgbaPolicy).pass, false);
  const source = new ImageUploadAdapter().load({ id: 'target-invalid', label: 'Target', completeDetectedAnimationRange: true, files: [
    { name: 'a.png', imageRef: 'a', width: 1, height: 1, partId: 'a', action: 'stand', frameIndex: 0 },
  ] });
  assert.throws(() => validateMappingsForExport(source, [{
    id: 'bad-target', sourcePartIds: ['a'], targetPartId: 'not-a-template' as MappingPlan['targetPartId'], mode: 'part', userConfirmedAt: new Date().toISOString(), placement: { anchor: { x: 0, y: 0, origin: 'top-left' }, offsetX: 0, offsetY: 0 },
  }]), /unknown MSW part/);
});

test('editable layer slots are explicit and deterministic across multiple layers', () => {
  const reader = new AgPsdTemplateReader();
  const target = reader.manifestToTargetPart(reader.inventory('avatartemplate').find((m) => m.file.endsWith('Avatar_Cap_Ani.psd'))!);
  const frames = target.frameGrid!.cells.map((cell) => ({ action: cell.action, frameIndex: cell.frameIndex, width: target.width, height: target.height, sourceFrameIds: [], rgbaBuffer: new Uint8ClampedArray(target.width * target.height * 4) })).reverse();
  const slots = buildEditableLayerSlots(target, frames);
  assert.ok(slots.length > 1);
  assert.deepEqual(slots.slice(0, 2).map((slot) => slot.frame.frameIndex), [0, 1]);
});


test('editable layer slots reject frameGrid semantic mismatch', () => {
  const reader = new AgPsdTemplateReader();
  const target = reader.manifestToTargetPart(reader.inventory('avatartemplate').find((m) => m.file.endsWith('Avatar_Hair.psd'))!);
  const frame = { action: 'wrong-action', frameIndex: 0, width: target.width, height: target.height, sourceFrameIds: [], rgbaBuffer: new Uint8ClampedArray(target.width * target.height * 4) };
  assert.throws(() => buildEditableLayerSlots(target, [frame]), /Missing rendered frame/);
});

test('export rejects missing frameGrid frames and sanitizes action filenames', () => {
  const reader = new AgPsdTemplateReader();
  const target = reader.manifestToTargetPart(reader.inventory('avatartemplate').find((m) => m.file.endsWith('Avatar_Cap_Ani.psd'))!);
  const singleFrame = [{ action: 'template-slot', frameIndex: 0, width: target.width, height: target.height, sourceFrameIds: [], rgbaBuffer: new Uint8ClampedArray(target.width * target.height * 4) }];
  assert.throws(() => buildEditableLayerSlots(target, singleFrame), /Missing rendered frame/);
});

test('review bundle action filenames cannot traverse out of preview or diff directories', async () => {
  const out = 'artifacts/test-safe-review-bundle';
  rmSync(out, { recursive: true, force: true });
  rmSync('artifacts/escape-0.png', { force: true });
  const source = new ImageUploadAdapter().load({ id: 'safe', label: 'Safe', completeDetectedAnimationRange: true, files: [
    { name: 'part.png', imageRef: 'part', width: 1, height: 1, partId: 'part', action: '../../escape', frameIndex: 0 },
  ] });
  const normalized = await normalizeSourceFrameSet(source, () => ({ width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([1, 2, 3, 255]) }));
  const reader = new AgPsdTemplateReader();
  const targetBase = reader.manifestToTargetPart(reader.inventory('avatartemplate').find((m) => m.file.endsWith('Avatar_Hair.psd'))!);
  const target = {
    ...targetBase,
    frameGrid: {
      actions: ['../../escape'],
      cells: targetBase.frameGrid!.cells.map((cell) => ({ ...cell, action: '../../escape' })),
    },
  };
  const frames = target.frameGrid.cells.map((cell) => ({ action: cell.action, frameIndex: cell.frameIndex, width: target.width, height: target.height, sourceFrameIds: [], rgbaBuffer: new Uint8ClampedArray(target.width * target.height * 4) }));
  const validationReport = validateRenderedFrames(frames, frames, exactRgbaPolicy);
  exportReviewBundle({ outputDir: out, target, normalized, mappings: [{ id: 'm', sourcePartIds: ['part'], targetPartId: 'hair', mode: 'part', userConfirmedAt: new Date().toISOString(), placement: { anchor: { x: 0, y: 0, origin: 'top-left' }, offsetX: 0, offsetY: 0 } }], renderedFrames: frames, expectedFrames: frames.map((frame) => ({ ...frame, rgbaBuffer: new Uint8ClampedArray(frame.rgbaBuffer) })), validationReport, validationPolicy: exactRgbaPolicy, templateInventoryRef: 'artifacts/g0/original-template-manifest.json' });
  assert.equal(existsSync('artifacts/escape-0.png'), false);
});


test('pipeline exports ordinary source actions through target frameGrid projection', async () => {
  const out = 'artifacts/test-pipeline-positive';
  rmSync(out, { recursive: true, force: true });
  const reader = new AgPsdTemplateReader();
  const target = reader.manifestToTargetPart(reader.inventory('avatartemplate').find((m) => m.file.endsWith('Avatar_Hair.psd'))!);
  const source = new ImageUploadAdapter().load({ id: 'pipeline-positive', label: 'Pipeline', completeDetectedAnimationRange: true, files: target.frameGrid!.cells.map((cell) => (
    { name: `part-${cell.frameIndex}.png`, imageRef: `part-${cell.frameIndex}`, width: 1, height: 1, partId: 'part', action: 'stand', frameIndex: cell.frameIndex }
  )) });
  const normalized = await normalizeSourceFrameSet(source, () => ({ width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([12, 34, 56, 255]) }));
  const mapping: MappingPlan = { id: 'm', sourcePartIds: ['part'], targetPartId: 'hair', mode: 'part', userConfirmedAt: new Date().toISOString(), placement: { anchor: { x: 0, y: 0, origin: 'top-left' }, offsetX: 0, offsetY: 0 } };
  const result = runConversionPipeline({
    job: { id: 'pipeline-positive-job', sourceFrameSet: source, normalizedFrameSet: normalized, mappings: [mapping], validationPolicy: exactRgbaPolicy, outputDir: out, frameProjectionPlan: projectionPlanForTarget(target) },
    target,
    templateInventoryRef: 'artifacts/g0/original-template-manifest.json',
    goldenFrames: () => expectedSolidFrames(target, [12, 34, 56, 255]),
  });
  assert.equal(result.validationReport.pass, true);
  assert.equal(existsSync(`${out}/Avatar_Hair.psd`), true);
});


test('projectFramesToTargetGrid rejects undersupplied target coverage', () => {
  const reader = new AgPsdTemplateReader();
  const target = reader.manifestToTargetPart(reader.inventory('avatartemplate').find((m) => m.file.endsWith('Avatar_Hair.psd'))!);
  const frame = { action: 'stand', frameIndex: 0, width: target.width, height: target.height, sourceFrameIds: [], rgbaBuffer: new Uint8ClampedArray(target.width * target.height * 4) };
  assert.throws(() => projectFramesToTargetGrid([frame], target), /do not match target frameGrid keys|must cover/);
  assert.throws(() => projectFramesToTargetGrid([frame], { ...target, frameGrid: undefined }), /no explicit frameGrid/);
});


test('review bundle rejects output and template path escapes when roots are configured', async () => {
  const reader = new AgPsdTemplateReader();
  const target = reader.manifestToTargetPart(reader.inventory('avatartemplate').find((m) => m.file.endsWith('Avatar_Hair.psd'))!);
  const frames = target.frameGrid!.cells.map((cell) => ({ action: cell.action, frameIndex: cell.frameIndex, width: target.width, height: target.height, sourceFrameIds: [], rgbaBuffer: new Uint8ClampedArray(target.width * target.height * 4) }));
  const source = new ImageUploadAdapter().load({ id: 'root-safe', label: 'Root', completeDetectedAnimationRange: true, files: target.frameGrid!.cells.map((cell) => ({ name: `part-${cell.frameIndex}.png`, imageRef: `part-${cell.frameIndex}`, width: 1, height: 1, partId: 'part', action: 'stand', frameIndex: cell.frameIndex })) });
  const normalized = await normalizeSourceFrameSet(source, () => ({ width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([1, 2, 3, 255]) }));
  const validationReport = validateRenderedFrames(frames, frames, exactRgbaPolicy);
  const baseInput = { target, normalized, mappings: [{ id: 'm', sourcePartIds: ['part'], targetPartId: 'hair' as const, mode: 'part' as const, userConfirmedAt: new Date().toISOString(), placement: { anchor: { x: 0, y: 0, origin: 'top-left' as const }, offsetX: 0, offsetY: 0 } }], renderedFrames: frames, expectedFrames: frames.map((frame) => ({ ...frame, rgbaBuffer: new Uint8ClampedArray(frame.rgbaBuffer) })), validationReport, validationPolicy: exactRgbaPolicy, templateInventoryRef: 'artifacts/g0/original-template-manifest.json' };
  assert.throws(() => exportReviewBundle({ ...baseInput, outputDir: '../escape', allowedOutputRoot: 'artifacts' }), /Unsafe output directory/);
  assert.throws(() => exportReviewBundle({ ...baseInput, outputDir: 'artifacts/root-safe', target: { ...target, templatePath: '../outside.psd' } }), /Unsafe template path/);
});
