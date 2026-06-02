import React, { useMemo, useState } from 'react';
import { CheckCircle2, Download, Eye, FileText, Layers, Wand2, XCircle } from 'lucide-react';
import { computeUiValidation, defaultTargetForSourcePart, sampleFrames, sampleParts, targetParts, type UiFrame, type UiMappingInput, type UiPart } from './sample.js';

type MappingMode = 'part' | 'group' | 'whole-avatar';
type WholeAvatarBakeTarget = 'cape' | 'cape-balloon' | 'longcoat';

interface UiMapping extends UiMappingInput {
  partId: string;
  targetPartId: string;
  mode: MappingMode;
  groupId: string;
  confirmed: boolean;
}

const initialMappings: UiMapping[] = sampleParts.map((part) => ({
  partId: part.id,
  targetPartId: defaultTargetForSourcePart(part),
  mode: 'part',
  groupId: '',
  confirmed: false,
}));

interface ImportDiagnostics {
  source?: string;
  share?: string;
  renderImageUrl?: string | null;
  warnings?: string[];
  [key: string]: unknown;
}

interface ImportedSourceState {
  source?: string;
  share?: string;
  parts: UiPart[];
  frames: UiFrame[];
  diagnostics?: ImportDiagnostics;
}

interface BakeResultFile {
  action: string;
  frameCount: number;
  gif: string | null;
  frameDir: string;
  sourceVsConvertedDiffPixels: number;
  sourceVsTemplateDiffPixels: number;
}

interface BakeResult {
  report: {
    target: WholeAvatarBakeTarget;
    outputPsd: string;
    bakedFrames: number;
    skippedFrames: number;
    placement: {
      placementValidation?: {
        pass: boolean;
        maxAbsDx: number;
        maxAbsDy: number;
        failedFrames?: number;
        frames?: Array<{
          key: string;
          pass: boolean;
          error?: { dx: number; dy: number };
          cellFullyInsideSheet?: boolean;
          anchorInsideSheet?: boolean;
        }>;
      };
      redDotArtifacts?: Record<string, string>;
      [key: string]: unknown;
    };
    validation: {
      frameCellDiffPixels: number;
      frameCellMaxChannelDelta: number;
      motionComparisonGifsGenerated: number;
    };
  };
  files: {
    psd: string;
    report: string;
    expectedSheet: string;
    templateGuideSheet?: string;
    templateReferenceSheet: string;
    convertedEditableSheet: string;
    diff: string;
    redDots?: {
      sourceBakedSheet: string;
      templateGuideSheet: string;
      convertedSheet: string;
      overlaySheet: string;
      coordinates: string;
    };
    motionComparisonGifs: BakeResultFile[];
  };
}

interface RedDotMeasurementResult {
  pass: boolean;
  comparedFrames: number;
  missingFrames: number;
  failedFrames: number;
  maxAbsDx: number;
  maxAbsDy: number;
  files?: {
    uploadedActual: string;
    report: string;
    calibration?: string | null;
  };
  calibration?: {
    saved: boolean;
    corrections: number;
  };
  frames: Array<{
    key: string;
    pass: boolean;
    deltaActualMinusExpected: { dx: number; dy: number } | null;
    suggestedCorrectionToApplyToActual: { dx: number; dy: number } | null;
  }>;
}

function frameImageRef(frames: UiFrame[], parts: UiPart[], action: string, frameIndex: number): string | undefined {
  const partIds = new Set(parts.map((part) => part.id));
  return frames.find((frame) => frame.action === action && frame.frameIndex === frameIndex && (partIds.size === 0 || partIds.has(frame.partId)))?.imageRef;
}

