import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageUploadAdapter } from '../../packages/source-adapters/src/index.js';
import { normalizeSourceFrameSet, validateMappingsForExport } from '../../packages/core/src/index.js';

const adapter = new ImageUploadAdapter();

test('image upload adapter emits generic SourceFrameSet', () => {
  const set = adapter.load({ id: 'fixture', label: 'Fixture', completeDetectedAnimationRange: true, files: [
    { name: 'body.png', imageRef: 'body.png', width: 2, height: 2, partId: 'body', action: 'stand', frameIndex: 0 },
    { name: 'weapon.png', imageRef: 'weapon.png', width: 2, height: 2, partId: 'weapon', action: 'stand', frameIndex: 0 },
  ] });
  assert.equal(set.parts.length, 2);
  assert.deepEqual(set.actions, ['stand']);
  assert.equal(set.completeDetectedAnimationRange, true);
});

test('export validation rejects unmapped parts', () => {
  const set = adapter.load({ id: 'fixture', label: 'Fixture', completeDetectedAnimationRange: true, files: [
    { name: 'body.png', imageRef: 'body.png', width: 2, height: 2, partId: 'body', action: 'stand', frameIndex: 0 },
    { name: 'weapon.png', imageRef: 'weapon.png', width: 2, height: 2, partId: 'weapon', action: 'stand', frameIndex: 0 },
  ] });
  assert.throws(() => validateMappingsForExport(set, [{
    id: 'm1', sourcePartIds: ['body'], targetPartId: 'longcoat', mode: 'part', userConfirmedAt: new Date().toISOString(), placement: { anchor: { x: 0, y: 0, origin: 'top-left' }, offsetX: 0, offsetY: 0 },
  }]), /Missing: weapon/);
});

test('normalization produces canonical frames from a source frame set', async () => {
  const set = adapter.load({ id: 'fixture', label: 'Fixture', completeDetectedAnimationRange: true, files: [
    { name: 'body.png', imageRef: 'body.png', width: 1, height: 1, partId: 'body', action: 'walk', frameIndex: 0 },
  ] });
  const normalized = await normalizeSourceFrameSet(set, () => ({ width: 1, height: 1, rgbaBuffer: new Uint8ClampedArray([0, 0, 0, 0]) }));
  assert.equal(normalized.frames.length, 1);
  assert.equal(normalized.frames[0].action, 'walk');
  assert.equal(normalized.policies.color.kind, 'srgb-rgba');
});


test('image upload adapter rejects incomplete discovery metadata', () => {
  assert.throws(() => adapter.load({ id: 'incomplete', label: 'Incomplete', files: [
    { name: 'body.png', imageRef: 'body.png', width: 2, height: 2, partId: 'body', action: 'stand', frameIndex: 0 },
  ] }), /completeDetectedAnimationRange=true/);
  assert.throws(() => adapter.load({ id: 'missing-action', label: 'Missing', completeDetectedAnimationRange: true, files: [
    { name: 'body.png', imageRef: 'body.png', width: 2, height: 2, partId: 'body', frameIndex: 0 },
  ] }), /missing required action/);
  assert.throws(() => adapter.load({ id: 'missing-frame', label: 'Missing', completeDetectedAnimationRange: true, files: [
    { name: 'body.png', imageRef: 'body.png', width: 2, height: 2, partId: 'body', action: 'stand' },
  ] }), /frameIndex/);
});
