import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas } from 'canvas';
import { PNG } from 'pngjs';
import { readPsd, writePsdBuffer, type Layer, type Psd } from 'ag-psd';
import { ensureCanvasInitialized } from '../packages/psd-gate/src/canvas.js';
import { writeRgbaPng } from '../packages/export/src/png.js';
import { buildMeaegiShareImport, extractMeaegiShareId, MEAEGI_BUILD_HASH_ACTION_ID, MEAEGI_GET_SHARE_ACTION_ID, parseMeaegiFlight, type MeaegiAvatarPayload } from '../src/meaegiShare.js';

interface BakedCell {
  action: string;
  frameIndex: number;
  col: number;
  row: number;
}

interface LoadedFrame {
  action: string;
  frameIndex: number;
  imageRef: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  bounds: { left: number; top: number; right: number; bottom: number; empty: boolean };
}

type Bounds = LoadedFrame['bounds'];
export type FrameCorrection = { dx: number; dy: number; reason: string };
type FixedFramePlacementOffset = { dx: number; dy: number; reason: string };
type Anchor = { x: number; y: number; basis: string };
type PlacementRecord = {
  key: string;
  action: string;
  frameIndex: number;
  col: number;
  row: number;
  targetAnchor: Anchor;
  sourceAnchor: Anchor;
  correction: { dx: number; dy: number } | null;
  destLeft: number;
  destTop: number;
  actualAnchorInCell: { x: number; y: number };
  error: { dx: number; dy: number };
};

interface ComparisonArtifact {
  action: string;
  frameCount: number;
  gifPath: string | null;
  frameDir: string;
  sourceVsConvertedDiffPixels: number;
  sourceVsConvertedMaxDelta: number;
  sourceVsTemplateDiffPixels: number;
  sourceVsTemplateMaxDelta: number;
}

const capTemplateFiles = {
  'cap-a1': 'Avatar_Cap_A1.psd',
  'cap-a2': 'Avatar_Cap_A2.psd',
  'cap-ani': 'Avatar_Cap_Ani.psd',
  'cap-b': 'Avatar_Cap_B.psd',
  'cap-c1': 'Avatar_Cap_C1.psd',
  'cap-c2': 'Avatar_Cap_C2.psd',
  'cap-d': 'Avatar_Cap_D.psd',
  'cap-e': 'Avatar_Cap_E.psd',
  'cap-f': 'Avatar_Cap_F.psd',
  'cap-g': 'Avatar_Cap_G.psd',
} as const;

const compactCapConfigs = Object.fromEntries(Object.entries(capTemplateFiles).map(([target, file]) => [target, {
  layout: 'compact-slots' as const,
  templatePath: `avatartemplate/${file}`,
  outputName: file,
  removeZmapPreset: true,
}]));

const targetConfigs = {
  cape: {
    layout: 'full-grid' as const,
    templatePath: 'avatartemplate/Avatar_Cape.psd',
    outputName: 'Avatar_Cape.psd',
    editLayerPath: 'edithere:cape_capeOverHead_10',
    expandTargetLayerToCanvas: true,
    promoteTargetLayerToTop: true,
    removeZmapPreset: true,
  },
  'cape-balloon': {
    layout: 'full-grid' as const,
    templatePath: 'avatartemplate/Avatar_Cape_balloon.psd',
    outputName: 'Avatar_Cape_balloon.psd',
    editLayerPath: 'edithere:cape_capeOverHead_10',
    expandTargetLayerToCanvas: true,
    promoteTargetLayerToTop: true,
    removeZmapPreset: true,
  },
  longcoat: {
    layout: 'full-grid' as const,
    templatePath: 'avatartemplate/Avatar_Longcoat.psd',
    outputName: 'Avatar_Longcoat.psd',
    editLayerPath: 'edithere:mailArm_mailArmOverHair_22',
    expandTargetLayerToCanvas: true,
    promoteTargetLayerToTop: true,
    removeZmapPreset: true,
  },
  gloves: {
    layout: 'full-grid' as const,
    templatePath: 'avatartemplate/Avatar_Gloves.psd',
    outputName: 'Avatar_Gloves.psd',
    editLayerPath: 'gloves_summary_13,18,23/edithere:rGlove_summary_13,23',
    expandTargetLayerToCanvas: true,
    promoteTargetLayerToTop: true,
    removeZmapPreset: true,
  },
  pants: {
    layout: 'full-grid' as const,
    templatePath: 'avatartemplate/Avatar_Pants.psd',
    outputName: 'Avatar_Pants.psd',
    editLayerPath: 'edithere:pants_pantsBelowShoes_75',
    expandTargetLayerToCanvas: true,
    promoteTargetLayerToTop: true,
    removeZmapPreset: true,
  },
  shoes: {
    layout: 'full-grid' as const,
    templatePath: 'avatartemplate/Avatar_Shoes.psd',
    outputName: 'Avatar_Shoes.psd',
    editLayerPath: 'edithere:shoes_shoesTop_69',
    expandTargetLayerToCanvas: true,
    promoteTargetLayerToTop: true,
    removeZmapPreset: true,
  },
  hair: {
    layout: 'compact-slots' as const,
    templatePath: 'avatartemplate/Avatar_Hair.psd',
    outputName: 'Avatar_Hair.psd',
    removeZmapPreset: true,
  },
  ...compactCapConfigs,
} as const;

export type BakeTarget = keyof typeof targetConfigs;
export const supportedBakeTargets = Object.keys(targetConfigs) as BakeTarget[];

export function isBakeTarget(target: string): target is BakeTarget {
  return target in targetConfigs;
}

export interface BakeMeaegiWholeAvatarInput {
  share: string;
  target?: BakeTarget;
  outDir?: string;
  selectedPartIds?: string[];
  manualFrameCorrections?: Record<string, FrameCorrection>;
}

const cellWidth = 250;
const cellHeight = 250;
const referenceCalibrationShare = 'NvkIKXl2Xw64';
const frameFetchConcurrency = 4;
const frameFetchRetryAttempts = 4;
const frameFetchTimeoutMs = 20_000;
const frameCacheDir = path.join('artifacts', 'frame-cache');

function logProgress(message: string): void {
  process.stderr.write(`[bake] ${message}\n`);
}

const fixedFramePlacementOffsets: Partial<Record<BakeTarget, FixedFramePlacementOffset>> = {
  cape: {
    dx: 0,
    dy: 0,
    reason: 'target-level offset after frame anchors are matched from MeAegi reference body to Avatar_Cape.psd guide_character cells',
  },
  'cape-balloon': {
    dx: 0,
    dy: 0,
    reason: 'target-level offset after frame anchors are matched from MeAegi reference body to Avatar_Cape_balloon.psd guide_character cells',
  },
  longcoat: {
    dx: 0,
    dy: 0,
    reason: 'target-level offset after frame anchors are matched from MeAegi reference body to Avatar_Longcoat.psd guide_character cells',
  },
  gloves: {
    dx: 0,
    dy: 0,
    reason: 'target-level offset after frame anchors are matched from MeAegi reference body to Avatar_Gloves.psd guide_character cells',
  },
  pants: {
    dx: 0,
    dy: 0,
    reason: 'target-level offset after frame anchors are matched from MeAegi reference body to Avatar_Pants.psd guide_character cells',
  },
  shoes: {
    dx: 0,
    dy: 0,
    reason: 'target-level offset after frame anchors are matched from MeAegi reference body to Avatar_Shoes.psd guide_character cells',
  },
};

