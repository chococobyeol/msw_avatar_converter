import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buildMeaegiShareImport, extractMeaegiShareId, MEAEGI_GET_SHARE_ACTION_ID, parseMeaegiFlight } from './src/meaegiShare.js';
import { bakeMeaegiWholeAvatar, isBakeTarget, type BakeTarget, type FrameCorrection } from './scripts/bake-meaegi-whole-avatar.js';
import { measureRedDotDrift } from './scripts/measure-red-dot-drift.js';

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.gif')) return 'image/gif';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.psd')) return 'application/octet-stream';
  return 'application/octet-stream';
}

function artifactUrl(filePath: string, version?: string): string {
  const url = `/${filePath.split(path.sep).map(encodeURIComponent).join('/')}`;
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

function artifactPathFromUrl(value: string): string {
  const pathname = decodeURIComponent(new URL(value, 'http://localhost').pathname.replace(/^\/+/, ''));
  const resolved = path.resolve(pathname);
  const artifactRoot = path.resolve('artifacts');
  if (!resolved.startsWith(`${artifactRoot}${path.sep}`)) throw new Error('artifact path is outside artifacts/.');
  return resolved;
}

function readRequestBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bakeOutDir(share: string, target: BakeTarget): string {
  return path.join('artifacts', 'whole-avatar-bake', share, target);
}

function calibrationPath(share: string, target: BakeTarget): string {
  return path.join(bakeOutDir(share, target), 'manual-frame-corrections.json');
}

function newBakeRunDir(share: string, target: BakeTarget): string {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(bakeOutDir(share, target), 'runs', runId);
}

function newMappedBakeRunDir(share: string): string {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('artifacts', 'mapped-part-bake', share, 'runs', runId);
}

function safeArtifactSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'unnamed';
}

interface MappingExportRow {
  partId: string;
  targetPartId: string;
  mode: 'part' | 'group' | 'whole-avatar';
  groupId?: string;
  confirmed?: boolean;
}

function groupMappingRows(rows: MappingExportRow[]) {
  const groups = new Map<string, { key: string; target: string; mode: MappingExportRow['mode']; groupId: string; partIds: string[] }>();
  for (const row of rows.filter((mapping) => mapping.confirmed !== false)) {
    const groupId = row.mode === 'whole-avatar'
      ? 'whole-avatar'
      : row.mode === 'group'
        ? row.groupId || 'bundle'
        : row.partId;
    const key = `${row.targetPartId}::${row.mode}::${groupId}`;
    const current = groups.get(key) ?? { key, target: row.targetPartId, mode: row.mode, groupId, partIds: [] };
    if (!current.partIds.includes(row.partId)) current.partIds.push(row.partId);
    groups.set(key, current);
  }
  return [...groups.values()];
}

function readSavedCalibration(share: string, target: BakeTarget): Record<string, FrameCorrection> | undefined {
  const filePath = calibrationPath(share, target);
  if (!existsSync(filePath)) return undefined;
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { corrections?: Record<string, FrameCorrection> };
  return parsed.corrections;
}

function correctionsFromRedGreenReport(report: ReturnType<typeof measureRedDotDrift>): Record<string, FrameCorrection> {
  return Object.fromEntries(report.frames
    .filter((frame) => frame.deltaActualMinusExpected)
    .map((frame) => [
      frame.key,
      {
        dx: frame.deltaActualMinusExpected!.dx,
        dy: frame.deltaActualMinusExpected!.dy,
        reason: 'calibrated from UI uploaded red/green dot overlay',
      },
    ]));
}

