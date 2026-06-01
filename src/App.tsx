import React, { useMemo, useState } from 'react';
import { CheckCircle2, Download, Eye, FileText, Layers, Wand2, XCircle } from 'lucide-react';
import { computeUiValidation, defaultTargetForSourcePart, sampleFrames, sampleParts, targetParts, type UiFrame, type UiMappingInput, type UiPart } from './sample.js';

type MappingMode = 'part' | 'group' | 'whole-avatar';

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