function FramePreview({ parts, frames, title }: { parts: UiPart[]; frames: UiFrame[]; title: string }) {
  const actions = [...new Set(frames.map((frame) => frame.action))];
  return (
    <section className="panel">
      <h2><Eye size={18} /> {title}</h2>
      <div className="actions">
        {actions.map((action) => {
          const frameIndexes = [...new Set(frames.filter((frame) => frame.action === action).map((frame) => frame.frameIndex))].sort((a, b) => a - b);
          return (
            <div key={action} className={`action-card ${action.includes('E06') ? 'hidden-emotion' : ''}`}>
              <strong>{action}</strong>
              <div className="frames">
                {frameIndexes.map((frameIndex) => {
                  const imageRef = frameImageRef(frames, parts, action, frameIndex);
                  return (
                    <div key={frameIndex} className="frame" title={`${action} ${frameIndex}`}>
                      {imageRef ? (
                        <img className="avatar-frame" src={imageRef} alt={`${title} ${action} ${frameIndex}`} />
                      ) : (
                        parts.map((part, idx) => (
                          <span
                            key={part.id}
                            className="pixel"
                            style={{ background: part.color, left: 8 + idx * 9 + frameIndex * 3, top: 9 + idx * 8 }}
                          />
                        ))
                      )}
                      <small>{frameIndex}</small>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function App() {
  const [parts, setParts] = useState<UiPart[]>(sampleParts);
  const [frames, setFrames] = useState<UiFrame[]>(sampleFrames);
  const [mappings, setMappings] = useState(initialMappings);
  const [importJson, setImportJson] = useState('');
  const [importStatus, setImportStatus] = useState('sample fixture loaded');
  const [importLog, setImportLog] = useState<string[]>(['sample fixture loaded: no external request yet']);
  const [diagnostics, setDiagnostics] = useState<ImportDiagnostics>({});
  const [importedSource, setImportedSource] = useState<ImportedSourceState | null>(null);
  const [selectedPartIds, setSelectedPartIds] = useState<Set<string>>(new Set(sampleParts.map((part) => part.id)));
  const [previewZoom, setPreviewZoom] = useState(1.15);
  const [exportStatus, setExportStatus] = useState('not exported');
  const [bakeStatus, setBakeStatus] = useState('whole-avatar PSD not baked');
  const [bakeResult, setBakeResult] = useState<BakeResult | null>(null);
  const [currentBakeTarget, setCurrentBakeTarget] = useState<WholeAvatarBakeTarget | null>(null);
  const [adjustedRedDotFile, setAdjustedRedDotFile] = useState<File | null>(null);
  const [redDotMeasureStatus, setRedDotMeasureStatus] = useState('red-dot 비교 파일 없음');
  const [redDotMeasureResult, setRedDotMeasureResult] = useState<RedDotMeasurementResult | null>(null);
  const grouped = useMemo(() => mappings.filter((mapping) => mapping.mode !== 'part' || mapping.groupId), [mappings]);
  const validation = useMemo(() => computeUiValidation(parts, frames, mappings), [parts, frames, mappings]);
  const sourceImageUrl = diagnostics.renderImageUrl ?? frames.find((frame) => frame.imageRef)?.imageRef;
  const previewStyle = { '--preview-zoom': previewZoom } as React.CSSProperties;
  const previewZoomPercent = Math.round(previewZoom * 100);

  const update = (partId: string, patch: Partial<UiMapping>) => {
    setMappings((current) => current.map((mapping) => {
      if (mapping.partId !== partId) return mapping;
      const wholeAvatarPatch = patch.mode === 'whole-avatar' ? { groupId: 'whole-avatar' } : {};
      return { ...mapping, ...wholeAvatarPatch, ...patch, confirmed: patch.targetPartId || patch.mode || patch.groupId ? false : mapping.confirmed };
    }));
  };

  const confirmAll = () => setMappings((current) => current.map((mapping) => ({ ...mapping, groupId: mapping.mode === 'whole-avatar' ? 'whole-avatar' : mapping.mode === 'group' && !mapping.groupId ? 'bundle' : mapping.groupId, confirmed: Boolean(mapping.targetPartId) })));
  const bakeWholeAvatarToCape = () => setMappings((current) => current.map((mapping) => ({ ...mapping, targetPartId: 'cape', mode: 'whole-avatar', groupId: 'whole-avatar', confirmed: false })));
  const applySelectedParts = (source = importedSource, selected = selectedPartIds) => {
    if (!source) return;
    const nextParts = source.parts.filter((part) => selected.has(part.id));
    const selectedIds = new Set(nextParts.map((part) => part.id));
    const nextFrames = source.frames.filter((frame) => selectedIds.has(frame.partId));
    setParts(nextParts);
    setFrames(nextFrames);
    setMappings(nextParts.map((part) => ({ partId: part.id, targetPartId: defaultTargetForSourcePart(part), mode: 'part', groupId: '', confirmed: false })));
    setImportStatus(`applied ${nextParts.length}/${source.parts.length} selected parts / ${nextFrames.length} frames from ${source.source ?? 'json'}`);
    setExportStatus('not exported');
    setImportLog((current) => [
      `applied selected parts: ${nextParts.map((part) => `${part.id}${part.itemCode ? `:${part.itemCode}` : ''}`).join(', ') || '(none)'}`,
      `appliedFrames=${nextFrames.length} actionFrames=${new Set(nextFrames.map((frame) => `${frame.action}:${frame.frameIndex}`)).size}`,
      ...current,
    ]);
  };
  const selectOnlyEquipment = () => {
    if (!importedSource) return;
    const nextSelected = new Set(importedSource.parts.filter((part) => !['skin', 'face', 'hair'].includes(part.id)).map((part) => part.id));
    setSelectedPartIds(nextSelected);
    applySelectedParts(importedSource, nextSelected);
  };

  const importSource = async () => {
    if (!importJson.trim()) {
      setImportStatus(`imported ${parts.length} parts / ${frames.length} frames`);
      setImportLog((current) => [`blank import: kept current source (${parts.length} parts / ${frames.length} frames)`, ...current]);
      return;
    }
    try {
      const raw = importJson.trim();
      const nextLog = [`input received: ${raw.slice(0, 120)}${raw.length > 120 ? '…' : ''}`];
      const imported = raw.startsWith('http') || /^[A-Za-z0-9_-]{6,}$/.test(raw)
        ? await fetch(`/api/meaegi-share?share=${encodeURIComponent(raw)}`).then(async (response) => {
          nextLog.push(`GET /api/meaegi-share -> HTTP ${response.status}`);
          const body = await response.json();
          if (!response.ok) throw new Error(body.error ?? 'MeAegi share import failed');
          return body;
        })
        : JSON.parse(raw);
      if (!Array.isArray(imported.parts) || imported.parts.length === 0 || !Array.isArray(imported.frames)) throw new Error('parts/frames required');
      const nextParts: UiPart[] = imported.parts.map((part: Partial<UiPart> & { id: string }, index: number) => ({
        id: part.id,
        label: part.label ?? part.id,
        category: part.category ?? part.id,
        color: part.color ?? `hsl(${(index * 47) % 360} 85% 62%)`,
        itemCode: part.itemCode,
        iconRef: part.iconRef,
      }));
      const nextFrames: UiFrame[] = imported.frames.map((frame: UiFrame) => frame);
      const nextDiagnostics = { source: imported.source, share: imported.share, ...(imported.diagnostics ?? {}) };
      const nextSource = { source: imported.source, share: imported.share, parts: nextParts, frames: nextFrames, diagnostics: nextDiagnostics };
      setParts(nextParts);
      setFrames(nextFrames);
      setMappings(nextParts.map((part) => ({ partId: part.id, targetPartId: defaultTargetForSourcePart(part), mode: 'part', groupId: '', confirmed: false })));
      setImportedSource(nextSource);
      setSelectedPartIds(new Set(nextParts.map((part) => part.id)));
      setImportStatus(`imported ${nextParts.length} parts / ${nextFrames.length} frames from ${imported.source ?? 'json'}`);
      const uniqueImages = [...new Set(nextFrames.map((frame) => frame.imageRef).filter(Boolean))];
      setDiagnostics(nextDiagnostics);
      setImportLog([
        ...nextLog,
        `source=${imported.source ?? 'json'} share=${imported.share ?? '-'}`,
        `parts=${nextParts.length} partFrames=${nextFrames.length} actionFrames=${new Set(nextFrames.map((frame) => `${frame.action}:${frame.frameIndex}`)).size}`,
        `imageRefs=${uniqueImages.length}${uniqueImages[0] ? ` first=${uniqueImages[0]}` : ''}`,
        `iconRefs=${nextParts.filter((part) => part.iconRef).length}`,
        ...(Array.isArray(nextDiagnostics.hiddenEmotions)
          ? nextDiagnostics.hiddenEmotions.map((emotion: unknown) => {
            const record = emotion as { label?: string; emotionCode?: string; frameCount?: number };
            return `hiddenEmotion=${record.label ?? '-'} code=${record.emotionCode ?? '-'} frames=${record.frameCount ?? '-'}`;
          })
          : []),
        ...((nextDiagnostics.warnings as string[] | undefined) ?? []).map((warning) => `warning: ${warning}`),
      ]);
      setExportStatus('not exported');
    } catch (error) {
      setImportStatus(`import failed: ${(error as Error).message}`);
      setImportLog((current) => [`import failed: ${(error as Error).message}`, ...current]);
    }
  };

  const exportReviewManifest = () => {
    const bundle = {
      kind: 'msw-avatar-review-bundle-manifest',
      validation,
      mappings,
      frames,
      manualReviewRequired: true,
    };
    if (typeof document !== 'undefined') {
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'msw-avatar-review-bundle.json';
      anchor.click();
      URL.revokeObjectURL(url);
    }
    setExportStatus('review bundle manifest generated');
  };

  const convertWholeAvatarPsd = async (target: WholeAvatarBakeTarget) => {
    const share = importedSource?.share ?? importJson.trim();
    if (!share) {
      setBakeStatus('먼저 MeAegi 공유링크를 불러와야 합니다.');
      return;
    }
    setCurrentBakeTarget(target);
    setBakeStatus(`converting whole-avatar ${target} PSD and generating motion GIF comparisons...`);
    setBakeResult(null);
    try {
      const response = await fetch(`/api/bake-meaegi?share=${encodeURIComponent(share)}&target=${target}&format=json`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const body = await response.json() as BakeResult;
      setBakeResult(body);
      const bakedFrames = body.report.bakedFrames;
      const skippedFrames = body.report.skippedFrames;
      const frameCellDiffPixels = body.report.validation.frameCellDiffPixels;
      const frameCellMaxDelta = body.report.validation.frameCellMaxChannelDelta;
      const gifCount = body.report.validation.motionComparisonGifsGenerated;
      const placement = body.report.placement.placementValidation;
      setBakeStatus(`converted ${target}: baked=${bakedFrames}, skipped=${skippedFrames}, redDotPass=${placement?.pass ?? false}, redDotMax=${placement?.maxAbsDx ?? '-'},${placement?.maxAbsDy ?? '-'}, source-vs-PSD frameDiff=${frameCellDiffPixels}, maxDelta=${frameCellMaxDelta}, comparisonGIFs=${gifCount}`);
      setImportLog((current) => [
        `GET /api/bake-meaegi target=${target} -> HTTP ${response.status}`,
        `convertedOutput=${body.report.outputPsd}`,
        `redDotArtifacts=${JSON.stringify(body.files.redDots ?? {})}`,
        `redDotPlacementValidation=${JSON.stringify(body.report.placement.placementValidation ?? {})}`,
        `motionComparisonGifs=${gifCount} first=${body.files.motionComparisonGifs.find((artifact) => artifact.gif)?.gif ?? '-'}`,
        `wholeAvatarBake bakedFrames=${bakedFrames} skippedFrames=${skippedFrames}`,
        `wholeAvatarFrameValidation frameCellDiffPixels=${frameCellDiffPixels} frameCellMaxDelta=${frameCellMaxDelta}`,
        'warning: 위치 검증은 MeAegi input / Original template / Converted PSD 3열 GIF를 보고 확인해야 합니다.',
        ...current,
      ]);
    } catch (error) {
      const message = `whole-avatar bake failed: ${(error as Error).message}`;
      setBakeStatus(message);
      setImportLog((current) => [message, ...current]);
    }
  };

  const compareAdjustedRedDots = async () => {
    if (!bakeResult?.files.redDots?.templateGuideSheet) {
      setRedDotMeasureStatus('먼저 red-dot bake 결과를 생성해야 합니다.');
      return;
    }
    if (!adjustedRedDotFile) {
      setRedDotMeasureStatus('비교할 수동 보정 PNG/PSD 파일을 선택해야 합니다.');
      return;
    }
    const target = currentBakeTarget ?? bakeResult.report.target;
    const share = importedSource?.share ?? importJson.trim();
    if (!share) {
      setRedDotMeasureStatus('먼저 MeAegi 공유링크를 불러와야 합니다.');
      return;
    }
    setRedDotMeasureStatus(`comparing ${adjustedRedDotFile.name}, saving calibration, then rebaking ${target}...`);
    setRedDotMeasureResult(null);
    try {
      const response = await fetch(`/api/red-dot-measure?expected=${encodeURIComponent(bakeResult.files.redDots.templateGuideSheet)}&share=${encodeURIComponent(share)}&target=${target}`, {
        method: 'POST',
        headers: {
          'x-file-name': adjustedRedDotFile.name,
          'content-type': 'application/octet-stream',
        },
        body: adjustedRedDotFile,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setRedDotMeasureResult(body as RedDotMeasurementResult);
      setRedDotMeasureStatus(`calibration saved=${body.calibration?.saved ?? false}, corrections=${body.calibration?.corrections ?? 0}; rebaking ${target}...`);
      setImportLog((current) => [
        `POST /api/red-dot-measure -> HTTP ${response.status}`,
        `manualRedDotCompare pass=${body.pass} failed=${body.failedFrames} maxDx=${body.maxAbsDx} maxDy=${body.maxAbsDy}`,
        `manualCalibration saved=${body.calibration?.saved ?? false} corrections=${body.calibration?.corrections ?? 0} file=${body.files?.calibration ?? '-'}`,
        `manualRedDotReport=${body.files?.report ?? '-'}`,
        ...current,
      ]);
      if (!body.calibration?.saved) throw new Error('calibration was not saved; uploaded file is missing required 1px green dots.');
      await convertWholeAvatarPsd(target);
      setRedDotMeasureStatus(`calibration applied and ${target} rebaked. 새 PSD 다운로드 링크를 다시 눌러야 합니다.`);
    } catch (error) {
      const message = `red-dot compare failed: ${(error as Error).message}`;
      setRedDotMeasureStatus(message);
      setImportLog((current) => [message, ...current]);
    }
  };

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">MapleStory Worlds Avatar PSD Converter</p>
          <h1>MeAegi/이미지 코디를 MSW 템플릿 PSD로 변환</h1>
          <p>모든 소스 파트를 사용자가 MSW 대상 파트로 확인해야 export가 열립니다. 전체 감지 애니메이션 범위를 기준으로 preview/diff를 표시합니다.</p>
        </div>
        <button className="primary" disabled={!validation.pass} aria-label="export-review-bundle" onClick={exportReviewManifest}>
          <Download size={18} /> Preview Review Bundle
        </button>
      </header>

      <section className="grid two">
        <section className="panel">
          <h2><Wand2 size={18} /> Import</h2>
          <div className="dropzone">
            <strong>Public MeAegi URL / 이미지 프레임 업로드</strong>
            <textarea aria-label="source-json-import" value={importJson} onChange={(event) => setImportJson(event.target.value)} placeholder='{"parts":[{"id":"hair"}],"frames":[...]}' />
            <button onClick={importSource}>소스 JSON 불러오기</button>
            <p>{importStatus}</p>
            <p>Loaded source: {parts.length} parts, {validation.totalPartFrames} part-frames, {validation.totalFrames} action frames.</p>
            <p aria-label="export-status">{exportStatus}</p>
            {sourceImageUrl ? (
              <div className="source-image-card">
                <span>Current render image</span>
                <img className="source-image" src={sourceImageUrl} alt="Imported avatar render" />
              </div>
            ) : null}
          </div>
        </section>

        <section className="panel status">
          <h2>Validation</h2>
          {validation.pass ? <CheckCircle2 className="ok" /> : <XCircle className="bad" />}
          <p>{validation.pass ? '모든 파트 매핑 확인 완료. exact RGBA diff 0 기준 통과.' : '모든 파트를 target MSW part로 확인해야 합니다.'}</p>
          <dl>
            <div><dt>diff pixels</dt><dd>{validation.diffPixels}</dd></div>
            <div><dt>max delta</dt><dd>{validation.maxChannelDelta}</dd></div>
            <div><dt>animations</dt><dd>{validation.totalFrames} frame tracks</dd></div>
          </dl>
          <ul className="diagnostics">
            {validation.messages.map((message) => <li key={message}>{message}</li>)}
          </ul>
        </section>
      </section>

      <section className="panel">
        <h2><FileText size={18} /> Import / Conversion Log</h2>
        <pre className="log" aria-label="import-log">{importLog.join('\n')}</pre>
      </section>

      <section className="panel">
        <h2><Download size={18} /> Whole-avatar PSD Bake</h2>
        <p className="muted">변환 버튼은 바로 다운로드하지 않습니다. 먼저 PSD를 만들고, MeAegi input / Original template / Converted PSD 3열 모션 GIF를 생성해서 위치를 눈으로 검증하게 합니다.</p>
        <div className="toolbar">
          <button disabled={!importedSource?.share} onClick={() => convertWholeAvatarPsd('cape')}>Cape 변환 + GIF 비교 생성</button>
          <button disabled={!importedSource?.share} onClick={() => convertWholeAvatarPsd('cape-balloon')}>Cape Balloon 변환 + GIF 비교 생성</button>
          <button disabled={!importedSource?.share} onClick={() => convertWholeAvatarPsd('longcoat')}>Longcoat 변환 + GIF 비교 생성</button>
          <span aria-label="bake-status">{bakeStatus}</span>
        </div>
        {bakeResult ? (
          <div className="bake-result">
            {bakeResult.report.placement.placementValidation ? (
              <div className={`red-dot-summary ${bakeResult.report.placement.placementValidation.pass ? 'pass' : 'fail'}`}>
                <strong>Red-dot placement validation</strong>
                <span>pass={String(bakeResult.report.placement.placementValidation.pass)}</span>
                <span>maxDx={bakeResult.report.placement.placementValidation.maxAbsDx}</span>
                <span>maxDy={bakeResult.report.placement.placementValidation.maxAbsDy}</span>
                <span>failed={(bakeResult.report.placement.placementValidation.frames ?? []).filter((frame) => !frame.pass).length}</span>
              </div>
            ) : null}
            <div className="artifact-links">
              <a href={bakeResult.files.psd}>완성 PSD 다운로드</a>
              <a href={bakeResult.files.report} target="_blank" rel="noreferrer">validation-report.json</a>
              <a href={bakeResult.files.expectedSheet} target="_blank" rel="noreferrer">MeAegi source sheet</a>
              {bakeResult.files.templateGuideSheet ? <a href={bakeResult.files.templateGuideSheet} target="_blank" rel="noreferrer">Template guide sheet</a> : null}
              <a href={bakeResult.files.templateReferenceSheet} target="_blank" rel="noreferrer">Original template sheet</a>
              <a href={bakeResult.files.convertedEditableSheet} target="_blank" rel="noreferrer">Converted PSD sheet</a>
              <a href={bakeResult.files.diff} target="_blank" rel="noreferrer">source-vs-PSD diff</a>
            </div>
            {bakeResult.files.redDots ? (
              <section className="red-dot-panel">
                <h3>1px calibration dots</h3>
                <p className="muted">Template 기준점은 빨간 1px, converted/source 결과 기준점은 초록 1px입니다. 흰 테두리/큰 점 없이 좌표만 비교합니다.</p>
                <div className="artifact-links">
                  <a href={bakeResult.files.redDots.templateGuideSheet} target="_blank" rel="noreferrer">Template 빨간 1px 기준</a>
                  <a href={bakeResult.files.redDots.sourceBakedSheet} target="_blank" rel="noreferrer">Source 초록 1px 결과</a>
                  <a href={bakeResult.files.redDots.convertedSheet} target="_blank" rel="noreferrer">Converted 초록 1px 결과</a>
                  <a href={bakeResult.files.redDots.overlaySheet} target="_blank" rel="noreferrer">빨강/초록 overlay</a>
                  <a href={bakeResult.files.redDots.coordinates} target="_blank" rel="noreferrer">dot 좌표 JSON</a>
                </div>
                <div className="red-dot-previews">
                  <a href={bakeResult.files.redDots.templateGuideSheet} target="_blank" rel="noreferrer">
                    <span>Template 빨간 1px</span>
                    <img src={bakeResult.files.redDots.templateGuideSheet} alt="template red 1px dot sheet" />
                  </a>
                  <a href={bakeResult.files.redDots.convertedSheet} target="_blank" rel="noreferrer">
                    <span>Converted 초록 1px</span>
                    <img src={bakeResult.files.redDots.convertedSheet} alt="converted green 1px dot sheet" />
                  </a>
                  <a href={bakeResult.files.redDots.overlaySheet} target="_blank" rel="noreferrer">
                    <span>Overlay 빨강=template / 초록=converted</span>
                    <img src={bakeResult.files.redDots.overlaySheet} alt="red template and green converted dot overlay sheet" />
                  </a>
                </div>
                <div className="red-dot-upload">
                  <label>
                    수동 보정한 dot PNG/PSD 선택
                    <input
                      type="file"
                      accept=".png,.psd,image/png"
                      onChange={(event) => setAdjustedRedDotFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  <button disabled={!adjustedRedDotFile} onClick={compareAdjustedRedDots}>좌표 비교 + 보정 저장 + 재변환</button>
                  <span aria-label="red-dot-measure-status">{redDotMeasureStatus}</span>
                </div>
                {redDotMeasureResult ? (
                  <div className={`red-dot-summary ${redDotMeasureResult.pass ? 'pass' : 'fail'}`}>
                    <strong>Manual red-dot measurement</strong>
                    <span>pass={String(redDotMeasureResult.pass)}</span>
                    <span>failed={redDotMeasureResult.failedFrames}</span>
                    <span>missing={redDotMeasureResult.missingFrames}</span>
                    <span>maxDx={redDotMeasureResult.maxAbsDx}</span>
                    <span>maxDy={redDotMeasureResult.maxAbsDy}</span>
                    {redDotMeasureResult.files?.report ? <a href={redDotMeasureResult.files.report} target="_blank" rel="noreferrer">measurement report</a> : null}
                    <pre className="log">{redDotMeasureResult.frames.filter((frame) => !frame.pass).slice(0, 12).map((frame) => `${frame.key} delta=${JSON.stringify(frame.deltaActualMinusExpected)} apply=${JSON.stringify(frame.suggestedCorrectionToApplyToActual)}`).join('\n') || 'all red dots matched'}</pre>
                  </div>
                ) : null}
              </section>
            ) : null}
            <div className="comparison-gifs">
              {bakeResult.files.motionComparisonGifs.filter((artifact) => artifact.gif).slice(0, 8).map((artifact) => (
                <a key={artifact.action} className="gif-card" href={artifact.gif ?? '#'} target="_blank" rel="noreferrer">
                  <strong>{artifact.action}</strong>
                  <small>{artifact.frameCount} frames · source-vs-PSD diff {artifact.sourceVsConvertedDiffPixels}</small>
                  <img src={artifact.gif ?? ''} alt={`${artifact.action} comparison gif`} />
                </a>
              ))}
            </div>
            <p className="muted">{bakeResult.files.motionComparisonGifs.length}개 모션 비교 GIF 생성됨. 위에는 처음 8개만 표시합니다.</p>
          </div>
        ) : null}
      </section>

      {importedSource ? (
        <section className="panel">
          <h2><Layers size={18} /> 공유링크에서 불러올 파트 선택</h2>
          <p className="muted">메애기 초기화 후에도 남는 피부/성형/헤어 같은 기본 파트는 여기서 빼고 적용할 수 있습니다. 아래 체크된 파트만 매핑/PSD 변환 대상으로 들어갑니다.</p>
          <div className="part-picker-toolbar">
            <button onClick={() => {
              const next = new Set(importedSource.parts.map((part) => part.id));
              setSelectedPartIds(next);
              applySelectedParts(importedSource, next);
            }}>전체 선택 적용</button>
            <button onClick={selectOnlyEquipment}>장비만 선택 적용(피부/성형/헤어 제외)</button>
            <button onClick={() => {
              const next = new Set<string>();
              setSelectedPartIds(next);
              applySelectedParts(importedSource, next);
            }}>전체 해제 적용</button>
            <span>{selectedPartIds.size}/{importedSource.parts.length} selected</span>
          </div>
          <div className="part-picker">
            {importedSource.parts.map((part) => (
              <label key={part.id} className={`part-card ${selectedPartIds.has(part.id) ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={selectedPartIds.has(part.id)}
                  onChange={(event) => {
                    const next = new Set(selectedPartIds);
                    if (event.target.checked) next.add(part.id);
                    else next.delete(part.id);
                    setSelectedPartIds(next);
                  }}
                />
                <span className="part-thumb">
                  {part.iconRef ? <img src={part.iconRef} alt={`${part.label} icon`} onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <b style={{ color: part.color }}>■</b>}
                </span>
                <span>
                  <strong>{part.label}</strong>
                  <small>{part.category}{part.itemCode ? ` · ${part.itemCode}` : ''}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="toolbar">
            <button onClick={() => applySelectedParts()}>체크된 파트만 적용</button>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <h2><Layers size={18} /> Every-part Mapping</h2>
        <div className="table">
          <div className="row head"><span>Source part</span><span>Target MSW part</span><span>Mode</span><span>Group</span><span>Confirmed</span></div>
          {parts.map((part) => {
            const mapping = mappings.find((m) => m.partId === part.id)!;
            return (
              <div className="row" key={part.id}>
                <span className="part-label">
                  {part.iconRef ? <img src={part.iconRef} alt={`${part.label} icon`} onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : <b style={{ color: part.color }}>■</b>}
                  <span>{part.label}<small>{part.category}{part.itemCode ? ` · ${part.itemCode}` : ''}</small></span>
                </span>
                <select value={mapping.targetPartId} onChange={(event) => update(part.id, { targetPartId: event.target.value })} aria-label={`target-${part.id}`}>
                  {targetParts.map((target) => <option key={target} value={target}>{target}</option>)}
                </select>
                <select value={mapping.mode} onChange={(event) => update(part.id, { mode: event.target.value as MappingMode })} aria-label={`mode-${part.id}`}>
                  <option value="part">part</option>
                  <option value="group">group</option>
                  <option value="whole-avatar">whole-avatar</option>
                </select>
                <input value={mapping.groupId} placeholder="예: cape-bundle" onChange={(event) => update(part.id, { groupId: event.target.value })} />
                <button onClick={() => update(part.id, { confirmed: true })} className={mapping.confirmed ? 'confirmed' : ''}>{mapping.confirmed ? '확인됨' : '확인'}</button>
              </div>
            );
          })}
        </div>
        <div className="toolbar">
          <button onClick={confirmAll}>추천 매핑 전체 확인</button>
          <button onClick={bakeWholeAvatarToCape}>전체 아바타를 cape 한 파트로 굽기</button>
          <span>{grouped.length} grouped/whole-avatar mappings configured</span>
        </div>
      </section>

      <section className="grid two" style={previewStyle}>
        <section className="panel preview-controls-panel">
          <h2><Eye size={18} /> Preview Zoom</h2>
          <div className="preview-controls">
            <button onClick={() => setPreviewZoom((zoom) => Math.max(0.8, Number((zoom - 0.15).toFixed(2))))}>축소</button>
            <input
              aria-label="preview-zoom"
              type="range"
              min="0.8"
              max="2"
              step="0.05"
              value={previewZoom}
              onChange={(event) => setPreviewZoom(Number(event.target.value))}
            />
            <button onClick={() => setPreviewZoom((zoom) => Math.min(2, Number((zoom + 0.15).toFixed(2))))}>확대</button>
            <button onClick={() => setPreviewZoom(1.15)}>기본</button>
            <strong>{previewZoomPercent}%</strong>
          </div>
        </section>
      </section>

      <section className="grid two" style={previewStyle}>
        <FramePreview parts={parts} frames={frames} title="Source Animation Preview" />
        <FramePreview parts={parts.filter((part) => mappings.some((mapping) => mapping.partId === part.id && mapping.confirmed))} frames={frames} title="Converted PSD Preview" />
      </section>
    </main>
  );
}
