import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { render, fireEvent } from '@testing-library/react';
import { App, buildMappedPartBakePayload } from '../../src/App.js';
import { buildMeaegiShareImport, extractMeaegiShareId, parseMeaegiFlight } from '../../src/meaegiShare.js';
import { computeSampleValidation, sampleParts } from '../../src/sample.js';

function installDom(dom: JSDOM) {
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  descriptor?.set?.call(element, value);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
}

test('UI gates mapped export and removes obsolete review/whole-preview controls', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  installDom(dom);

  const ui = render(<App />);
  assert.equal(ui.queryByLabelText('export-review-bundle'), null);
  assert.equal(ui.queryByText(/Preview Review Bundle/), null);
  assert.equal(ui.queryByText(/Whole-avatar PSD Bake/), null);
  assert.equal(ui.queryByText(/Converted PSD Preview/), null);
  assert.ok(ui.getByText('전체 아바타를 cape 한 파트로 굽기'));
  assert.equal(ui.queryByText(/콘솔 bake 도움말/), null);
  fireEvent.click(ui.getByLabelText('whole-avatar-cli-help'));
  assert.ok(ui.getByText(/콘솔 bake 도움말/));
  assert.match(ui.getByText(/npm run bake:meaegi/).textContent ?? '', /--target cape/);

  const mappedButton = ui.getByText('확인된 매핑대로 PSD 시트 생성') as HTMLButtonElement;
  assert.equal(mappedButton.disabled, true);
  fireEvent.click(ui.getByText('추천 매핑 전체 확인'));
  assert.equal(mappedButton.disabled, true, 'mapped export still needs an imported MeAegi share');
  assert.ok(ui.getAllByText(/exact RGBA diff 0/).length >= 1);

  const textarea = ui.getByLabelText('source-json-import') as HTMLTextAreaElement;
  setNativeValue(textarea, '{"source":"meaegi-share","share":"SHARE123","parts":[{"id":"hair","itemCode":71180}],"frames":[{"action":"기본(한손)","frameIndex":0,"partId":"hair","imageRef":"/frame.png"}],"diagnostics":{"renderImageUrl":"/render.png"}}');
  fireEvent.click(ui.getByText('소스 JSON 불러오기'));
  assert.match((await ui.findByText(/imported /)).textContent ?? '', /frames/);
  assert.match(ui.getByLabelText('import-log').textContent ?? '', /partsDetail=hair:71180/);
  assert.equal(mappedButton.disabled, true, 'newly imported mappings must be confirmed again');
  fireEvent.click(ui.getByText('전체 아바타를 cape 한 파트로 굽기'));
  assert.match(ui.getByLabelText('mapped-bake-status').textContent ?? '', /전체 아바타를 cape/);
  assert.equal(mappedButton.disabled, false, 'whole-avatar cape shortcut confirms all imported mappings');
});