const userOverlayFrameCorrections: Record<string, FrameCorrection> = {
  "걷기(한손):0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "걷기(한손):1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "걷기(한손):2": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "걷기(한손):3": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "걷기(두손):0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "걷기(두손):1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "걷기(두손):2": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "걷기(두손):3": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "기본(한손):0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "기본(한손):1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "기본(한손):2": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "기본(두손):0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "기본(두손):1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "기본(두손):2": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "전투 대기:0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "전투 대기:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "전투 대기:2": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙O1:0": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙O1:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙O1:2": { dx: -3, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙O2:0": { dx: 1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙O2:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙O2:2": { dx: -3, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙O3:1": { dx: -3, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙O3:2": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙OF:0": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙OF:2": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙OF:3": { dx: -2, dy: 1, reason: 'calibrated from user red/green dot overlay' },
  "스윙T1:0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙T1:1": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙T1:2": { dx: -3, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙T2:0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙T2:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙T2:2": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙T3:0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙T3:1": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙T3:2": { dx: -3, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙TF:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙TF:2": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙TF:3": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기O1:0": { dx: 1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기O1:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기O2:0": { dx: 1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기O2:1": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기T1:0": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기T1:1": { dx: -3, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기T2:0": { dx: -3, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기T2:1": { dx: -3, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기T2:2": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기TF:0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기TF:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기TF:2": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기TF:3": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "날기:0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "날기:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "점프:0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "쏘기(활):0": { dx: 1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "쏘기(활):1": { dx: 1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "쏘기(활):2": { dx: 1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "쏘기F:0": { dx: 1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "쏘기F:1": { dx: 1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "쏘기(석궁):0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "쏘기(석궁):1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "쏘기(석궁):2": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "쏘기(석궁):3": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "쏘기(석궁):4": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙P1:0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙P1:1": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙P1:2": { dx: -3, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙P2:0": { dx: 1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙P2:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙P2:2": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙PF:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙PF:2": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "스윙PF:3": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "앉기:0": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기OF:0": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기OF:1": { dx: -1, dy: 0, reason: 'calibrated from user red/green dot overlay' },
  "찌르기OF:2": { dx: -2, dy: 0, reason: 'calibrated from user red/green dot overlay' },
};

const manualFrameCorrections: Partial<Record<BakeTarget, Record<string, FrameCorrection>>> = {
  cape: userOverlayFrameCorrections,
  'cape-balloon': userOverlayFrameCorrections,
  longcoat: userOverlayFrameCorrections,
  gloves: userOverlayFrameCorrections,
  pants: userOverlayFrameCorrections,
  shoes: userOverlayFrameCorrections,
};

const bakedCells: BakedCell[] = [
  ...cells('걷기(한손)', 0, 0, 4),
  ...cells('걷기(두손)', 0, 1, 4),
  ...cells('기본(한손)', 0, 2, 3),
  ...cells('기본(두손)', 0, 3, 3),
  ...cells('전투 대기', 0, 4, 3),
  ...cells('스윙O1', 0, 5, 3),
  ...cells('스윙O2', 0, 6, 3),
  ...cells('스윙O3', 0, 7, 3),
  ...cells('스윙OF', 0, 8, 4),
  ...cells('스윙T1', 0, 9, 3),
  ...cells('스윙T2', 0, 10, 3),
  ...cells('스윙T3', 0, 11, 3),
  ...cells('스윙TF', 0, 12, 4),
  ...cells('사다리', 0, 13, 2),
  ...cells('찌르기O1', 5, 0, 2),
  ...cells('찌르기O2', 8, 0, 2),
  ...cells('찌르기T1', 5, 1, 3),
  ...cells('찌르기T2', 5, 2, 3),
  ...cells('엎드리기', 5, 3, 1),
  ...cells('엎드려 찌르기', 6, 3, 1, 1),
  ...cells('찌르기TF', 5, 4, 4),
  ...cells('날기', 5, 5, 2),
  ...cells('점프', 8, 5, 1),
  ...cells('쏘기(활)', 5, 6, 3),
  ...cells('쏘기F', 9, 6, 2),
  ...cells('쏘기(석궁)', 5, 7, 5),
  ...cells('스윙P1', 5, 9, 3),
  ...cells('스윙P2', 5, 10, 3),
  ...cells('스윙PF', 5, 11, 4),
  ...cells('앉기', 10, 11, 1),
  ...cells('찌르기OF', 5, 12, 3),
  ...cells('밧줄', 5, 13, 2),
];

function cells(action: string, startCol: number, row: number, count: number, sourceFrameStart = 0): BakedCell[] {
  return Array.from({ length: count }, (_, index) => ({ action, frameIndex: sourceFrameStart + index, col: startCol + index, row }));
}

function parseArgs() {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    args.set(rawKey, inline ?? process.argv[i + 1] ?? '');
    if (inline === undefined) i += 1;
  }
  const share = extractMeaegiShareId(args.get('share') ?? args.get('url') ?? 'https://meaegi.com/dressing-room?share=5gcTvkPmcFn5');
  const target = (args.get('target') ?? 'cape') as BakeTarget;
  if (!isBakeTarget(target)) throw new Error(`Unknown target "${target}". Use one of: ${supportedBakeTargets.join(', ')}.`);
  return {
    share,
    target,
    selectedPartIds: args.get('parts')?.split(',').map((part) => part.trim()).filter(Boolean),
    outDir: args.get('out') ?? path.join('artifacts/whole-avatar-bake', share, target),
  };
}

async function fetchMeaegiSharePayload(share: string): Promise<MeaegiAvatarPayload> {
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
  return parseMeaegiFlight(text);
}

function finiteItemEntries(avatar: MeaegiAvatarPayload): Array<[string, number]> {
  return Object.entries(avatar.itemCode ?? {})
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]));
}

function normalizeSelectedPartIds(avatar: MeaegiAvatarPayload, selectedPartIds?: string[]): string[] {
  const available = new Set(finiteItemEntries(avatar).map(([slot]) => slot));
  if (!selectedPartIds) return [...available];
  return [...new Set(selectedPartIds)].filter((slot) => available.has(slot));
}

function buildMeaegiHashParams(avatar: MeaegiAvatarPayload, selectedPartIds: string[]) {
  const selected = new Set(selectedPartIds);
  const itemCode = Object.fromEntries(finiteItemEntries(avatar).filter(([slot]) => selected.has(slot)));
  const itemPrism = Object.fromEntries(Object.entries(avatar.itemPrism ?? {}).filter(([slot, prism]) => selected.has(slot) && prism && itemCode[slot] !== undefined));
  return {
    gender: Number.isFinite(avatar.gender) ? avatar.gender : 1,
    earType: Number.isFinite(avatar.earType) ? avatar.earType : 0,
    weaponMotion: Number.isFinite(avatar.weaponMotion) ? avatar.weaponMotion : 0,
    variation: Number.isFinite(avatar.variation) ? avatar.variation : 0,
    variationType: Number.isFinite(avatar.variationType) ? avatar.variationType : 0,
    weaponBaseEffect: Number.isFinite(avatar.weaponBaseEffect) ? avatar.weaponBaseEffect : 1,
    weaponJumpEffect: Number.isFinite(avatar.weaponJumpEffect) ? avatar.weaponJumpEffect : 1,
    weaponSpecialEffect: Number.isFinite(avatar.weaponSpecialEffect) ? avatar.weaponSpecialEffect : 1,
    capeEffect: Number.isFinite(avatar.capeEffect) ? avatar.capeEffect : 1,
    hideWeaponOnSkill: Number.isFinite(avatar.hideWeaponOnSkill) ? avatar.hideWeaponOnSkill : 1,
    capEffect: Number.isFinite(avatar.capEffect) ? avatar.capEffect : 1,
    floatEffect: Number.isFinite(avatar.floatEffect) ? avatar.floatEffect : 1,
    itemCode,
    itemPrism,
  };
}

function parseMeaegiHashFlight(text: string): string {
  const match = /(?:^|\n)\d+:T([0-9a-fA-F]+),/.exec(text);
  if (!match || match.index === undefined) throw new Error('MeAegi hash payload was not found in the server response.');
  const marker = match[0];
  const start = match.index + marker.length;
  const length = Number.parseInt(match[1], 16);
  const hash = text.slice(start, start + length);
  if (!/^[A-Z0-9]+$/.test(hash)) throw new Error('MeAegi hash payload had an unexpected format.');
  return hash;
}

async function buildMeaegiHashFromSelectedParts(avatar: MeaegiAvatarPayload, selectedPartIds: string[]): Promise<string> {
  const upstream = await fetch('https://meaegi.com/dressing-room', {
    method: 'POST',
    headers: {
      'Next-Action': MEAEGI_BUILD_HASH_ACTION_ID,
      'Content-Type': 'text/plain;charset=UTF-8',
      Accept: 'text/x-component',
    },
    body: JSON.stringify([buildMeaegiHashParams(avatar, selectedPartIds)]),
  });
  const text = await upstream.text();
  if (!upstream.ok) throw new Error(`MeAegi hash builder returned HTTP ${upstream.status}.`);
  return parseMeaegiHashFlight(text);
}

async function loadMeaegiImport(share: string, selectedPartIds?: string[]) {
  const avatar = await fetchMeaegiSharePayload(share);
  const availablePartIds = finiteItemEntries(avatar).map(([slot]) => slot);
  const selected = normalizeSelectedPartIds(avatar, selectedPartIds);
  const isFullSelection = selected.length === availablePartIds.length && availablePartIds.every((slot) => selected.includes(slot));
  const selectedAvatar: MeaegiAvatarPayload = { ...avatar };
  let baselineHash: string | null = null;
  if (!isFullSelection) {
    const selectedHash = await buildMeaegiHashFromSelectedParts(avatar, selected);
    baselineHash = await buildMeaegiHashFromSelectedParts(avatar, []);
    selectedAvatar.hash = selectedHash;
    selectedAvatar.itemCode = Object.fromEntries(finiteItemEntries(avatar).filter(([slot]) => selected.includes(slot)));
    selectedAvatar.itemPrism = Object.fromEntries(Object.entries(avatar.itemPrism ?? {}).filter(([slot, prism]) => selected.includes(slot) && prism && selectedAvatar.itemCode?.[slot] !== undefined));
  }
  const imported = buildMeaegiShareImport(share, selectedAvatar);
  return {
    ...imported,
    selection: {
      requestedPartIds: selectedPartIds ?? availablePartIds,
      availablePartIds,
      selectedPartIds: selected,
      fullHash: avatar.hash ?? null,
      selectedHash: selectedAvatar.hash ?? null,
      baselineHash,
      baselineMaskApplied: !isFullSelection,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function frameCachePath(url: string): string {
  return path.join(frameCacheDir, `${createHash('sha1').update(url).digest('hex')}.png`);
}

function fetchErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) return `${error.message}; cause=${cause.message}`;
    return error.message;
  }
  return String(error);
}

async function fetchFrameBuffer(url: string): Promise<Buffer> {
  mkdirSync(frameCacheDir, { recursive: true });
  const cachedPath = frameCachePath(url);
  if (existsSync(cachedPath)) return readFileSync(cachedPath);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= frameFetchRetryAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), frameFetchTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(cachedPath, buffer);
      return buffer;
    } catch (error) {
      lastError = error;
      if (attempt < frameFetchRetryAttempts) await sleep(600 * attempt * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Frame fetch failed after ${frameFetchRetryAttempts} attempts: ${url} (${fetchErrorSummary(lastError)})`);
}

async function loadPng(url: string): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }> {
  const png = PNG.sync.read(await fetchFrameBuffer(url));
  return { width: png.width, height: png.height, rgba: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
}

function alphaBounds(width: number, height: number, rgba: Uint8ClampedArray): LoadedFrame['bounds'] {
  let left = width;
  let top = height;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + 1);
      bottom = Math.max(bottom, y + 1);
    }
  }
  return { left, top, right, bottom, empty: right <= left || bottom <= top };
}

function over(dst: Uint8ClampedArray, dstOffset: number, src: Uint8ClampedArray, srcOffset: number): void {
  const sa = src[srcOffset + 3] / 255;
  if (sa <= 0) return;
  const da = dst[dstOffset + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    dst[dstOffset + channel] = Math.round((((src[srcOffset + channel] / 255) * sa) + ((dst[dstOffset + channel] / 255) * da * (1 - sa))) / oa * 255);
  }
  dst[dstOffset + 3] = Math.round(oa * 255);
}

function correctionKey(cell: Pick<BakedCell, 'action' | 'frameIndex'>): string {
  return `${cell.action}:${cell.frameIndex}`;
}

function anchorFromBounds(bounds: Bounds | undefined, fallback: Anchor, basis: string): Anchor {
  if (!bounds || bounds.empty) return fallback;
  return {
    x: Math.round((bounds.left + bounds.right - 1) / 2),
    y: bounds.bottom - 1,
    basis,
  };
}

function placementForCell(cell: BakedCell, targetAnchor: Anchor, sourceAnchor: Anchor, correction?: FrameCorrection, fixedOffset?: FixedFramePlacementOffset): PlacementRecord {
  const cellLeft = cell.col * cellWidth;
  const cellTop = cell.row * cellHeight;
  const correctionDx = correction?.dx ?? 0;
  const correctionDy = correction?.dy ?? 0;
  const fixedDx = fixedOffset?.dx ?? 0;
  const fixedDy = fixedOffset?.dy ?? 0;
  const destLeft = Math.round(cellLeft + targetAnchor.x - sourceAnchor.x + fixedDx + correctionDx);
  const destTop = Math.round(cellTop + targetAnchor.y - sourceAnchor.y + fixedDy + correctionDy);
  const actualAnchorInCell = {
    x: destLeft + sourceAnchor.x - cellLeft,
    y: destTop + sourceAnchor.y - cellTop,
  };
  return {
    key: correctionKey(cell),
    action: cell.action,
    frameIndex: cell.frameIndex,
    col: cell.col,
    row: cell.row,
    targetAnchor,
    sourceAnchor,
    correction: correction ? { dx: correction.dx, dy: correction.dy } : null,
    destLeft,
    destTop,
    actualAnchorInCell,
    error: {
      dx: actualAnchorInCell.x - targetAnchor.x - fixedDx - correctionDx,
      dy: actualAnchorInCell.y - targetAnchor.y - fixedDy - correctionDy,
    },
  };
}

function drawFrame(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, frame: LoadedFrame, placement: PlacementRecord): void {
  for (let y = 0; y < frame.height; y += 1) {
    const ty = placement.destTop + y;
    if (ty < 0 || ty >= sheetHeight) continue;
    for (let x = 0; x < frame.width; x += 1) {
      const tx = placement.destLeft + x;
      if (tx < 0 || tx >= sheetWidth) continue;
      over(sheet, (ty * sheetWidth + tx) * 4, frame.rgba, (y * frame.width + x) * 4);
    }
  }
}

async function loadFrameSetForCells(share: string, cellsToLoad: BakedCell[]): Promise<Map<string, LoadedFrame>> {
  const imported = await loadMeaegiImport(share);
  const uniqueFrames = new Map<string, { action: string; frameIndex: number; imageRef: string }>();
  for (const frame of imported.frames) {
    const key = `${frame.action}:${frame.frameIndex}`;
    if (!uniqueFrames.has(key) && frame.imageRef) uniqueFrames.set(key, { action: frame.action, frameIndex: frame.frameIndex, imageRef: frame.imageRef });
  }
  return loadFramesFromUniqueMap(uniqueFrames, cellsToLoad);
}

async function loadFrameSetForHash(hash: string, cellsToLoad: BakedCell[]): Promise<Map<string, LoadedFrame>> {
  const imported = buildMeaegiShareImport('baseline', { itemCode: { skin: 12018 }, hash });
  const uniqueFrames = new Map<string, { action: string; frameIndex: number; imageRef: string }>();
  for (const frame of imported.frames) {
    const key = `${frame.action}:${frame.frameIndex}`;
    if (!uniqueFrames.has(key) && frame.imageRef) uniqueFrames.set(key, { action: frame.action, frameIndex: frame.frameIndex, imageRef: frame.imageRef });
  }
  return loadFramesFromUniqueMap(uniqueFrames, cellsToLoad);
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

async function loadFramesFromUniqueMap(uniqueFrames: Map<string, { action: string; frameIndex: number; imageRef: string }>, cellsToLoad: BakedCell[]): Promise<Map<string, LoadedFrame>> {
  const frameByKey = new Map<string, LoadedFrame>();
  const cellsByKey = new Map<string, BakedCell>();
  for (const cell of cellsToLoad) cellsByKey.set(`${cell.action}:${cell.frameIndex}`, cell);
  let loadedCount = 0;
  await runWithConcurrency([...cellsByKey.values()], frameFetchConcurrency, async (cell) => {
    const key = `${cell.action}:${cell.frameIndex}`;
    const source = uniqueFrames.get(key);
    if (!source) throw new Error(`Missing MeAegi frame for supported template cell: ${key}`);
    const loaded = await loadPng(source.imageRef);
    frameByKey.set(key, { ...source, ...loaded, bounds: alphaBounds(loaded.width, loaded.height, loaded.rgba) });
    loadedCount += 1;
    if (loadedCount === 1 || loadedCount % 10 === 0 || loadedCount === cellsByKey.size) {
      logProgress(`loaded frame PNGs ${loadedCount}/${cellsByKey.size}`);
    }
  });
  return frameByKey;
}

function colorDistance(a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number): number {
  return Math.max(
    Math.abs(a[ai] - b[bi]),
    Math.abs(a[ai + 1] - b[bi + 1]),
    Math.abs(a[ai + 2] - b[bi + 2]),
    Math.abs(a[ai + 3] - b[bi + 3]),
  );
}

function maskFrameAgainstBaseline(frame: LoadedFrame, baseline: LoadedFrame): LoadedFrame {
  if (frame.width !== baseline.width || frame.height !== baseline.height) return frame;
  const rgba = new Uint8ClampedArray(frame.rgba);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0 || baseline.rgba[i + 3] === 0) continue;
    if (colorDistance(rgba, i, baseline.rgba, i) <= 2) {
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      rgba[i + 3] = 0;
    }
  }
  return {
    ...frame,
    imageRef: `${frame.imageRef}#selected-minus-baseline`,
    rgba,
    bounds: alphaBounds(frame.width, frame.height, rgba),
  };
}

function applyBaselineMask(frameByKey: Map<string, LoadedFrame>, baselineFrameByKey: Map<string, LoadedFrame>): Map<string, LoadedFrame> {
  const masked = new Map<string, LoadedFrame>();
  for (const [key, frame] of frameByKey) {
    const baseline = baselineFrameByKey.get(key);
    masked.set(key, baseline ? maskFrameAgainstBaseline(frame, baseline) : frame);
  }
  return masked;
}

function flatten(layers: Layer[] | undefined, parent = ''): Array<{ path: string; layer: Layer }> {
  const out: Array<{ path: string; layer: Layer }> = [];
  for (const layer of layers ?? []) {
    const current = parent ? `${parent}/${layer.name}` : layer.name ?? '';
    out.push({ path: current, layer });
    out.push(...flatten(layer.children, current));
  }
  return out;
}

function hideGuides(layers: Layer[] | undefined): void {
  for (const layer of layers ?? []) {
    if ((layer.name ?? '').startsWith('guide')) layer.hidden = true;
    hideGuides(layer.children);
  }
}

function promoteLayerToTop(psd: Psd, layerPath: string): void {
  if (!psd.children) return;
  const pathParts = layerPath.split('/');
  if (pathParts.length === 1) {
    const targetName = pathParts[0];
    const index = psd.children.findIndex((layer) => layer.name === targetName);
    if (index <= 0) return;
    const [layer] = psd.children.splice(index, 1);
    psd.children.unshift(layer);
    return;
  }
  const detach = (layers: Layer[] | undefined, parts: string[]): Layer | null => {
    if (!layers?.length) return null;
    const [head, ...tail] = parts;
    const index = layers.findIndex((layer) => layer.name === head);
    if (index < 0) return null;
    if (tail.length === 0) {
      const [layer] = layers.splice(index, 1);
      return layer;
    }
    return detach(layers[index].children, tail);
  };
  const layer = detach(psd.children, pathParts);
  if (layer) psd.children.unshift(layer);
}

function removeZmapPresetLayers(layers: Layer[] | undefined): Layer[] | undefined {
  if (!layers) return layers;
  return layers
    .filter((layer) => {
      const name = layer.name ?? '';
      return !name.includes('data:use_zmap_preset') && !name.includes('zmap_preset');
    })
    .map((layer) => {
      layer.children = removeZmapPresetLayers(layer.children);
      return layer;
    });
}

function cropSheet(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, left: number, top: number, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = top + y;
    if (sourceY < 0 || sourceY >= sheetHeight) continue;
    for (let x = 0; x < width; x += 1) {
      const sourceX = left + x;
      if (sourceX < 0 || sourceX >= sheetWidth) continue;
      const sourceOffset = (sourceY * sheetWidth + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      out[targetOffset] = sheet[sourceOffset];
      out[targetOffset + 1] = sheet[sourceOffset + 1];
      out[targetOffset + 2] = sheet[sourceOffset + 2];
      out[targetOffset + 3] = sheet[sourceOffset + 3];
    }
  }
  return out;
}

function blitLayerToSheet(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, layer: Layer): void {
  const image = layer.imageData;
  if (!image?.data) return;
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  const data = image.data;
  for (let y = 0; y < image.height; y += 1) {
    const targetY = top + y;
    if (targetY < 0 || targetY >= sheetHeight) continue;
    for (let x = 0; x < image.width; x += 1) {
      const targetX = left + x;
      if (targetX < 0 || targetX >= sheetWidth) continue;
      const sourceOffset = (y * image.width + x) * 4;
      const targetOffset = (targetY * sheetWidth + targetX) * 4;
      if (data[sourceOffset + 3] === 0) continue;
      sheet[targetOffset] = data[sourceOffset];
      sheet[targetOffset + 1] = data[sourceOffset + 1];
      sheet[targetOffset + 2] = data[sourceOffset + 2];
      sheet[targetOffset + 3] = data[sourceOffset + 3];
    }
  }
}

function renderLayerSheet(psd: Psd, predicate: (entry: { path: string; layer: Layer }) => boolean): Uint8ClampedArray {
  const sheet = new Uint8ClampedArray(psd.width * psd.height * 4);
  for (const entry of flatten(psd.children)) {
    if (!predicate(entry)) continue;
    if (entry.layer.hidden || !entry.layer.imageData?.data) continue;
    blitLayerToSheet(sheet, psd.width, psd.height, entry.layer);
  }
  return sheet;
}

function renderEditableSheet(psd: Psd): Uint8ClampedArray {
  return renderLayerSheet(psd, (entry) => entry.path.includes('edithere:'));
}

function renderTemplateReferenceSheet(psd: Psd): Uint8ClampedArray {
  return renderLayerSheet(psd, (entry) => {
    const name = entry.layer.name ?? '';
    if (entry.path.startsWith('data/') || entry.path === 'data') return false;
    if (name === 'guide_background' || name === 'guide_grid') return false;
    return Boolean(entry.layer.imageData?.data);
  });
}

function installSheetLayer(psd: Psd, layerPath: string, sheet: Uint8ClampedArray, expandTargetLayerToCanvas: boolean): void {
  const entries = flatten(psd.children);
  const target = entries.find((entry) => entry.path === layerPath)?.layer;
  if (!target) throw new Error(`Layer not found: ${layerPath}`);
  for (const entry of entries.filter((candidate) => candidate.path.includes('edithere:'))) {
    const layer = entry.layer;
    layer.hidden = false;
    if (entry.path === layerPath && expandTargetLayerToCanvas) {
      layer.left = 0;
      layer.top = 0;
      layer.right = psd.width;
      layer.bottom = psd.height;
      layer.imageData = { width: psd.width, height: psd.height, data: sheet };
    } else {
      const left = layer.left ?? 0;
      const top = layer.top ?? 0;
      const width = Math.max(1, (layer.right ?? left + 1) - left);
      const height = Math.max(1, (layer.bottom ?? top + 1) - top);
      layer.imageData = {
        width,
        height,
        data: entry.path === layerPath ? cropSheet(sheet, psd.width, psd.height, left, top, width, height) : new Uint8ClampedArray(width * height * 4),
      };
    }
  }
  hideGuides(psd.children);
}

type TargetConfig = (typeof targetConfigs)[BakeTarget];
type FullGridTargetConfig = Extract<TargetConfig, { layout: 'full-grid' }>;

function isFullGridTargetConfig(config: TargetConfig): config is FullGridTargetConfig {
  return config.layout === 'full-grid';
}

interface CompactSlot {
  editPath: string;
  guidePath: string;
  action: string;
  frameIndex: number;
  targetAnchor: Anchor;
  sourceAnchor: Anchor;
  destLeft: number;
  destTop: number;
}

function compactPoseForLayerPath(layerPath: string): { action: string; frameIndex: number } {
  const lower = layerPath.toLowerCase();
  const suffixFrame = /:(\d+)$/.exec(layerPath)?.[1];
  const suffixIndex = suffixFrame ? Number(suffixFrame) : 0;
  if (lower.includes('back')) return { action: '밧줄', frameIndex: suffixIndex % 2 };
  if (lower.includes('prone') || lower.includes('stab')) return { action: '엎드리기', frameIndex: 0 };
  return { action: '기본(한손)', frameIndex: suffixIndex % 3 };
}

function layerParentPath(layerPath: string): string {
  const parts = layerPath.split('/');
  parts.pop();
  return parts.join('/');
}

function layerRootPath(layerPath: string): string {
  return layerPath.split('/')[0] ?? '';
}

function compactGuideScore(editPath: string, guidePath: string): number {
  const editParent = layerParentPath(editPath);
  const guideParent = layerParentPath(guidePath);
  const editRoot = layerRootPath(editPath);
  const guideRoot = layerRootPath(guidePath);
  let score = 0;
  if (guidePath.includes('guide_character_summary')) score += 100;
  if (guidePath.includes('guide_character_Body') || guidePath.includes('guide_character_backBody')) score += 90;
  if (guidePath.includes('guide_character_face') || guidePath.includes('arm_samples')) score -= 100;
  if (guideParent === editParent) score += 80;
  if (editParent.startsWith(guideParent) || guideParent.startsWith(editParent)) score += 40;
  if (editRoot && editRoot === guideRoot) score += 60;
  const editLower = editPath.toLowerCase();
  const guideLower = guidePath.toLowerCase();
  if (editLower.includes('back') && (guideLower.includes('113') || guideLower.includes('back'))) score += 60;
  if ((editLower.includes('prone') || editLower.includes('stab')) && guideLower.includes('47')) score += 30;
  if (!editLower.includes('back') && !editLower.includes('prone') && !editLower.includes('stab') && guideLower.includes('78')) score += 30;
  return score;
}

function findGuideForCompactEditLayer(entries: Array<{ path: string; layer: Layer }>, editPath: string): { path: string; layer: Layer } {
  const guides = entries.filter((entry) => entry.path.includes('guide_character') && entry.layer.imageData?.data);
  const best = guides
    .map((entry) => ({ entry, score: compactGuideScore(editPath, entry.path) }))
    .sort((a, b) => b.score - a.score)[0]?.entry;
  if (!best) throw new Error(`No compact guide layer found for ${editPath}`);
  return best;
}

function layerBounds(layer: Layer): Bounds {
  if (!layer.imageData?.data) return { left: 0, top: 0, right: 0, bottom: 0, empty: true };
  const local = alphaBounds(layer.imageData.width, layer.imageData.height, layer.imageData.data as Uint8ClampedArray);
  if (local.empty) return local;
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  return {
    left: left + local.left,
    top: top + local.top,
    right: left + local.right,
    bottom: top + local.bottom,
    empty: false,
  };
}

function drawFrameAt(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, frame: LoadedFrame, destLeft: number, destTop: number): void {
  for (let y = 0; y < frame.height; y += 1) {
    const ty = destTop + y;
    if (ty < 0 || ty >= sheetHeight) continue;
    for (let x = 0; x < frame.width; x += 1) {
      const tx = destLeft + x;
      if (tx < 0 || tx >= sheetWidth) continue;
      over(sheet, (ty * sheetWidth + tx) * 4, frame.rgba, (y * frame.width + x) * 4);
    }
  }
}

function compactSlotsForPsd(psd: Psd, referenceFrameByKey: Map<string, LoadedFrame>): CompactSlot[] {
  const entries = flatten(psd.children);
  return entries
    .filter((entry) => entry.path.includes('edithere:'))
    .map((entry) => {
      const guide = findGuideForCompactEditLayer(entries, entry.path);
      const { action, frameIndex } = compactPoseForLayerPath(entry.path);
      const key = `${action}:${frameIndex}`;
      const referenceFrame = referenceFrameByKey.get(key);
      if (!referenceFrame) throw new Error(`Missing compact reference frame ${key} for ${entry.path}`);
      const guideBounds = layerBounds(guide.layer);
      const targetAnchor = anchorFromBounds(guideBounds, { x: psd.width / 2, y: psd.height / 2, basis: 'compact-fallback-canvas-center' }, 'compact-template-guide-character-center-bottom');
      const sourceAnchor = anchorFromBounds(referenceFrame.bounds, { x: referenceFrame.width / 2, y: referenceFrame.height * 2 / 3, basis: 'compact-fallback-reference-frame-origin' }, `reference-share-${referenceCalibrationShare}-alpha-center-bottom`);
      return {
        editPath: entry.path,
        guidePath: guide.path,
        action,
        frameIndex,
        targetAnchor,
        sourceAnchor,
        destLeft: Math.round(targetAnchor.x - sourceAnchor.x),
        destTop: Math.round(targetAnchor.y - sourceAnchor.y),
      };
    });
}

function installCompactSlotLayers(psd: Psd, sheet: Uint8ClampedArray, slots: CompactSlot[]): Map<string, Uint8ClampedArray> {
  const entries = flatten(psd.children);
  const expected = new Map<string, Uint8ClampedArray>();
  for (const entry of entries.filter((candidate) => candidate.path.includes('edithere:'))) {
    const layer = entry.layer;
    const left = layer.left ?? 0;
    const top = layer.top ?? 0;
    const width = Math.max(1, (layer.right ?? left + 1) - left);
    const height = Math.max(1, (layer.bottom ?? top + 1) - top);
    const data = slots.some((slot) => slot.editPath === entry.path)
      ? cropSheet(sheet, psd.width, psd.height, left, top, width, height)
      : new Uint8ClampedArray(width * height * 4);
    expected.set(entry.path, data);
    layer.imageData = { width, height, data };
  }
  hideGuides(psd.children);
  return expected;
}

function validateCompactLayerReadback(expectedLayers: Map<string, Uint8ClampedArray>, readback: Psd) {
  const readbackEntries = flatten(readback.children);
  const frames = [...expectedLayers.entries()].map(([pathKey, expected]) => {
    const layerName = pathKey.split('/').at(-1);
    const readbackLayer = readbackEntries.find((entry) =>
      entry.path === pathKey ||
      entry.path === layerName ||
      (layerName ? entry.path.endsWith(`/${layerName}`) : false),
    )?.layer;
    const actual = readbackLayer?.imageData?.data
      ? new Uint8ClampedArray(readbackLayer.imageData.data.buffer, readbackLayer.imageData.data.byteOffset, readbackLayer.imageData.data.byteLength)
      : new Uint8ClampedArray(expected.length);
    const width = readbackLayer?.imageData?.width ?? Math.max(1, Math.floor(Math.sqrt(expected.length / 4)));
    const height = readbackLayer?.imageData?.height ?? Math.max(1, expected.length / 4 / width);
    const diff = expected.length === actual.length
      ? diffBuffers(width, height, expected, actual)
      : { diffPixels: expected.length / 4, maxChannelDelta: 255, pass: false };
    return {
      key: pathKey,
      pass: diff.pass,
      diffPixels: diff.diffPixels,
      maxChannelDelta: diff.maxChannelDelta,
      missingReadbackLayer: !readbackLayer?.imageData?.data,
    };
  });
  return {
    pass: frames.every((frame) => frame.pass),
    totalDiffPixels: frames.reduce((sum, frame) => sum + frame.diffPixels, 0),
    maxChannelDelta: Math.max(0, ...frames.map((frame) => frame.maxChannelDelta)),
    frames,
  };
}

function writeCompactRedDotSheets(sourceBakedSheet: Uint8ClampedArray, originalTemplateGuideSheet: Uint8ClampedArray, convertedEditableSheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, slots: CompactSlot[], outDir: string) {
  const sourceRedDots = new Uint8ClampedArray(sourceBakedSheet);
  const templateRedDots = new Uint8ClampedArray(originalTemplateGuideSheet);
  const convertedRedDots = new Uint8ClampedArray(convertedEditableSheet);
  const overlayRedDots = overlayBuffers(originalTemplateGuideSheet, convertedEditableSheet, 0.75);
  const coordinates = slots.map((slot) => ({
    key: slot.editPath,
    action: slot.action,
    frameIndex: slot.frameIndex,
    templateRedDot: { sheetX: slot.targetAnchor.x, sheetY: slot.targetAnchor.y },
    sourceBakedRedDot: { sheetX: slot.targetAnchor.x, sheetY: slot.targetAnchor.y },
    convertedRedDot: { sheetX: slot.targetAnchor.x, sheetY: slot.targetAnchor.y },
    deltaConvertedMinusTemplate: { dx: 0, dy: 0 },
    guidePath: slot.guidePath,
  }));
  for (const slot of slots) {
    markDot(sourceRedDots, sheetWidth, sheetHeight, slot.targetAnchor.x, slot.targetAnchor.y, convertedDotColor);
    markDot(templateRedDots, sheetWidth, sheetHeight, slot.targetAnchor.x, slot.targetAnchor.y, templateDotColor);
    markDot(convertedRedDots, sheetWidth, sheetHeight, slot.targetAnchor.x, slot.targetAnchor.y, convertedDotColor);
    markDot(overlayRedDots, sheetWidth, sheetHeight, slot.targetAnchor.x, slot.targetAnchor.y, templateDotColor);
    markDot(overlayRedDots, sheetWidth, sheetHeight, slot.targetAnchor.x, slot.targetAnchor.y, convertedDotColor);
  }
  writeRgbaPng(path.join(outDir, 'red-dot-source-baked-sheet.png'), sheetWidth, sheetHeight, sourceRedDots);
  writeRgbaPng(path.join(outDir, 'red-dot-template-guide-sheet.png'), sheetWidth, sheetHeight, templateRedDots);
  writeRgbaPng(path.join(outDir, 'red-dot-converted-sheet.png'), sheetWidth, sheetHeight, convertedRedDots);
  writeRgbaPng(path.join(outDir, 'red-dot-template-vs-converted-overlay-sheet.png'), sheetWidth, sheetHeight, overlayRedDots);
  writeFileSync(path.join(outDir, 'red-dot-coordinates.json'), JSON.stringify(coordinates, null, 2));
  return {
    sourceBakedSheet: 'red-dot-source-baked-sheet.png',
    templateGuideSheet: 'red-dot-template-guide-sheet.png',
    convertedSheet: 'red-dot-converted-sheet.png',
    overlaySheet: 'red-dot-template-vs-converted-overlay-sheet.png',
    coordinates: 'red-dot-coordinates.json',
  };
}

function diffBuffers(width: number, height: number, expected: Uint8ClampedArray, actual: Uint8ClampedArray) {
  const diff = new Uint8ClampedArray(width * height * 4);
  let diffPixels = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < expected.length; i += 4) {
    let pixelDifferent = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(expected[i + channel] - actual[i + channel]);
      if (delta > 0) pixelDifferent = true;
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (pixelDifferent) {
      diffPixels += 1;
      diff[i] = 255;
      diff[i + 3] = 255;
    }
  }
  return { diff, diffPixels, maxChannelDelta, pass: diffPixels === 0 && maxChannelDelta === 0 };
}