function meaegiSharePlugin(): Plugin {
  return {
    name: 'local-meaegi-share-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        try {
          if (!req.url?.startsWith('/artifacts/')) return next();
          const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
          const resolved = path.resolve(pathname);
          const artifactRoot = path.resolve('artifacts');
          if (!resolved.startsWith(`${artifactRoot}${path.sep}`)) throw new Error('artifact path is outside artifacts/.');
          const data = readFileSync(resolved);
          res.statusCode = 200;
          res.setHeader('content-type', contentTypeFor(resolved));
          if (resolved.endsWith('.psd')) res.setHeader('content-disposition', `attachment; filename="${path.basename(resolved)}"`);
          res.end(data);
        } catch (error) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
      server.middlewares.use('/api/meaegi-share', async (req, res) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const share = extractMeaegiShareId(requestUrl.searchParams.get('share') || '');
          if (!share) throw new Error('share query is required.');
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
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(buildMeaegiShareImport(share, parseMeaegiFlight(text))));
        } catch (error) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
      server.middlewares.use('/api/bake-meaegi', async (req, res) => {
        try {
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const share = extractMeaegiShareId(requestUrl.searchParams.get('share') || '');
          const target = (requestUrl.searchParams.get('target') || 'cape') as BakeTarget;
          const format = requestUrl.searchParams.get('format') || 'json';
          const selectedPartIds = (requestUrl.searchParams.get('parts') || '')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
          if (!share) throw new Error('share query is required.');
          const outDir = newBakeRunDir(share, target);
          const savedManualFrameCorrections = readSavedCalibration(share, target);
          const { report, psdPath } = await bakeMeaegiWholeAvatar({ share, target, outDir, selectedPartIds: selectedPartIds.length > 0 ? selectedPartIds : undefined, manualFrameCorrections: savedManualFrameCorrections });
          const artifactVersion = String(Date.now());
          const downloadName = `${path.basename(psdPath, '.psd')}_${share}_${target}_${path.basename(outDir)}.psd`;
          if (format !== 'psd' && format !== 'download') {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({
              report,
              files: {
                psd: artifactUrl(psdPath, artifactVersion),
                psdDownloadName: downloadName,
                report: artifactUrl(path.join(outDir, 'validation-report.json'), artifactVersion),
                expectedSheet: artifactUrl(path.join(outDir, 'expected-sheet.png'), artifactVersion),
                templateGuideSheet: artifactUrl(path.join(outDir, 'original-template-guide-sheet.png'), artifactVersion),
                templateReferenceSheet: artifactUrl(path.join(outDir, 'original-template-reference-sheet.png'), artifactVersion),
                convertedEditableSheet: artifactUrl(path.join(outDir, 'converted-editable-sheet.png'), artifactVersion),
                diff: artifactUrl(path.join(outDir, 'diff.png'), artifactVersion),
                redDots: {
                  sourceBakedSheet: artifactUrl(path.join(outDir, 'red-dot-source-baked-sheet.png'), artifactVersion),
                  templateGuideSheet: artifactUrl(path.join(outDir, 'red-dot-template-guide-sheet.png'), artifactVersion),
                  convertedSheet: artifactUrl(path.join(outDir, 'red-dot-converted-sheet.png'), artifactVersion),
                  overlaySheet: artifactUrl(path.join(outDir, 'red-dot-template-vs-converted-overlay-sheet.png'), artifactVersion),
                  coordinates: artifactUrl(path.join(outDir, 'red-dot-coordinates.json'), artifactVersion),
                },
                motionComparisonGifs: report.validation.motionComparisons.map((artifact) => ({
                  action: artifact.action,
                  frameCount: artifact.frameCount,
                  gif: artifact.gifPath ? artifactUrl(path.join(outDir, artifact.gifPath), artifactVersion) : null,
                  frameDir: artifactUrl(path.join(outDir, artifact.frameDir), artifactVersion),
                  sourceVsConvertedDiffPixels: artifact.sourceVsConvertedDiffPixels,
                  sourceVsTemplateDiffPixels: artifact.sourceVsTemplateDiffPixels,
                })),
              },
            }));
            return;
          }
          const psd = readFileSync(psdPath);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/octet-stream');
          res.setHeader('content-disposition', `attachment; filename="${downloadName}"`);
          res.setHeader('x-bake-target', String(report.target));
          res.setHeader('x-bake-output', String(report.outputPsd));
          res.setHeader('x-bake-frames', String(report.bakedFrames));
          res.setHeader('x-bake-skipped-frames', String(report.skippedFrames));
          res.setHeader('x-bake-diff-pixels', String(report.validation.diffPixels));
          res.setHeader('x-bake-max-delta', String(report.validation.maxChannelDelta));
          res.setHeader('x-bake-frame-cell-diff-pixels', String(report.validation.frameCellDiffPixels));
          res.setHeader('x-bake-frame-cell-max-delta', String(report.validation.frameCellMaxChannelDelta));
          res.end(psd);
        } catch (error) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
      server.middlewares.use('/api/bake-meaegi-mapped', async (req, res) => {
        try {
          if (req.method !== 'POST') throw new Error('POST required.');
          const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
            share?: string;
            mappings?: MappingExportRow[];
          };
          const share = extractMeaegiShareId(body.share || '');
          if (!share) throw new Error('share is required.');
          const groups = groupMappingRows(body.mappings ?? []);
          if (groups.length === 0) throw new Error('at least one confirmed mapping is required.');
          const runDir = newMappedBakeRunDir(share);
          mkdirSync(runDir, { recursive: true });
          const artifactVersion = String(Date.now());
          const results = [];
          for (const group of groups) {
            if (!isBakeTarget(group.target)) {
              results.push({
                ok: false,
                group,
                error: `target "${group.target}" is not a supported PSD bake target. Use one of the targetParts options, including cape/cape-balloon/longcoat/gloves/pants/shoes/hair/cap-*.`,
              });
              continue;
            }
            try {
              const outDir = path.join(runDir, safeArtifactSegment(`${group.target}-${group.mode}-${group.groupId}`));
              const savedManualFrameCorrections = readSavedCalibration(share, group.target);
              const { report, psdPath } = await bakeMeaegiWholeAvatar({
                share,
                target: group.target,
                outDir,
                selectedPartIds: group.partIds,
                manualFrameCorrections: savedManualFrameCorrections,
              });
              results.push({
                ok: true,
                group,
                report,
                files: {
                  psd: artifactUrl(psdPath, artifactVersion),
                  psdDownloadName: `${path.basename(psdPath, '.psd')}_${share}_${safeArtifactSegment(group.key)}_${path.basename(runDir)}.psd`,
                  report: artifactUrl(path.join(outDir, 'validation-report.json'), artifactVersion),
                  expectedSheet: artifactUrl(path.join(outDir, 'expected-sheet.png'), artifactVersion),
                  templateGuideSheet: artifactUrl(path.join(outDir, 'original-template-guide-sheet.png'), artifactVersion),
                  templateReferenceSheet: artifactUrl(path.join(outDir, 'original-template-reference-sheet.png'), artifactVersion),
                  convertedEditableSheet: artifactUrl(path.join(outDir, 'converted-editable-sheet.png'), artifactVersion),
                  diff: artifactUrl(path.join(outDir, 'diff.png'), artifactVersion),
                  motionComparisonGifs: report.validation.motionComparisons.map((artifact) => ({
                    action: artifact.action,
                    frameCount: artifact.frameCount,
                    gif: artifact.gifPath ? artifactUrl(path.join(outDir, artifact.gifPath), artifactVersion) : null,
                    sourceVsConvertedDiffPixels: artifact.sourceVsConvertedDiffPixels,
                    sourceVsTemplateDiffPixels: artifact.sourceVsTemplateDiffPixels,
                  })),
                },
              });
            } catch (error) {
              results.push({ ok: false, group, error: (error as Error).message });
            }
          }
          const manifest = {
            kind: 'msw-avatar-mapped-part-bake',
            share,
            runDir,
            groups,
            ok: results.every((result) => result.ok),
            exportedGroups: results.filter((result) => result.ok).length,
            failedGroups: results.filter((result) => !result.ok).length,
            results,
          };
          const manifestPath = path.join(runDir, 'mapped-bake-manifest.json');
          writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ...manifest, files: { manifest: artifactUrl(manifestPath, artifactVersion) } }));
        } catch (error) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
      server.middlewares.use('/api/red-dot-measure', async (req, res) => {
        try {
          if (req.method !== 'POST') throw new Error('POST required.');
          const requestUrl = new URL(req.url || '', 'http://localhost');
          const expected = requestUrl.searchParams.get('expected') || '';
          const share = extractMeaegiShareId(requestUrl.searchParams.get('share') || '');
          const target = (requestUrl.searchParams.get('target') || '') as BakeTarget;
          if (!expected) throw new Error('expected query is required.');
          const expectedPath = artifactPathFromUrl(expected);
          const fileName = path.basename(String(req.headers['x-file-name'] || 'adjusted-red-dot.png')).replace(/[^a-zA-Z0-9._-]/g, '_');
          const ext = path.extname(fileName).toLowerCase();
          if (ext !== '.png' && ext !== '.psd') throw new Error('actual file must be .png or .psd.');
          const uploadDir = path.join('artifacts', 'red-dot-measure', String(Date.now()));
          mkdirSync(uploadDir, { recursive: true });
          const actualPath = path.join(uploadDir, fileName);
          writeFileSync(actualPath, await readRequestBody(req));
          const report = measureRedDotDrift(expectedPath, actualPath, 'red', 'green');
          const reportPath = path.join(uploadDir, 'red-dot-measurement.json');
          writeFileSync(reportPath, JSON.stringify(report, null, 2));
          const corrections = correctionsFromRedGreenReport(report);
          let savedCalibrationPath: string | null = null;
          if (share && target && report.missingFrames === 0) {
            const filePath = calibrationPath(share, target);
            mkdirSync(path.dirname(filePath), { recursive: true });
            writeFileSync(filePath, JSON.stringify({
              share,
              target,
              source: 'ui-red-green-dot-upload',
              measuredAt: new Date().toISOString(),
              expectedPath,
              actualPath,
              reportPath,
              corrections,
            }, null, 2));
            savedCalibrationPath = filePath;
          }
          const artifactVersion = String(Date.now());
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({
            ...report,
            files: {
              uploadedActual: artifactUrl(actualPath, artifactVersion),
              report: artifactUrl(reportPath, artifactVersion),
              calibration: savedCalibrationPath ? artifactUrl(savedCalibrationPath, artifactVersion) : null,
            },
            calibration: {
              saved: Boolean(savedCalibrationPath),
              corrections: Object.keys(corrections).length,
            },
          }));
        } catch (error) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), meaegiSharePlugin()],
});
