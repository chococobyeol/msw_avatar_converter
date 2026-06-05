import React, { useMemo, useRef, useState } from 'react';
import { CheckCircle2, Eye, FileText, HelpCircle, Layers, Wand2, XCircle } from 'lucide-react';
import { computeUiValidation, defaultTargetForSourcePart, sampleFrames, sampleParts, targetParts, type UiFrame, type UiMappingInput, type UiPart } from './sample.js';

type MappingMode = 'part' | 'group' | 'whole-avatar';
type WholeAvatarBakeTarget = typeof targetParts[number];

export function buildMappedPartBakePayload(share: string, mappings: UiMappingInput[]) {
  return {
    share,
    mappings: mappings
      .filter((mapping) => mapping.confirmed)
      .map((mapping) => ({
        partId: mapping.partId,
        targetPartId: mapping.targetPartId,
        mode: mapping.mode,
        groupId: mapping.groupId,
        confirmed: mapping.confirmed,
      })),
  };
}

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

const previewZoomMin = 0.5;
const previewZoomMax = 5;
const previewZoomDefault = 1.6;
const previewZoomStep = 0.05;
const previewZoomButtonStep = 0.25;

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

interface PsdBakeComparisonFile {
  action: string;
  frameCount: number;
  gif?: string | null;
  frameDir?: string;
  sourceVsConvertedDiffPixels: number;
  sourceVsTemplateDiffPixels: number;
}

interface PsdBakeReport {
  target: WholeAvatarBakeTarget | string;
  outputPsd: string;
  bakedFrames: number;
  skippedFrames: number;
  selectedPartIds?: string[];
  selection?: Record<string, unknown>;
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
    sparseTemplateSlotFallbacks?: Array<{ editPath: string; alphaPixels: number; source?: string; donorEditPath?: string | null; reason: string }>;
    rawHairZmapSource?: boolean;
    rawHairItemId?: number | null;
    rawHairPlacements?: Array<{ editPath: string; frameBook: string; frameIndex: number; effectName: string; missingImage?: boolean }>;
    [key: string]: unknown;
  };
  validation: {
    diffPixels?: number;
    maxChannelDelta?: number;
    frameCellDiffPixels: number;
    frameCellMaxChannelDelta: number;
    motionComparisonGifsGenerated?: number;
    editableLayersNonEmpty?: boolean;
    emptyEditableLayers?: string[];
    editableLayerAlphaPixels?: Array<{ path: string; alphaPixels: number }>;
    motionComparisons?: PsdBakeComparisonFile[];
  };
  warnings?: string[];
}

interface PsdBakeFiles {
  psd: string;
  psdDownloadName?: string;
  report: string;
  expectedSheet: string;
  templateGuideSheet?: string;
  templateReferenceSheet?: string;
  convertedEditableSheet: string;
  diff: string;
  motionComparisonGifs?: PsdBakeComparisonFile[];
}

interface MappedBakeResult {
  ok: boolean;
  share: string;
  runDir: string;
  exportedGroups: number;
  failedGroups: number;
  files?: { manifest: string };
  results: Array<{
    ok: boolean;
    group: {
      key: string;
      target: string;
      mode: MappingMode;
      groupId: string;
      partIds: string[];
    };
    error?: string;
    report?: PsdBakeReport;
    files?: PsdBakeFiles;
  }>;
}

function frameImageRef(frames: UiFrame[], parts: UiPart[], action: string, frameIndex: number): string | undefined {
  const partIds = new Set(parts.map((part) => part.id));
  return frames.find((frame) => frame.action === action && frame.frameIndex === frameIndex && (partIds.size === 0 || partIds.has(frame.partId)))?.imageRef;
}

function formatMappedPayloadSummary(requestedRows: ReturnType<typeof buildMappedPartBakePayload>['mappings']) {
  return `mappedPayload rows=${requestedRows.length} ${requestedRows.map((row) => `${row.partId}->${row.targetPartId}/${row.mode}${row.groupId ? `#${row.groupId}` : ''}`).join(' | ') || '(none)'}`;
}

