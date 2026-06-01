import test from 'node:test';
import assert from 'node:assert/strict';
import { listTemplatePaths, manifestFor } from '../../packages/psd-gate/src/manifest.js';

test('lists all local PSD templates', () => {
  const files = listTemplatePaths();
  assert.equal(files.length, 17);
  assert.ok(files.every((file) => file.startsWith('avatartemplate/')));
});

test('reads a PSD manifest with dimensions and layers', () => {
  const file = listTemplatePaths()[0];
  const manifest = manifestFor(file);
  assert.ok(manifest.width > 0);
  assert.ok(manifest.height > 0);
  assert.ok(manifest.sizeBytes > 0);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
});