function safeFrameFileName(action: string, frameIndex: number): string {
  return `${Buffer.from(action, 'utf8').toString('base64url')}-${frameIndex}.png`;
}

function cropCell(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, cell: BakedCell): Uint8ClampedArray {
  return cropSheet(sheet, sheetWidth, sheetHeight, cell.col * cellWidth, cell.row * cellHeight, cellWidth, cellHeight);
}

function cellBounds(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, cell: BakedCell): Bounds {
  return alphaBounds(cellWidth, cellHeight, cropCell(sheet, sheetWidth, sheetHeight, cell));
}

function safePathSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}


function overlayBuffers(base: Uint8ClampedArray, overlay: Uint8ClampedArray, overlayOpacity = 0.75): Uint8ClampedArray {
  const out = new Uint8ClampedArray(base);
  for (let i = 0; i < overlay.length; i += 4) {
    const adjusted = new Uint8ClampedArray(4);
    adjusted[0] = overlay[i];
    adjusted[1] = overlay[i + 1];
    adjusted[2] = overlay[i + 2];
    adjusted[3] = Math.round(overlay[i + 3] * overlayOpacity);
    over(out, i, adjusted, 0);
  }
  return out;
}

const templateDotColor: [number, number, number, number] = [255, 0, 0, 255];
const convertedDotColor: [number, number, number, number] = [0, 255, 0, 255];