function formatMappedBakeLog(result: MappedBakeResult, requestedRows: ReturnType<typeof buildMappedPartBakePayload>['mappings'], httpStatus: number): string[] {
  const lines = [
    `POST /api/bake-meaegi-mapped -> HTTP ${httpStatus}`,
    formatMappedPayloadSummary(requestedRows),
    `mappedExport ok=${result.ok} exported=${result.exportedGroups} failed=${result.failedGroups} runDir=${result.runDir} manifest=${result.files?.manifest ?? '-'}`,
  ];

  result.results.forEach((entry, index) => {
    const group = entry.group;
    lines.push(`mappedGroup[${index}] ${entry.ok ? 'ok' : 'fail'} key=${group.key} target=${group.target} mode=${group.mode} group=${group.groupId || '-'} parts=${group.partIds.join(',')}`);
    if (!entry.ok) {
      lines.push(`  error=${entry.error ?? '(unknown)'}`);
      return;
    }

    const report = entry.report;
    const files = entry.files;
    const validation = report?.validation;
    const placement = report?.placement;
    const redDot = placement?.placementValidation;
    const emptyLayers = validation?.emptyEditableLayers ?? [];
    const alphaSummary = (validation?.editableLayerAlphaPixels ?? [])
      .map((layer) => `${layer.path}:${layer.alphaPixels}`)
      .join(' | ');
    const fallbackSummary = (placement?.sparseTemplateSlotFallbacks ?? [])
      .map((fallback) => `${fallback.editPath}:${fallback.source ?? 'unknown'}:${fallback.alphaPixels}`)
      .join(' | ');
    const rawHairMissingSummary = (placement?.rawHairPlacements ?? [])
      .filter((rawHairPlacement) => rawHairPlacement.missingImage)
      .map((rawHairPlacement) => `${rawHairPlacement.editPath}:${rawHairPlacement.frameBook}[${rawHairPlacement.frameIndex}].${rawHairPlacement.effectName}`)
      .join(' | ');

    lines.push(`  psd=${report?.outputPsd ?? '-'} download=${files?.psdDownloadName ?? '-'}`);
    lines.push(`  artifacts report=${files?.report ?? '-'} source=${files?.expectedSheet ?? '-'} converted=${files?.convertedEditableSheet ?? '-'} diff=${files?.diff ?? '-'}`);
    lines.push(`  frames baked=${report?.bakedFrames ?? '-'} skipped=${report?.skippedFrames ?? '-'} selected=${(report?.selectedPartIds ?? group.partIds).join(',') || '-'}`);
    lines.push(`  validation diffPixels=${validation?.diffPixels ?? '-'} maxDelta=${validation?.maxChannelDelta ?? '-'} frameCellDiffPixels=${validation?.frameCellDiffPixels ?? '-'} frameCellMaxDelta=${validation?.frameCellMaxChannelDelta ?? '-'} editableNonEmpty=${validation?.editableLayersNonEmpty ?? '-'} empty=${emptyLayers.join(',') || '(none)'}`);
    if (alphaSummary) lines.push(`  editableAlpha=${alphaSummary}`);
    if (fallbackSummary) lines.push(`  compactSlotFallbacks=${fallbackSummary}`);
    if (rawHairMissingSummary) lines.push(`  rawHairMissingEffects=${rawHairMissingSummary}`);
    if (redDot) lines.push(`  placement pass=${redDot.pass} maxDx=${redDot.maxAbsDx} maxDy=${redDot.maxAbsDy} failed=${(redDot.frames ?? []).filter((frame) => !frame.pass).length}`);
    if (report?.warnings?.length) lines.push(`  warnings=${report.warnings.join(' | ')}`);
  });

  return lines;
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
  const [previewZoom, setPreviewZoom] = useState(previewZoomDefault);
  const [mappedBakeStatus, setMappedBakeStatus] = useState('mapped part PSD not baked');
  const [mappedBakeResult, setMappedBakeResult] = useState<MappedBakeResult | null>(null);
  const [showBakeCliHelp, setShowBakeCliHelp] = useState(false);
  const importInputRef = useRef<HTMLTextAreaElement | null>(null);
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

  const confirmAll = () => setMappings((current) => current.map((mapping) => ({
    ...mapping,
    groupId: mapping.mode === 'whole-avatar' ? 'whole-avatar' : mapping.mode === 'group' && !mapping.groupId ? 'bundle' : mapping.groupId,
    confirmed: Boolean(mapping.targetPartId),
  })));
  const bakeWholeAvatarToCape = () => {
    setMappings((current) => current.map((mapping) => ({
      ...mapping,
      targetPartId: 'cape',
      mode: 'whole-avatar',
      groupId: 'whole-avatar',
      confirmed: true,
    })));
    setMappedBakeResult(null);
    setMappedBakeStatus('전체 아바타를 cape 한 파트로 굽도록 매핑했습니다. 이제 PSD 시트 생성을 누르세요.');
  };
  const applySelectedParts = (source = importedSource, selected = selectedPartIds) => {
    if (!source) return;
    const nextParts = source.parts.filter((part) => selected.has(part.id));
    const selectedIds = new Set(nextParts.map((part) => part.id));
    const nextFrames = source.frames.filter((frame) => selectedIds.has(frame.partId));
    setParts(nextParts);
    setFrames(nextFrames);
    setMappings(nextParts.map((part) => ({ partId: part.id, targetPartId: defaultTargetForSourcePart(part), mode: 'part', groupId: '', confirmed: false })));
    setImportStatus(`applied ${nextParts.length}/${source.parts.length} selected parts / ${nextFrames.length} frames from ${source.source ?? 'json'}`);
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
    const rawInput = importJson.trim() || importInputRef.current?.value.trim() || '';
    if (!rawInput) {
      setImportStatus(`imported ${parts.length} parts / ${frames.length} frames`);
      setImportLog((current) => [`blank import: kept current source (${parts.length} parts / ${frames.length} frames)`, ...current]);
      return;
    }
    try {
      const raw = rawInput;
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
        `partsDetail=${nextParts.map((part) => `${part.id}${part.itemCode ? `:${part.itemCode}` : ''}${part.label ? `(${part.label})` : ''}`).join(' | ')}`,
        `imageRefs=${uniqueImages.length}${uniqueImages[0] ? ` first=${uniqueImages[0]}` : ''}`,
        `renderImageUrl=${nextDiagnostics.renderImageUrl ?? '-'}`,
        `iconRefs=${nextParts.filter((part) => part.iconRef).length}`,
        ...(Array.isArray(nextDiagnostics.hiddenEmotions)
          ? nextDiagnostics.hiddenEmotions.map((emotion: unknown) => {
            const record = emotion as { label?: string; emotionCode?: string; frameCount?: number };
            return `hiddenEmotion=${record.label ?? '-'} code=${record.emotionCode ?? '-'} frames=${record.frameCount ?? '-'}`;
          })
          : []),
        ...((nextDiagnostics.warnings as string[] | undefined) ?? []).map((warning) => `warning: ${warning}`),
      ]);
    } catch (error) {
      setImportStatus(`import failed: ${(error as Error).message}`);
      setImportLog((current) => [`import failed: ${(error as Error).message}`, ...current]);
    }
  };

  const convertMappedPartPsds = async () => {
    const share = importedSource?.share ?? importJson.trim();
    if (!share) {
      setMappedBakeStatus('먼저 MeAegi 공유링크를 불러와야 합니다.');
      return;
    }
    if (!validation.pass) {
      setMappedBakeStatus('모든 매핑을 확인해야 파트별 PSD export를 실행할 수 있습니다.');
      return;
    }
    const payload = buildMappedPartBakePayload(share, mappings);
    setMappedBakeStatus(`mapping groups converting: ${payload.mappings.length} confirmed row(s)...`);
    setMappedBakeResult(null);
    try {
      const response = await fetch('/api/bake-meaegi-mapped', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      const result = body as MappedBakeResult;
      setMappedBakeResult(result);
      setMappedBakeStatus(`mapped export done: exported=${result.exportedGroups}, failed=${result.failedGroups}`);
      setImportLog((current) => [...formatMappedBakeLog(result, payload.mappings, response.status), ...current]);
    } catch (error) {
      const message = `mapped part bake failed: ${(error as Error).message}`;
      setMappedBakeStatus(message);
      setImportLog((current) => [message, formatMappedPayloadSummary(payload.mappings), ...current]);
    }
  };

  return (
    <main>
      <header className="hero">
        <div>
          <p className="eyebrow">MapleStory Worlds Avatar PSD Converter</p>
          <h1>MeAegi/이미지 코디를 MSW 템플릿 PSD로 변환</h1>
          <p>파트별 매핑을 확인한 뒤 실제 PSD export 결과와 validation artifact를 로그 중심으로 확인합니다.</p>
        </div>
      </header>

      <section className="grid two">
        <section className="panel">
          <h2><Wand2 size={18} /> Import</h2>
          <div className="dropzone">
            <strong>Public MeAegi URL / 이미지 프레임 업로드</strong>
            <textarea
              ref={importInputRef}
              aria-label="source-json-import"
              value={importJson}
              onInput={(event) => setImportJson(event.currentTarget.value)}
              onChange={(event) => setImportJson(event.target.value)}
              placeholder='{"parts":[{"id":"hair"}],"frames":[...]}'
            />
            <button onClick={importSource}>소스 JSON 불러오기</button>
            <p>{importStatus}</p>
            <p>Loaded source: {parts.length} parts, {validation.totalPartFrames} part-frames, {validation.totalFrames} action frames.</p>
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
        <div className="section-title">
          <h2><FileText size={18} /> Import / Conversion Log</h2>
          <button
            type="button"
            className="icon-help"
            aria-label="whole-avatar-cli-help"
            aria-expanded={showBakeCliHelp}
            onClick={() => setShowBakeCliHelp((current) => !current)}
            title="콘솔 bake 도움말"
          >
            <HelpCircle size={18} />
          </button>
        </div>
        {showBakeCliHelp ? (
          <div className="help-card">
            <strong>콘솔 bake 도움말</strong>
            <p>UI에서는 파트별 mapped export만 사용합니다. 제거한 whole-avatar bake는 디버그/비교가 필요할 때 콘솔에서 실행합니다.</p>
            <code>npm run bake:meaegi -- --share SHARE --target cape --parts hair,cap</code>
            <small>예: <code>--target cap-c1 --parts face</code>, <code>--target cape --parts hair,cap</code>. 결과는 <code>artifacts/whole-avatar-bake/</code> 아래에 생성됩니다.</small>
          </div>
        ) : null}
        <pre className="log" aria-label="import-log">{importLog.join('\n')}</pre>
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
        <p className="muted">파트별 export는 기본 1:1 변환입니다. 같은 target에 여러 소스 파트를 묶는 중복 매핑은 cape/cape-balloon/longcoat 같은 케이프/전신 aggregate 타겟에서만 허용합니다. hair/cap/gloves/pants/shoes는 한 target당 한 소스 파트만 변환합니다.</p>
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
          <button disabled={!importedSource?.share || !validation.pass} onClick={convertMappedPartPsds}>확인된 매핑대로 PSD 시트 생성</button>
          <span aria-label="mapped-bake-status">{mappedBakeStatus}</span>
          <span>{grouped.length} grouped/whole-avatar mappings configured</span>
        </div>
        {mappedBakeResult ? (
          <div className="bake-result">
            <div className={`red-dot-summary ${mappedBakeResult.ok ? 'pass' : 'fail'}`}>
              <strong>Mapped PSD export</strong>
              <span>exported={mappedBakeResult.exportedGroups}</span>
              <span>failed={mappedBakeResult.failedGroups}</span>
              {mappedBakeResult.files?.manifest ? <a href={mappedBakeResult.files.manifest} target="_blank" rel="noreferrer">mapped-bake-manifest.json</a> : null}
            </div>
            <div className="mapped-results">
              {mappedBakeResult.results.map((entry) => (
                <div key={entry.group.key} className={`mapped-result ${entry.ok ? 'pass' : 'fail'}`}>
                  <strong>{entry.group.target} · {entry.group.mode} · {entry.group.groupId}</strong>
                  <small>parts={entry.group.partIds.join(', ')}</small>
                  {entry.ok && entry.files ? (
                    <div className="artifact-links">
                      <a href={entry.files.psd} download={entry.files.psdDownloadName ?? true}>PSD 다운로드</a>
                      <a href={entry.files.report} target="_blank" rel="noreferrer">report</a>
                      <a href={entry.files.expectedSheet} target="_blank" rel="noreferrer">source sheet</a>
                      <a href={entry.files.convertedEditableSheet} target="_blank" rel="noreferrer">converted sheet</a>
                      <a href={entry.files.diff} target="_blank" rel="noreferrer">diff</a>
                    </div>
                  ) : <em>{entry.error}</em>}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="grid two" style={previewStyle}>
        <section className="panel preview-controls-panel">
          <h2><Eye size={18} /> Preview Zoom</h2>
          <div className="preview-controls">
            <button onClick={() => setPreviewZoom((zoom) => Math.max(previewZoomMin, Number((zoom - previewZoomButtonStep).toFixed(2))))}>축소</button>
            <input
              aria-label="preview-zoom"
              type="range"
              min={previewZoomMin}
              max={previewZoomMax}
              step={previewZoomStep}
              value={previewZoom}
              onInput={(event) => setPreviewZoom(Number(event.currentTarget.value))}
              onChange={(event) => setPreviewZoom(Number(event.target.value))}
            />
            <button onClick={() => setPreviewZoom((zoom) => Math.min(previewZoomMax, Number((zoom + previewZoomButtonStep).toFixed(2))))}>확대</button>
            <button onClick={() => setPreviewZoom(previewZoomDefault)}>기본</button>
            <strong>{previewZoomPercent}%</strong>
          </div>
        </section>
      </section>

      <section className="grid" style={previewStyle}>
        <FramePreview parts={parts} frames={frames} title="Source Animation Preview" />
      </section>
    </main>
  );
}
