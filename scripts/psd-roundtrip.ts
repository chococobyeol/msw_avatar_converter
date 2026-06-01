import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readPsd, writePsdBuffer } from 'ag-psd';
import { ensureCanvasInitialized } from '../packages/psd-gate/src/canvas.js';
import { comparableLayerSignature, listTemplatePaths, manifestFor, sha256 } from '../packages/psd-gate/src/manifest.js';
import { diffPixelData, writePixelDataPng } from '../packages/psd-gate/src/png.js';
import type { DiffMetric } from '../packages/psd-gate/src/types.js';

ensureCanvasInitialized();

for (const dir of ['artifacts/g0', 'artifacts/g0/roundtrip-psd', 'artifacts/g0/original-composites', 'artifacts/g0/roundtrip-composites']) mkdirSync(dir, { recursive: true });

const metrics: DiffMetric[] = [];
const roundtripManifests = [];
const backendWarnings: string[] = [];

for (const file of listTemplatePaths()) {
  const base = path.basename(file, '.psd');
  const originalBuffer = await import('node:fs').then((fs) => fs.readFileSync(file));
  const originalPsd = readPsd(originalBuffer, { useImageData: true, useRawData: false, skipThumbnail: true, skipLinkedFilesData: true, logMissingFeatures: true });
  const originalManifest = manifestFor(file, originalPsd);
  writePixelDataPng(`artifacts/g0/original-composites/${base}.png`, originalPsd.imageData);

  const warnings: string[] = [];
  let roundtripBuffer: Buffer | null = null;
  try {
    roundtripBuffer = writePsdBuffer(originalPsd, { generateThumbnail: false, trimImageData: false, logMissingFeatures: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`writePsdBuffer failed: ${message}`);
    backendWarnings.push(`${file}: ${message}`);
  }

  if (!roundtripBuffer) {
    metrics.push({
      template: file,
      pass: false,
      originalBytes: originalBuffer.length,
      roundtripBytes: 0,
      originalSha256: sha256(originalBuffer),
      roundtripSha256: '',
      dimensionsMatch: false,
      channelsMatch: false,
      bitsPerChannelMatch: false,
      colorModeMatch: false,
      layerTreeMatch: false,
      layerTreeDiffs: ['roundtrip write failed'],
      compositeComparable: false,
      compositeDiffPixels: null,
      compositeDiffRatio: null,
      maxChannelDelta: null,
      warnings,
    });
    continue;
  }

  const out = `artifacts/g0/roundtrip-psd/${base}.psd`;
  writeFileSync(out, roundtripBuffer);
  const roundtripPsd = readPsd(roundtripBuffer, { useImageData: true, useRawData: false, skipThumbnail: true, skipLinkedFilesData: true, logMissingFeatures: true });
  const roundtripManifest = manifestFor(out, roundtripPsd);
  roundtripManifests.push(roundtripManifest);
  writePixelDataPng(`artifacts/g0/roundtrip-composites/${base}.png`, roundtripPsd.imageData);

  const originalSig = comparableLayerSignature(originalManifest);
  const roundtripSig = comparableLayerSignature(roundtripManifest).map((sig) => sig.replace(`artifacts/g0/roundtrip-psd/`, 'avatartemplate/'));
  const layerTreeDiffs: string[] = [];
  const maxLen = Math.max(originalSig.length, roundtripSig.length);
  for (let i = 0; i < maxLen; i++) {
    if (originalSig[i] !== roundtripSig[i]) layerTreeDiffs.push(`layer[${i}] original=${originalSig[i] ?? '<missing>'} roundtrip=${roundtripSig[i] ?? '<missing>'}`);
  }
  const diff = diffPixelData(originalPsd.imageData, roundtripPsd.imageData);
  const dimensionsMatch = originalManifest.width === roundtripManifest.width && originalManifest.height === roundtripManifest.height;
  const channelsMatch = originalManifest.channels === roundtripManifest.channels;
  const bitsPerChannelMatch = originalManifest.bitsPerChannel === roundtripManifest.bitsPerChannel;
  const colorModeMatch = originalManifest.colorMode === roundtripManifest.colorMode;
  const layerTreeMatch = layerTreeDiffs.length === 0;
  const compositeOk = diff.comparable && diff.diffPixels === 0 && diff.maxChannelDelta === 0;
  metrics.push({
    template: file,
    pass: dimensionsMatch && channelsMatch && bitsPerChannelMatch && colorModeMatch && layerTreeMatch && compositeOk,
    originalBytes: originalBuffer.length,
    roundtripBytes: roundtripBuffer.length,
    originalSha256: sha256(originalBuffer),
    roundtripSha256: sha256(roundtripBuffer),
    dimensionsMatch,
    channelsMatch,
    bitsPerChannelMatch,
    colorModeMatch,
    layerTreeMatch,
    layerTreeDiffs,
    compositeComparable: diff.comparable,
    compositeDiffPixels: diff.diffPixels,
    compositeDiffRatio: diff.diffRatio,
    maxChannelDelta: diff.maxChannelDelta,
    warnings,
  });
}

writeFileSync('artifacts/g0/roundtrip-template-manifest.json', JSON.stringify({ generatedAt: new Date().toISOString(), backend: 'ag-psd', templates: roundtripManifests }, null, 2));
writeFileSync('artifacts/g0/roundtrip-diff-report.json', JSON.stringify({ generatedAt: new Date().toISOString(), backend: 'ag-psd', pass: metrics.every((m) => m.pass), metrics, backendWarnings }, null, 2));
const decision = metrics.every((m) => m.pass) ? 'PASS' : 'FAIL';
writeFileSync('artifacts/g0/backend-decision.md', [
  '# G0 PSD Backend Decision',
  '',
  `Backend candidate: ag-psd`,
  `Decision: ${decision}`,
  '',
  'This gate is conservative: exact structural layer signature and exact comparable composite pixels are required unless a later human-reviewed policy records a numeric tolerance.',
  '',
  '## Failures / Warnings',
  ...metrics.filter((m) => !m.pass || m.warnings.length).map((m) => `- ${m.template}: pass=${m.pass}; warnings=${m.warnings.join('; ') || 'none'}; layerDiffs=${m.layerTreeDiffs.length}; compositeDiffPixels=${m.compositeDiffPixels ?? 'n/a'}`),
].join('\n'));
console.log(`Roundtripped ${metrics.length} PSD templates with ag-psd. pass=${metrics.every((m) => m.pass)}`);
if (!metrics.every((m) => m.pass)) process.exitCode = 1;