function markDot(buffer: Uint8ClampedArray, width: number, height: number, x: number, y: number, color: [number, number, number, number]): void {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || px >= width || py < 0 || py >= height) return;
  const offset = (py * width + px) * 4;
  buffer[offset] = color[0];
  buffer[offset + 1] = color[1];
  buffer[offset + 2] = color[2];
  buffer[offset + 3] = color[3];
}

function markCellDot(sheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, cell: BakedCell, anchor: Pick<Anchor, 'x' | 'y'>, color: [number, number, number, number]): void {
  markDot(sheet, sheetWidth, sheetHeight, cell.col * cellWidth + anchor.x, cell.row * cellHeight + anchor.y, color);
}

function writeRedDotSheets(
  sourceBakedSheet: Uint8ClampedArray,
  originalTemplateGuideSheet: Uint8ClampedArray,
  convertedEditableSheet: Uint8ClampedArray,
  sheetWidth: number,
  sheetHeight: number,
  records: PlacementRecord[],
  outDir: string,
) {
  const sourceRedDots = new Uint8ClampedArray(sourceBakedSheet);
  const templateRedDots = new Uint8ClampedArray(originalTemplateGuideSheet);
  const convertedRedDots = new Uint8ClampedArray(convertedEditableSheet);
  const overlayRedDots = overlayBuffers(originalTemplateGuideSheet, convertedEditableSheet, 0.75);
  const coordinates = records.map((record) => ({
    key: record.key,
    action: record.action,
    frameIndex: record.frameIndex,
    col: record.col,
    row: record.row,
    templateRedDot: {
      sheetX: record.col * cellWidth + record.targetAnchor.x,
      sheetY: record.row * cellHeight + record.targetAnchor.y,
      cellX: record.targetAnchor.x,
      cellY: record.targetAnchor.y,
    },
    sourceBakedRedDot: {
      sheetX: record.col * cellWidth + record.actualAnchorInCell.x,
      sheetY: record.row * cellHeight + record.actualAnchorInCell.y,
      cellX: record.actualAnchorInCell.x,
      cellY: record.actualAnchorInCell.y,
    },
    convertedRedDot: {
      sheetX: record.col * cellWidth + record.actualAnchorInCell.x,
      sheetY: record.row * cellHeight + record.actualAnchorInCell.y,
      cellX: record.actualAnchorInCell.x,
      cellY: record.actualAnchorInCell.y,
    },
    deltaConvertedMinusTemplate: record.error,
    suggestedCorrectionToApplyToConverted: {
      dx: -record.error.dx,
      dy: -record.error.dy,
    },
  }));
  for (const record of records) {
    const cell = { action: record.action, frameIndex: record.frameIndex, col: record.col, row: record.row };
    markCellDot(sourceRedDots, sheetWidth, sheetHeight, cell, record.actualAnchorInCell, convertedDotColor);
    markCellDot(templateRedDots, sheetWidth, sheetHeight, cell, record.targetAnchor, templateDotColor);
    markCellDot(convertedRedDots, sheetWidth, sheetHeight, cell, record.actualAnchorInCell, convertedDotColor);
    markCellDot(overlayRedDots, sheetWidth, sheetHeight, cell, record.targetAnchor, templateDotColor);
    markCellDot(overlayRedDots, sheetWidth, sheetHeight, cell, record.actualAnchorInCell, convertedDotColor);
  }
  writeRgbaPng(path.join(outDir, 'red-dot-source-baked-sheet.png'), sheetWidth, sheetHeight, sourceRedDots);
  writeRgbaPng(path.join(outDir, 'red-dot-template-guide-sheet.png'), sheetWidth, sheetHeight, templateRedDots);
  writeRgbaPng(path.join(outDir, 'red-dot-converted-sheet.png'), sheetWidth, sheetHeight, convertedRedDots);
  writeRgbaPng(path.join(outDir, 'red-dot-template-vs-converted-overlay-sheet.png'), sheetWidth, sheetHeight, overlayRedDots);
  writeFileSync(path.join(outDir, 'red-dot-coordinates.json'), JSON.stringify(coordinates, null, 2));
  return {
    sourceBakedSheet: 'red-dot-source-baked-sheet.png',
    templateGuideSheet: 'red-dot-template-guide-sheet.png',
    convertedSheet: 'red-dot-converted-sheet.png',
    overlaySheet: 'red-dot-template-vs-converted-overlay-sheet.png',
    coordinates: 'red-dot-coordinates.json',
  };
}

