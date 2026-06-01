import { mkdirSync, writeFileSync } from 'node:fs';
import { listTemplatePaths, manifestFor } from '../packages/psd-gate/src/manifest.js';

mkdirSync('artifacts/g0', { recursive: true });
mkdirSync('docs', { recursive: true });
const manifests = listTemplatePaths().map((file) => manifestFor(file));
writeFileSync('artifacts/g0/original-template-manifest.json', JSON.stringify({ generatedAt: new Date().toISOString(), templates: manifests }, null, 2));
const md = [
  '# Template Inventory',
  '',
  `Generated: ${new Date().toISOString()}`,
  '',
  '| Template | Size | Mode | Layers | Groups | Max depth | Composite |',
  '|---|---:|---|---:|---:|---:|---|',
  ...manifests.map((m) => `| ${m.file} | ${m.width}x${m.height} | channels=${m.channels ?? 'n/a'}, bits=${m.bitsPerChannel ?? 'n/a'}, colorMode=${m.colorMode ?? 'n/a'} | ${m.layerCount} | ${m.groupCount} | ${m.maxDepth} | ${m.hasCompositeImageData ? 'yes' : 'no'} |`),
  '',
  '## Layer Trees',
  '',
  ...manifests.flatMap((m) => [
    `### ${m.file}`,
    '',
    ...m.layers.map((l) => `- ${l.kind === 'group' ? '📁' : '🧩'} ${l.path} (${l.left ?? '?'}:${l.top ?? '?'} → ${l.right ?? '?'}:${l.bottom ?? '?'}, hidden=${l.hidden}, opacity=${l.opacity ?? 'n/a'}, rawChannels=${l.rawChannelCount})`),
    '',
  ]),
].join('\n');
writeFileSync('docs/template-inventory.md', md);
console.log(`Inventoried ${manifests.length} PSD templates.`);
