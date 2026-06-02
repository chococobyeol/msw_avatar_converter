import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { render, fireEvent } from '@testing-library/react';
import { App, buildWholeAvatarBakeUrl } from '../../src/App.js';
import { buildMeaegiShareImport, extractMeaegiShareId, parseMeaegiFlight } from '../../src/meaegiShare.js';
import { computeSampleValidation, sampleParts } from '../../src/sample.js';

function installDom(dom: JSDOM) {
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  globalThis.HTMLSelectElement = dom.window.HTMLSelectElement;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
}

test('UI blocks export until every source part is confirmed', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  installDom(dom);
  globalThis.URL.createObjectURL = () => 'blob:review';
  globalThis.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};

  const ui = render(<App />);
  const exportButton = ui.getByLabelText('export-review-bundle') as HTMLButtonElement;
  assert.equal(exportButton.disabled, true);
  fireEvent.click(ui.getByText('추천 매핑 전체 확인'));
  assert.equal(exportButton.disabled, false);
  assert.ok(ui.getAllByText(/exact RGBA diff 0/).length >= 1);
  const textarea = ui.getByLabelText('source-json-import') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: '{"parts":[{"id":"hair"}],"frames":[{}]}' } });
  fireEvent.click(ui.getByText('소스 JSON 불러오기'));
  assert.match((await ui.findByText(/imported /)).textContent ?? '', /frames/);
  fireEvent.click(exportButton);
  assert.equal(ui.getByLabelText('export-status').textContent, 'review bundle manifest generated');
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

test('whole-avatar bake URL carries current selected source parts', () => {
  const url = new URL(buildWholeAvatarBakeUrl('SHARE123', 'cape', ['hair', 'weapon']), 'http://localhost');
  assert.equal(url.pathname, '/api/bake-meaegi');
  assert.equal(url.searchParams.get('share'), 'SHARE123');
  assert.equal(url.searchParams.get('target'), 'cape');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('parts'), 'hair,weapon');
});

test('sample validation rejects invalid aggregate mapping semantics', () => {
  assert.equal(computeSampleValidation([]).pass, false);
  assert.equal(computeSampleValidation(sampleParts.map((part) => ({ partId: part.id, targetPartId: 'hair', mode: 'group', groupId: 'solo', confirmed: true }))).pass, true);
  assert.equal(computeSampleValidation([{ partId: sampleParts[0].id, targetPartId: 'hair', mode: 'group', groupId: 'solo', confirmed: true }]).pass, false);
  assert.equal(computeSampleValidation(sampleParts.map((part) => ({ partId: part.id, targetPartId: 'longcoat', mode: 'whole-avatar', groupId: 'whole-avatar', confirmed: true }))).pass, true);
  assert.equal(computeSampleValidation(sampleParts.map((part, index) => ({ partId: part.id, targetPartId: index === 0 ? 'longcoat' : 'cape', mode: 'whole-avatar', groupId: 'whole-avatar', confirmed: true }))).pass, false);
  assert.equal(computeSampleValidation([
    { partId: sampleParts[0].id, targetPartId: 'longcoat', mode: 'whole-avatar', groupId: 'whole-avatar', confirmed: true },
    ...sampleParts.slice(1).map((part) => ({ partId: part.id, targetPartId: 'hair', mode: 'part' as const, groupId: '', confirmed: true })),
  ]).pass, false);
});