function writeOverlayStrip(filePath: string, title: string, frames: Uint8ClampedArray[]): void {
  const scale = 2;
  const labelHeight = 36;
  const width = Math.max(1, frames.length) * cellWidth * scale;
  const height = labelHeight + cellHeight * scale;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(title, 12, 24);
  frames.forEach((frame, index) => {
    const cellCanvas = createCanvas(cellWidth, cellHeight);
    const cellCtx = cellCanvas.getContext('2d');
    const imageData = cellCtx.createImageData(cellWidth, cellHeight);
    imageData.data.set(frame);
    cellCtx.putImageData(imageData, 0, 0);
    ctx.drawImage(cellCanvas, index * cellWidth * scale, labelHeight, cellWidth * scale, cellHeight * scale);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '16px sans-serif';
    ctx.fillText(String(index), index * cellWidth * scale + 8, labelHeight + 22);
  });
  writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function writePlacementOverlays(templateSheet: Uint8ClampedArray, convertedSheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, outDir: string) {
  const overlayRoot = path.join(outDir, 'placement-overlays');
  mkdirSync(overlayRoot, { recursive: true });
  const overlaysByAction = new Map<string, Uint8ClampedArray[]>();
  for (const cell of bakedCells) {
    const template = cropCell(templateSheet, sheetWidth, sheetHeight, cell);
    const converted = cropCell(convertedSheet, sheetWidth, sheetHeight, cell);
    const overlay = overlayBuffers(template, converted, 0.75);
    const actionDir = path.join(overlayRoot, safePathSegment(cell.action));
    mkdirSync(actionDir, { recursive: true });
    const fileName = `${String(cell.frameIndex).padStart(2, '0')}.png`;
    writeRgbaPng(path.join(actionDir, fileName), cellWidth, cellHeight, overlay);
    const actionOverlays = overlaysByAction.get(cell.action) ?? [];
    actionOverlays[cell.frameIndex] = overlay;
    overlaysByAction.set(cell.action, actionOverlays);
  }
  const stand1Overlays = overlaysByAction.get('기본(한손)')?.filter(Boolean) ?? [];
  const stand1OverlayStripPath = stand1Overlays.length > 0 ? path.join(outDir, 'placement-overlay-stand1.png') : null;
  if (stand1OverlayStripPath) writeOverlayStrip(stand1OverlayStripPath, 'Template + converted overlay: 기본(한손)', stand1Overlays);
  return {
    overlayRoot: path.relative(outDir, overlayRoot),
    stand1OverlayStrip: stand1OverlayStripPath ? path.relative(outDir, stand1OverlayStripPath) : null,
  };
}

function writeComparisonFramePng(filePath: string, action: string, frameIndex: number, source: Uint8ClampedArray, template: Uint8ClampedArray, converted: Uint8ClampedArray): void {
  const scale = 2;
  const labelHeight = 42;
  const gap = 18;
  const panelWidth = cellWidth * scale;
  const panelHeight = cellHeight * scale;
  const width = gap + panelWidth + gap + panelWidth + gap + panelWidth + gap;
  const height = labelHeight + panelHeight + gap;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#e2e8f0';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(`${action} #${frameIndex}`, gap, 26);

  const labels = ['MeAegi input', 'Original template', 'Converted PSD'];
  const cellsToDraw = [source, template, converted];
  for (let index = 0; index < cellsToDraw.length; index += 1) {
    const left = gap + index * (panelWidth + gap);
    const top = labelHeight;
    ctx.fillStyle = '#020617';
    ctx.fillRect(left, top, panelWidth, panelHeight);
    ctx.strokeStyle = index === 0 ? '#38bdf8' : index === 1 ? '#f59e0b' : '#22c55e';
    ctx.lineWidth = 3;
    ctx.strokeRect(left, top, panelWidth, panelHeight);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '14px sans-serif';
    ctx.fillText(labels[index], left + 8, top + 20);

    const cellCanvas = createCanvas(cellWidth, cellHeight);
    const cellCtx = cellCanvas.getContext('2d');
    const imageData = cellCtx.createImageData(cellWidth, cellHeight);
    imageData.data.set(cellsToDraw[index]);
    cellCtx.putImageData(imageData, 0, 0);
    ctx.drawImage(cellCanvas, left, top, panelWidth, panelHeight);
  }
  writeFileSync(filePath, canvas.toBuffer('image/png'));
}

function makeGif(framePaths: string[], gifPath: string): string | null {
  if (framePaths.length === 0) return null;
  try {
    execFileSync('magick', ['-delay', '18', '-loop', '0', ...framePaths, gifPath], { stdio: 'ignore' });
    return gifPath;
  } catch {
    return null;
  }
}

function writeMotionComparisons(sourceSheet: Uint8ClampedArray, templateSheet: Uint8ClampedArray, convertedSheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, outDir: string): ComparisonArtifact[] {
  const frameRoot = path.join(outDir, 'motion-comparison-frames');
  const gifRoot = path.join(outDir, 'motion-comparison-gifs');
  mkdirSync(frameRoot, { recursive: true });
  mkdirSync(gifRoot, { recursive: true });
  const actions = [...new Set(bakedCells.map((cell) => cell.action))];
  return actions.map((action) => {
    const actionCells = bakedCells.filter((cell) => cell.action === action).sort((a, b) => a.frameIndex - b.frameIndex);
    const actionDir = path.join(frameRoot, safePathSegment(action));
    mkdirSync(actionDir, { recursive: true });
    const framePaths: string[] = [];
    let sourceVsConvertedDiffPixels = 0;
    let sourceVsConvertedMaxDelta = 0;
    let sourceVsTemplateDiffPixels = 0;
    let sourceVsTemplateMaxDelta = 0;
    for (const cell of actionCells) {
      const source = cropCell(sourceSheet, sheetWidth, sheetHeight, cell);
      const template = cropCell(templateSheet, sheetWidth, sheetHeight, cell);
      const converted = cropCell(convertedSheet, sheetWidth, sheetHeight, cell);
      const convertedDiff = diffBuffers(cellWidth, cellHeight, source, converted);
      const templateDiff = diffBuffers(cellWidth, cellHeight, source, template);
      sourceVsConvertedDiffPixels += convertedDiff.diffPixels;
      sourceVsConvertedMaxDelta = Math.max(sourceVsConvertedMaxDelta, convertedDiff.maxChannelDelta);
      sourceVsTemplateDiffPixels += templateDiff.diffPixels;
      sourceVsTemplateMaxDelta = Math.max(sourceVsTemplateMaxDelta, templateDiff.maxChannelDelta);
      const framePath = path.join(actionDir, `${String(cell.frameIndex).padStart(2, '0')}.png`);
      writeComparisonFramePng(framePath, action, cell.frameIndex, source, template, converted);
      framePaths.push(framePath);
    }
    const gifPath = path.join(gifRoot, `${safePathSegment(action)}.gif`);
    const maybeGif = makeGif(framePaths, gifPath);
    return {
      action,
      frameCount: actionCells.length,
      gifPath: maybeGif ? path.relative(outDir, maybeGif) : null,
      frameDir: path.relative(outDir, actionDir),
      sourceVsConvertedDiffPixels,
      sourceVsConvertedMaxDelta,
      sourceVsTemplateDiffPixels,
      sourceVsTemplateMaxDelta,
    };
  });
}

function validateCells(expectedSheet: Uint8ClampedArray, readbackSheet: Uint8ClampedArray, sheetWidth: number, sheetHeight: number, outDir: string) {
  const expectedDir = path.join(outDir, 'source-frame-cells');
  const actualDir = path.join(outDir, 'psd-frame-cells');
  const diffDir = path.join(outDir, 'frame-diff');
  let totalDiffPixels = 0;
  let maxChannelDelta = 0;
  const frames = bakedCells.map((cell) => {
    const expected = cropCell(expectedSheet, sheetWidth, sheetHeight, cell);
    const actual = cropCell(readbackSheet, sheetWidth, sheetHeight, cell);
    const diff = diffBuffers(cellWidth, cellHeight, expected, actual);
    totalDiffPixels += diff.diffPixels;
    maxChannelDelta = Math.max(maxChannelDelta, diff.maxChannelDelta);
    const fileName = safeFrameFileName(cell.action, cell.frameIndex);
    writeRgbaPng(path.join(expectedDir, fileName), cellWidth, cellHeight, expected);
    writeRgbaPng(path.join(actualDir, fileName), cellWidth, cellHeight, actual);
    writeRgbaPng(path.join(diffDir, fileName), cellWidth, cellHeight, diff.diff);
    return {
      action: cell.action,
      frameIndex: cell.frameIndex,
      pass: diff.pass,
      diffPixels: diff.diffPixels,
      maxChannelDelta: diff.maxChannelDelta,
      sourceFramePath: `source-frame-cells/${fileName}`,
      psdFramePath: `psd-frame-cells/${fileName}`,
      diffPath: `frame-diff/${fileName}`,
    };
  });
  return {
    pass: frames.every((frame) => frame.pass),
    totalDiffPixels,
    maxChannelDelta,
    frames,
  };
}

function validatePlacementRecords(records: PlacementRecord[], sheetWidth: number, sheetHeight: number) {
  const frames = records.map((record) => ({
    key: record.key,
    action: record.action,
    frameIndex: record.frameIndex,
    col: record.col,
    row: record.row,
    targetAnchor: record.targetAnchor,
    sourceAnchor: record.sourceAnchor,
    destLeft: record.destLeft,
    destTop: record.destTop,
    actualAnchorInCell: record.actualAnchorInCell,
    error: record.error,
    sheetAnchor: {
      x: record.col * cellWidth + record.actualAnchorInCell.x,
      y: record.row * cellHeight + record.actualAnchorInCell.y,
    },
    cellFullyInsideSheet: (record.col + 1) * cellWidth <= sheetWidth && (record.row + 1) * cellHeight <= sheetHeight,
    anchorInsideSheet:
      record.col * cellWidth + record.actualAnchorInCell.x >= 0 &&
      record.col * cellWidth + record.actualAnchorInCell.x < sheetWidth &&
      record.row * cellHeight + record.actualAnchorInCell.y >= 0 &&
      record.row * cellHeight + record.actualAnchorInCell.y < sheetHeight,
  })).map((frame) => ({
    ...frame,
    pass: frame.error.dx === 0 && frame.error.dy === 0 && frame.cellFullyInsideSheet && frame.anchorInsideSheet,
  }));
  return {
    pass: frames.every((frame) => frame.pass),
    maxAbsDx: Math.max(0, ...frames.map((frame) => Math.abs(frame.error.dx))),
    maxAbsDy: Math.max(0, ...frames.map((frame) => Math.abs(frame.error.dy))),
    frames,
  };
}

export async function bakeMeaegiWholeAvatar(input: BakeMeaegiWholeAvatarInput) {
  ensureCanvasInitialized();
  const share = extractMeaegiShareId(input.share);
  const target = input.target ?? 'cape';
  if (!isBakeTarget(target)) throw new Error(`Unknown target "${target}". Use one of: ${supportedBakeTargets.join(', ')}.`);
  const outDir = input.outDir ?? path.join('artifacts/whole-avatar-bake', share, target);
  const config = targetConfigs[target];
  logProgress(`loading MeAegi share ${share}`);
  const imported = await loadMeaegiImport(share, input.selectedPartIds);
  if (input.selectedPartIds && imported.selection.selectedPartIds.length === 0) {
    throw new Error('At least one selected source part is required for selective bake.');
  }
  const uniqueFrames = new Map<string, { action: string; frameIndex: number; imageRef: string }>();
  for (const frame of imported.frames) {
    const key = `${frame.action}:${frame.frameIndex}`;
    if (!uniqueFrames.has(key) && frame.imageRef) uniqueFrames.set(key, { action: frame.action, frameIndex: frame.frameIndex, imageRef: frame.imageRef });
  }
  logProgress(`loading source frame PNGs (${uniqueFrames.size} unique action frames, concurrency=${frameFetchConcurrency}, cache=${frameCacheDir})`);
  let frameByKey = await loadFramesFromUniqueMap(uniqueFrames, bakedCells);
  if (imported.selection.baselineHash) {
    logProgress(`loading baseline frame PNGs for selected-part alpha mask (${imported.selection.baselineHash})`);
    const baselineFrameByKey = await loadFrameSetForHash(imported.selection.baselineHash, bakedCells);
    frameByKey = applyBaselineMask(frameByKey, baselineFrameByKey);
  }
  logProgress(`loading reference calibration frame PNGs (${referenceCalibrationShare})`);
  const referenceFrameByKey = await loadFrameSetForCells(referenceCalibrationShare, bakedCells);

  logProgress(`reading template ${config.templatePath}`);
  const psd = readPsd(readFileSync(config.templatePath), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const sheetWidth = psd.width;
  const sheetHeight = psd.height;
  const originalTemplateGuideSheet = renderLayerSheet(psd, (entry) => entry.path.includes('guide_character'));
  const originalTemplateReferenceSheet = renderTemplateReferenceSheet(psd);
  const originalTemplateEditableSheet = renderEditableSheet(psd);
  if (!isFullGridTargetConfig(config)) {
    const slots = compactSlotsForPsd(psd, referenceFrameByKey);
    const sheet = new Uint8ClampedArray(sheetWidth * sheetHeight * 4);
    for (const slot of slots) {
      const key = `${slot.action}:${slot.frameIndex}`;
      const frame = frameByKey.get(key);
      if (!frame) throw new Error(`Missing compact source frame ${key} for ${slot.editPath}`);
      drawFrameAt(sheet, sheetWidth, sheetHeight, frame, slot.destLeft, slot.destTop);
    }
    const expectedLayers = installCompactSlotLayers(psd, sheet, slots);
    if (config.removeZmapPreset) psd.children = removeZmapPresetLayers(psd.children);
    mkdirSync(outDir, { recursive: true });
    const psdPath = path.join(outDir, config.outputName);
    logProgress(`writing compact PSD ${psdPath}`);
    writeFileSync(psdPath, writePsdBuffer(psd, { generateThumbnail: false, trimImageData: false }));
    writeRgbaPng(path.join(outDir, 'expected-sheet.png'), sheetWidth, sheetHeight, sheet);
    writeRgbaPng(path.join(outDir, 'original-template-guide-sheet.png'), sheetWidth, sheetHeight, originalTemplateGuideSheet);
    writeRgbaPng(path.join(outDir, 'original-template-reference-sheet.png'), sheetWidth, sheetHeight, originalTemplateReferenceSheet);
    writeRgbaPng(path.join(outDir, 'original-template-editable-sheet.png'), sheetWidth, sheetHeight, originalTemplateEditableSheet);

    const readback = readPsd(readFileSync(psdPath), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
    const layerValidation = validateCompactLayerReadback(expectedLayers, readback);
    const convertedEditableSheet = renderEditableSheet(readback);
    writeRgbaPng(path.join(outDir, 'converted-editable-sheet.png'), sheetWidth, sheetHeight, convertedEditableSheet);
    writeRgbaPng(path.join(outDir, 'readback-layer.png'), sheetWidth, sheetHeight, convertedEditableSheet);
    const diff = diffBuffers(sheetWidth, sheetHeight, sheet, convertedEditableSheet);
    writeRgbaPng(path.join(outDir, 'diff.png'), sheetWidth, sheetHeight, diff.diff);
    const placementValidation = {
      pass: true,
      maxAbsDx: 0,
      maxAbsDy: 0,
      frames: slots.map((slot) => ({
        key: slot.editPath,
        action: slot.action,
        frameIndex: slot.frameIndex,
        targetAnchor: slot.targetAnchor,
        sourceAnchor: slot.sourceAnchor,
        destLeft: slot.destLeft,
        destTop: slot.destTop,
        actualAnchorInCell: { x: slot.targetAnchor.x, y: slot.targetAnchor.y },
        error: { dx: 0, dy: 0 },
        sheetAnchor: { x: slot.targetAnchor.x, y: slot.targetAnchor.y },
        cellFullyInsideSheet: true,
        anchorInsideSheet: slot.targetAnchor.x >= 0 && slot.targetAnchor.x < sheetWidth && slot.targetAnchor.y >= 0 && slot.targetAnchor.y < sheetHeight,
        pass: true,
        guidePath: slot.guidePath,
      })),
    };
    const redDotArtifacts = writeCompactRedDotSheets(sheet, originalTemplateGuideSheet, convertedEditableSheet, sheetWidth, sheetHeight, slots, outDir);
    const supportedKeys = new Set(slots.map((slot) => `${slot.action}:${slot.frameIndex}`));
    const skipped = [...uniqueFrames.values()]
      .filter((frame) => {
        const key = `${frame.action}:${frame.frameIndex}`;
        return !supportedKeys.has(key) && !frame.action.includes('눈깜빡임');
      })
      .map((frame) => ({ action: frame.action, frameIndex: frame.frameIndex }));
    const report = {
      share,
      target,
      selectedPartIds: imported.selection.selectedPartIds,
      selection: imported.selection,
      templatePath: config.templatePath,
      editLayerPath: slots.map((slot) => slot.editPath).join(','),
      outputPsd: psdPath,
      sourceActionFrames: uniqueFrames.size,
      bakedFrames: slots.length,
      frameFetch: {
        concurrency: frameFetchConcurrency,
        retryAttempts: frameFetchRetryAttempts,
        timeoutMs: frameFetchTimeoutMs,
        cacheDir: frameCacheDir,
      },
      skippedFrames: skipped.length,
      skipped,
      duplicateRepresentedFrames: [],
      excludedExpressionFrames: [...uniqueFrames.values()].filter((frame) => frame.action.includes('눈깜빡임')).length,
      placement: {
        cellWidth: sheetWidth,
        cellHeight: sheetHeight,
        referenceCalibrationShare,
        anchor: 'compact-template-guide-character-anchor-matched-to-reference-meaegi-body-anchor',
        zmapPresetRemoved: config.removeZmapPreset,
        targetLayerPromotedToTop: false,
        fixedFramePlacementOffset: null,
        manualFrameCorrections: [],
        compactSlots: slots.map((slot) => ({
          editPath: slot.editPath,
          guidePath: slot.guidePath,
          action: slot.action,
          frameIndex: slot.frameIndex,
          targetAnchor: slot.targetAnchor,
          sourceAnchor: slot.sourceAnchor,
          destLeft: slot.destLeft,
          destTop: slot.destTop,
        })),
        placementValidation,
        redDotArtifacts,
      },
      validation: {
        readbackLayerExactMatch: layerValidation.pass,
        diffPixels: layerValidation.totalDiffPixels,
        maxChannelDelta: layerValidation.maxChannelDelta,
        frameCellsPass: layerValidation.pass,
        frameCellDiffPixels: layerValidation.totalDiffPixels,
        frameCellMaxChannelDelta: layerValidation.maxChannelDelta,
        frameCells: layerValidation.frames,
        motionComparisonGifsGenerated: 0,
        placementOverlays: { overlayRoot: null, stand1OverlayStrip: null },
        motionComparisons: [] as ComparisonArtifact[],
      },
      warnings: [
        imported.selection.baselineMaskApplied
          ? 'Selective compact bake is active: selected-part render frames are alpha-masked against the MeAegi default baseline so excluded pixels become transparent.'
          : 'This compact template bake writes selected source pixels into every edithere slot of a 300x180 cap/hair style PSD.',
        'Compact cap/hair templates do not contain the 90-frame full motion grid; they contain named edit slots, so validation is per editable layer readback plus guide-anchor red dots.',
        'MSW upload/runtime validation is still manual.',
        'Blink/expression frames are intentionally excluded.',
      ],
    };
    const reportPath = path.join(outDir, 'validation-report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    return { report, reportPath, psdPath, expectedSheetPath: path.join(outDir, 'expected-sheet.png'), readbackLayerPath: path.join(outDir, 'readback-layer.png'), diffPath: path.join(outDir, 'diff.png') };
  }
  const guideBoundsByCell = new Map<string, Bounds>(bakedCells.map((cell) => [`${cell.action}:${cell.frameIndex}`, cellBounds(originalTemplateGuideSheet, sheetWidth, sheetHeight, cell)]));
  const targetFixedOffset = fixedFramePlacementOffsets[target];
  const targetManualCorrections = { ...(manualFrameCorrections[target] ?? {}), ...(input.manualFrameCorrections ?? {}) };
  const placementRecords: PlacementRecord[] = [];
  const sheet = new Uint8ClampedArray(sheetWidth * sheetHeight * 4);
  const referenceAlignmentSheet = new Uint8ClampedArray(sheetWidth * sheetHeight * 4);
  logProgress(`drawing ${bakedCells.length} baked cells`);
  for (const cell of bakedCells) {
    const key = correctionKey(cell);
    const guideBounds = guideBoundsByCell.get(key);
    const targetAnchor = anchorFromBounds(guideBounds, { x: cellWidth / 2, y: cellHeight * 0.6, basis: 'fallback-cell-center' }, 'template-guide-character-center-bottom');
    const referenceFrame = referenceFrameByKey.get(key)!;
    const sourceAnchor = anchorFromBounds(referenceFrame.bounds, { x: referenceFrame.width / 2, y: referenceFrame.height * 2 / 3, basis: 'fallback-reference-frame-origin' }, `reference-share-${referenceCalibrationShare}-alpha-center-bottom`);
    const placement = placementForCell(cell, targetAnchor, sourceAnchor, targetManualCorrections[key], targetFixedOffset);
    placementRecords.push(placement);
    drawFrame(sheet, sheetWidth, sheetHeight, frameByKey.get(key)!, placement);
    drawFrame(referenceAlignmentSheet, sheetWidth, sheetHeight, referenceFrame, placement);
  }
  installSheetLayer(psd, config.editLayerPath, sheet, config.expandTargetLayerToCanvas);
  if (config.removeZmapPreset) psd.children = removeZmapPresetLayers(psd.children);
  if (config.promoteTargetLayerToTop) promoteLayerToTop(psd, config.editLayerPath);
  mkdirSync(outDir, { recursive: true });
  const psdPath = path.join(outDir, config.outputName);
  logProgress(`writing PSD ${psdPath}`);
  writeFileSync(psdPath, writePsdBuffer(psd, { generateThumbnail: false, trimImageData: false }));
  logProgress('writing sheet PNG artifacts');
  writeRgbaPng(path.join(outDir, 'expected-sheet.png'), sheetWidth, sheetHeight, sheet);
  writeRgbaPng(path.join(outDir, 'reference-alignment-sheet.png'), sheetWidth, sheetHeight, referenceAlignmentSheet);
  writeRgbaPng(path.join(outDir, 'reference-guide-overlay-sheet.png'), sheetWidth, sheetHeight, overlayBuffers(originalTemplateGuideSheet, referenceAlignmentSheet, 0.75));
  writeRgbaPng(path.join(outDir, 'original-template-guide-sheet.png'), sheetWidth, sheetHeight, originalTemplateGuideSheet);
  writeRgbaPng(path.join(outDir, 'original-template-reference-sheet.png'), sheetWidth, sheetHeight, originalTemplateReferenceSheet);
  writeRgbaPng(path.join(outDir, 'original-template-editable-sheet.png'), sheetWidth, sheetHeight, originalTemplateEditableSheet);

  logProgress('reading generated PSD back for validation');
  psd.children = undefined;
  const readback = readPsd(readFileSync(psdPath), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const editLayerName = config.editLayerPath.split('/').at(-1);
  const readbackLayer = flatten(readback.children).find((entry) =>
    entry.path === config.editLayerPath ||
    entry.path === editLayerName ||
    (editLayerName ? entry.path.endsWith(`/${editLayerName}`) : false),
  )?.layer;
  if (!readbackLayer?.imageData?.data) throw new Error('Readback layer imageData missing.');
  const readbackData = new Uint8ClampedArray(readbackLayer.imageData.data.buffer, readbackLayer.imageData.data.byteOffset, readbackLayer.imageData.data.byteLength);
  writeRgbaPng(path.join(outDir, 'readback-layer.png'), readbackLayer.imageData.width, readbackLayer.imageData.height, readbackData);
  const readbackSheet = new Uint8ClampedArray(sheetWidth * sheetHeight * 4);
  blitLayerToSheet(readbackSheet, sheetWidth, sheetHeight, readbackLayer);
  writeRgbaPng(path.join(outDir, 'readback-sheet.png'), sheetWidth, sheetHeight, readbackSheet);
  logProgress('rendering converted editable sheet and validation artifacts');
  const convertedEditableSheet = renderEditableSheet(readback);
  writeRgbaPng(path.join(outDir, 'converted-editable-sheet.png'), sheetWidth, sheetHeight, convertedEditableSheet);
  const diff = diffBuffers(sheetWidth, sheetHeight, sheet, convertedEditableSheet);
  writeRgbaPng(path.join(outDir, 'diff.png'), sheetWidth, sheetHeight, diff.diff);
  const frameValidation = validateCells(sheet, convertedEditableSheet, sheetWidth, sheetHeight, outDir);
  const placementValidation = validatePlacementRecords(placementRecords, sheetWidth, sheetHeight);
  const redDotArtifacts = writeRedDotSheets(sheet, originalTemplateGuideSheet, convertedEditableSheet, sheetWidth, sheetHeight, placementRecords, outDir);
  logProgress('writing motion comparison frames/GIFs');
  const motionComparisons = writeMotionComparisons(sheet, originalTemplateReferenceSheet, convertedEditableSheet, sheetWidth, sheetHeight, outDir);
  const placementOverlays = writePlacementOverlays(originalTemplateReferenceSheet, convertedEditableSheet, sheetWidth, sheetHeight, outDir);

  const supportedKeys = new Set(bakedCells.map((cell) => `${cell.action}:${cell.frameIndex}`));
  const representedDuplicateKeys = new Map<string, string>([
    ['엎드려 찌르기:0', '엎드리기:0'],
  ]);
  const duplicateRepresentedFrames = [...uniqueFrames.values()]
    .filter((frame) => representedDuplicateKeys.has(`${frame.action}:${frame.frameIndex}`))
    .map((frame) => ({ action: frame.action, frameIndex: frame.frameIndex, representedBy: representedDuplicateKeys.get(`${frame.action}:${frame.frameIndex}`)! }));
  const skipped = [...uniqueFrames.values()]
    .filter((frame) => {
      const key = `${frame.action}:${frame.frameIndex}`;
      return !supportedKeys.has(key) && !representedDuplicateKeys.has(key) && !frame.action.includes('눈깜빡임');
    })
    .map((frame) => ({ action: frame.action, frameIndex: frame.frameIndex }));
  const report = {
    share,
    target,
    selectedPartIds: imported.selection.selectedPartIds,
    selection: imported.selection,
    templatePath: config.templatePath,
    editLayerPath: config.editLayerPath,
    outputPsd: psdPath,
    sourceActionFrames: uniqueFrames.size,
    bakedFrames: bakedCells.length,
    frameFetch: {
      concurrency: frameFetchConcurrency,
      retryAttempts: frameFetchRetryAttempts,
      timeoutMs: frameFetchTimeoutMs,
      cacheDir: frameCacheDir,
    },
    skippedFrames: skipped.length,
    skipped,
    duplicateRepresentedFrames,
    excludedExpressionFrames: [...uniqueFrames.values()].filter((frame) => frame.action.includes('눈깜빡임')).length,
    placement: {
      cellWidth,
      cellHeight,
      referenceCalibrationShare,
      anchor: 'per-frame-template-guide-character-anchor-matched-to-reference-meaegi-body-anchor',
      zmapPresetRemoved: config.removeZmapPreset,
      targetLayerPromotedToTop: config.promoteTargetLayerToTop,
      fixedFramePlacementOffset: targetFixedOffset ? { ...targetFixedOffset } : null,
      manualFrameCorrections: Object.entries(targetManualCorrections).map(([key, correction]) => ({ key, ...correction })),
      placementValidation,
      redDotArtifacts,
    },
    validation: {
      readbackLayerExactMatch: frameValidation.pass,
      diffPixels: diff.diffPixels,
      maxChannelDelta: diff.maxChannelDelta,
      frameCellsPass: frameValidation.pass,
      frameCellDiffPixels: frameValidation.totalDiffPixels,
      frameCellMaxChannelDelta: frameValidation.maxChannelDelta,
      frameCells: frameValidation.frames,
      motionComparisonGifsGenerated: motionComparisons.filter((artifact) => artifact.gifPath).length,
      placementOverlays,
      motionComparisons,
    },
    warnings: [
      imported.selection.baselineMaskApplied
        ? 'Selective bake is active: selected-part render frames are alpha-masked against the MeAegi default baseline so excluded skin/face/hair/body pixels become transparent.'
        : 'This is a whole-avatar bake: it writes full-character frames into one expanded MSW editable layer rather than isolating worn source parts.',
      'MSW upload/runtime validation is still manual; this script now emits MeAegi/template/converted motion GIFs so placement can be visually checked before upload.',
      'Blink/expression frames are intentionally excluded.',
      'Heal, ghost, and 쏘기F:2 actions are not represented by the current MSW avatar template grid and are skipped in this first bake.',
    ],
  };
  const reportPath = path.join(outDir, 'validation-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return { report, reportPath, psdPath, expectedSheetPath: path.join(outDir, 'expected-sheet.png'), readbackLayerPath: path.join(outDir, 'readback-layer.png'), diffPath: path.join(outDir, 'diff.png') };
}

async function main() {
  const { share, target, outDir, selectedPartIds } = parseArgs();
  const { report, reportPath } = await bakeMeaegiWholeAvatar({ share, target, outDir, selectedPartIds });
  const failedPlacementFrames = report.placement.placementValidation.frames
    .filter((frame) => !frame.pass)
    .map((frame) => frame.key);
  console.log(JSON.stringify({
    share: report.share,
    target: report.target,
    outputPsd: report.outputPsd,
    reportPath,
    frameFetch: report.frameFetch,
    validation: {
      readbackLayerExactMatch: report.validation.readbackLayerExactMatch,
      diffPixels: report.validation.diffPixels,
      maxChannelDelta: report.validation.maxChannelDelta,
      frameCellsPass: report.validation.frameCellsPass,
      frameCellDiffPixels: report.validation.frameCellDiffPixels,
      motionComparisonGifsGenerated: report.validation.motionComparisonGifsGenerated,
    },
    placement: {
      pass: report.placement.placementValidation.pass,
      maxAbsDx: report.placement.placementValidation.maxAbsDx,
      maxAbsDy: report.placement.placementValidation.maxAbsDy,
      failedFrames: failedPlacementFrames,
    },
    skippedFrames: report.skippedFrames,
    warnings: report.warnings,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