test('mapped export log includes validation artifacts and compact fallback detail', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  installDom(dom);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    assert.equal(String(input), '/api/bake-meaegi-mapped');
    return new Response(JSON.stringify({
      ok: true,
      share: 'SHARE123',
      runDir: 'artifacts/mapped/run-1',
      exportedGroups: 1,
      failedGroups: 0,
      files: { manifest: '/artifacts/mapped/run-1/mapped-bake-manifest.json' },
      results: [{
        ok: true,
        group: { key: 'cap-a1-part-hair', target: 'cap-a1', mode: 'part', groupId: 'hair', partIds: ['hair'] },
        report: {
          target: 'cap-a1',
          outputPsd: 'artifacts/mapped/run-1/Avatar_Cap_A1.psd',
          bakedFrames: 2,
          skippedFrames: 111,
          selectedPartIds: ['hair'],
          placement: {
            sparseTemplateSlotFallbacks: [{ editPath: 'case2.back/edithere:cap_backCap_92', alphaPixels: 139, source: 'converted-donor', donorEditPath: 'case1.front/edithere:cap_cap_34', reason: 'empty slot filled from converted donor' }],
            placementValidation: { pass: true, maxAbsDx: 0, maxAbsDy: 0, frames: [] },
          },
          validation: {
            diffPixels: 0,
            maxChannelDelta: 0,
            frameCellDiffPixels: 0,
            frameCellMaxChannelDelta: 0,
            editableLayersNonEmpty: true,
            emptyEditableLayers: [],
            editableLayerAlphaPixels: [{ path: 'case1.front/edithere:cap_cap_34', alphaPixels: 139 }],
          },
          warnings: ['manual MSW upload still required'],
        },
        files: {
          psd: '/artifacts/mapped/run-1/Avatar_Cap_A1.psd',
          psdDownloadName: 'Avatar_Cap_A1_SHARE123.psd',
          report: '/artifacts/mapped/run-1/validation-report.json',
          expectedSheet: '/artifacts/mapped/run-1/expected-sheet.png',
          convertedEditableSheet: '/artifacts/mapped/run-1/converted-editable-sheet.png',
          diff: '/artifacts/mapped/run-1/diff.png',
          motionComparisonGifs: [],
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const ui = render(<App />);
    const textarea = ui.getByLabelText('source-json-import') as HTMLTextAreaElement;
    setNativeValue(textarea, '{"source":"meaegi-share","share":"SHARE123","parts":[{"id":"hair","itemCode":71180}],"frames":[{"action":"기본(한손)","frameIndex":0,"partId":"hair","imageRef":"/frame.png"}]}');
    fireEvent.click(ui.getByText('소스 JSON 불러오기'));
    await ui.findByText(/imported /);
    fireEvent.click(ui.getByText('추천 매핑 전체 확인'));
    fireEvent.click(ui.getByText('확인된 매핑대로 PSD 시트 생성'));
    await ui.findByText(/mapped export done/);
    const logText = ui.getByLabelText('import-log').textContent ?? '';
    assert.match(logText, /mappedPayload rows=1 hair->hair\/part/);
    assert.match(logText, /artifacts report=\/artifacts\/mapped\/run-1\/validation-report.json/);
    assert.match(logText, /validation diffPixels=0 maxDelta=0 frameCellDiffPixels=0 frameCellMaxDelta=0 editableNonEmpty=true empty=\(none\)/);
    assert.match(logText, /compactSlotFallbacks=case2\.back\/edithere:cap_backCap_92:converted-donor:139/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preview zoom supports 50 to 500 percent range', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  installDom(dom);

  const ui = render(<App />);
  const zoom = ui.getByLabelText('preview-zoom') as HTMLInputElement;
  assert.equal(zoom.min, '0.5');
  assert.equal(zoom.max, '5');
  assert.equal(ui.getByText('160%').textContent, '160%');
  setNativeValue(zoom, '5');
  assert.equal(ui.getByText('500%').textContent, '500%');
  setNativeValue(zoom, '0.5');
  assert.equal(ui.getByText('50%').textContent, '50%');
});

test('MeAegi share adapter extracts public share payloads into source parts and frames', () => {
  assert.equal(extractMeaegiShareId('https://meaegi.com/dressing-room?share=5gcTvkPmcFn5'), '5gcTvkPmcFn5');
  assert.equal(extractMeaegiShareId('5gcTvkPmcFn5'), '5gcTvkPmcFn5');
  const avatar = parseMeaegiFlight('0:["$@1",["id",null]]\n2:T4,HASH1:{"itemCode":{"hair":71180,"weapon":1703878},"itemPrism":{"hair":{"baseColor":1}},"hash":"$2"}');
  const imported = buildMeaegiShareImport('5gcTvkPmcFn5', avatar);
  assert.equal(imported.source, 'meaegi-share');
  assert.equal(imported.avatar.hash, 'HASH');
  assert.deepEqual(imported.parts.map((part) => part.id), ['hair', 'weapon']);
  assert.equal(imported.diagnostics.totalPoseActionFrames, 113);
  assert.equal(imported.diagnostics.totalHiddenEmotionFrames, 0);
  assert.equal(imported.diagnostics.totalActionFrames, 113);
  assert.equal(imported.frames.length, 226);
  assert.equal(imported.frames.every((frame) => frame.imageRef?.startsWith('https://open.api.nexon.com/static/maplestory/character/look/HASH?')), true);
  assert.equal(imported.frames.some((frame) => String(frame.action) === '눈깜빡임(E06)' || frame.imageRef?.includes('emotion=E06')), false);
  assert.equal(imported.diagnostics.hiddenEmotions[0].includedInDefaultImport, false);
  assert.equal(imported.parts.find((part) => part.id === 'hair')?.iconRef, 'https://storage.meaegi.com/storage/images/dressing-room/hair/00071180.png');
  assert.equal(imported.parts.find((part) => part.id === 'weapon')?.iconRef?.startsWith('https://avatar.maplestory.nexon.com/ItemIcon/'), true);
});

test('MeAegi share adapter normalizes full Nexon look URLs in hash payloads', () => {
  const lookUrl = 'https://open.api.nexon.com/static/maplestory/character/look/LOOKHASH?wmotion=W00';
  const imported = buildMeaegiShareImport('share-with-url-hash', {
    itemCode: { hair: 44950 },
    hash: lookUrl,
  });
  assert.equal(imported.frames[0]?.imageRef, 'https://open.api.nexon.com/static/maplestory/character/look/LOOKHASH?wmotion=W00&width=180&height=180&x=90&y=140&action=A00.0');
  assert.equal(imported.frames[0]?.imageRef?.includes('/look/https://'), false);
  assert.equal(imported.diagnostics.renderImageUrl, 'https://open.api.nexon.com/static/maplestory/Character/LOOKHASH.png?wmotion=W00');
});

test('mapped part bake payload sends only confirmed user mappings', () => {
  const payload = buildMappedPartBakePayload('SHARE123', [
    { partId: 'hair', targetPartId: 'cape', mode: 'part', groupId: '', confirmed: true },
    { partId: 'weapon', targetPartId: 'gloves', mode: 'group', groupId: 'weapon-bundle', confirmed: true },
    { partId: 'skin', targetPartId: 'longcoat', mode: 'part', groupId: '', confirmed: false },
  ]);
  assert.equal(payload.share, 'SHARE123');
  assert.deepEqual(payload.mappings.map((mapping) => mapping.partId), ['hair', 'weapon']);
  assert.equal(payload.mappings[1].targetPartId, 'gloves');
  assert.equal(payload.mappings[1].groupId, 'weapon-bundle');
});

test('sample validation rejects invalid aggregate mapping semantics', () => {
  assert.equal(computeSampleValidation([]).pass, false);
  assert.equal(computeSampleValidation(sampleParts.map((part) => ({ partId: part.id, targetPartId: 'cape', mode: 'group', groupId: 'solo', confirmed: true }))).pass, true);
  assert.equal(computeSampleValidation(sampleParts.map((part) => ({ partId: part.id, targetPartId: 'hair', mode: 'group', groupId: 'solo', confirmed: true }))).pass, false);
  assert.match(computeSampleValidation(sampleParts.map((part) => ({ partId: part.id, targetPartId: 'hair', mode: 'group', groupId: 'solo', confirmed: true }))).messages.join(' '), /cape\/cape-balloon\/longcoat/);
  assert.equal(computeSampleValidation([{ partId: sampleParts[0].id, targetPartId: 'cape', mode: 'group', groupId: 'solo', confirmed: true }]).pass, false);
  assert.equal(computeSampleValidation(sampleParts.map((part) => ({ partId: part.id, targetPartId: 'longcoat', mode: 'whole-avatar', groupId: 'whole-avatar', confirmed: true }))).pass, true);
  assert.equal(computeSampleValidation(sampleParts.map((part) => ({ partId: part.id, targetPartId: 'gloves', mode: 'whole-avatar', groupId: 'whole-avatar', confirmed: true }))).pass, false);
  assert.equal(computeSampleValidation(sampleParts.map((part, index) => ({ partId: part.id, targetPartId: index === 0 ? 'longcoat' : 'cape', mode: 'whole-avatar', groupId: 'whole-avatar', confirmed: true }))).pass, false);
  assert.equal(computeSampleValidation([
    { partId: sampleParts[0].id, targetPartId: 'longcoat', mode: 'whole-avatar', groupId: 'whole-avatar', confirmed: true },
    ...sampleParts.slice(1).map((part) => ({ partId: part.id, targetPartId: 'hair', mode: 'part' as const, groupId: '', confirmed: true })),
  ]).pass, false);
});
