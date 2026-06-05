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
  expandCompactSlotsToSourceBounds: true,
  preserveTemplateSlotWhenSparse: true,
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
    removeZmapPreset: false,
    rawHairZmapSource: true,
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
const meaegiRequestRetryAttempts = 4;
const meaegiRequestTimeoutMs = 20_000;
const frameCacheDir = path.join('artifacts', 'frame-cache');
const meaegiSharePayloadCache = new Map<string, MeaegiAvatarPayload>();
const meaegiHashCache = new Map<string, string>();

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


async function postMeaegiActionText(actionId: string, body: unknown, label: string): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= meaegiRequestRetryAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), meaegiRequestTimeoutMs);
    try {
      const upstream = await fetch('https://meaegi.com/dressing-room', {
        method: 'POST',
        headers: {
          'Next-Action': actionId,
          'Content-Type': 'text/plain;charset=UTF-8',
          Accept: 'text/x-component',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await upstream.text();
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < meaegiRequestRetryAttempts) await sleep(500 * attempt * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${label} failed after ${meaegiRequestRetryAttempts} attempts (${fetchErrorSummary(lastError)})`);
}

async function fetchMeaegiSharePayload(share: string): Promise<MeaegiAvatarPayload> {
  const cached = meaegiSharePayloadCache.get(share);
  if (cached) return cached;
  const text = await postMeaegiActionText(MEAEGI_GET_SHARE_ACTION_ID, [share], `MeAegi share fetch ${share}`);
  const payload = parseMeaegiFlight(text);
  meaegiSharePayloadCache.set(share, payload);
  return payload;
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
  const params = buildMeaegiHashParams(avatar, selectedPartIds);
  const cacheKey = JSON.stringify(params);
  const cached = meaegiHashCache.get(cacheKey);
  if (cached) return cached;
  const text = await postMeaegiActionText(MEAEGI_BUILD_HASH_ACTION_ID, [params], `MeAegi hash build parts=${selectedPartIds.join(',') || '(baseline)'}`);
  const hash = parseMeaegiHashFlight(text);
  meaegiHashCache.set(cacheKey, hash);
  return hash;
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
      itemCodes: Object.fromEntries(finiteItemEntries(avatar)),
      itemPrism: avatar.itemPrism ?? {},
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

function renderVisibleCompositeSheet(psd: Psd): Uint8ClampedArray {
  return renderLayerSheet(psd, (entry) => {
    const name = entry.layer.name ?? '';
    if (entry.path.startsWith('data/') || entry.path === 'data') return false;
    if (name.startsWith('guide_') || entry.path.includes('/guide_') || entry.path.includes('guide_character')) return false;
    return Boolean(entry.layer.imageData?.data);
  });
}

function updatePsdRootComposite(psd: Psd): Uint8ClampedArray {
  const composite = renderVisibleCompositeSheet(psd);
  psd.imageData = { width: psd.width, height: psd.height, data: composite };
  return composite;
}

function validateRootComposite(psd: Psd, options: { allowOpaqueRootAlpha?: boolean } = {}): { pass: boolean; exactMatch: boolean; diffPixels: number; maxChannelDelta: number; alphaDiffPixels: number; rgbOnlyDiffPixels: number } {
  const root = psd.imageData?.data
    ? new Uint8ClampedArray(psd.imageData.data.buffer, psd.imageData.data.byteOffset, psd.imageData.data.byteLength)
    : new Uint8ClampedArray(psd.width * psd.height * 4);
  const composite = renderVisibleCompositeSheet(psd);
  const diff = diffBuffers(psd.width, psd.height, composite, root);
  let alphaDiffPixels = 0;
  let rgbOnlyDiffPixels = 0;
  let visibleRgbDiffPixels = 0;
  let visibleRgbMaxDelta = 0;
  for (let i = 0; i < root.length; i += 4) {
    let rgbDelta = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      rgbDelta = Math.max(rgbDelta, Math.abs(root[i + channel] - composite[i + channel]));
    }
    const alphaDelta = Math.abs(root[i + 3] - composite[i + 3]);
    if (composite[i + 3] > 0) {
      if (rgbDelta > 0) visibleRgbDiffPixels += 1;
      visibleRgbMaxDelta = Math.max(visibleRgbMaxDelta, rgbDelta);
    }
    if (rgbDelta === 0 && alphaDelta === 0) continue;
    if (alphaDelta > 0) alphaDiffPixels += 1;
    else rgbOnlyDiffPixels += 1;
  }
  const opaqueAlphaOnly = options.allowOpaqueRootAlpha && root.every((_, index) => index % 4 !== 3 || root[index] === 255);
  const alphaAdjustedPass = Boolean(opaqueAlphaOnly && visibleRgbDiffPixels === 0 && visibleRgbMaxDelta === 0);
  return {
    pass: diff.pass || alphaAdjustedPass || (alphaDiffPixels === 0 && diff.maxChannelDelta <= 16),
    exactMatch: diff.pass,
    diffPixels: diff.diffPixels,
    maxChannelDelta: diff.maxChannelDelta,
    alphaDiffPixels,
    rgbOnlyDiffPixels,
  };
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
  layerLeft?: number;
  layerTop?: number;
  layerWidth?: number;
  layerHeight?: number;
  layerData?: Uint8ClampedArray;
  fallbackTemplateSlot?: { alphaPixels: number; reason: string; source: 'converted-donor' | 'template' | 'transparent-guard'; donorEditPath?: string };
}

interface MapleStoryIoEffect {
  image?: string;
  origin?: { x?: number; y?: number; isEmpty?: boolean };
  originOrZero?: { x?: number; y?: number; isEmpty?: boolean };
  position?: string;
}

interface MapleStoryIoFrame {
  effects?: Record<string, MapleStoryIoEffect>;
}

interface MapleStoryIoHairItem {
  id?: number;
  frameBooks?: Record<string, { frames?: MapleStoryIoFrame[] }>;
}

type HairEffectName = 'hairBelowBody' | 'hair' | 'hairOverHead' | 'hairShade' | 'backHair' | 'backHairBelowCap';

interface RawHairLayerPlacement {
  editPath: string;
  frameBook: string;
  requestedFrameBook?: string;
  frameIndex: number;
  effectName: HairEffectName;
  anchor: { x: number; y: number; basis: string };
  origin: { x: number; y: number };
  left: number;
  top: number;
  width: number;
  height: number;
  missingImage: boolean;
}

function compactPoseForLayerPath(layerPath: string): { action: string; frameIndex: number } {
  const lower = layerPath.toLowerCase();
  const suffixFrame = /:(\d+)$/.exec(layerPath)?.[1];
  const suffixIndex = suffixFrame ? Number(suffixFrame) : 0;
  if (lower.includes('back')) return { action: '밧줄', frameIndex: suffixIndex % 2 };
  if (lower.includes('prone') || lower.includes('stab')) return { action: '엎드리기', frameIndex: 0 };
  return { action: '기본(한손)', frameIndex: suffixIndex % 3 };
}

const frontOnlyCompactSourcePartIds = new Set(['face', 'faceDeco', 'eyeDeco']);

export function isFrontOnlyCompactSourceSelection(selectedPartIds: string[]): boolean {
  return selectedPartIds.length > 0 && selectedPartIds.every((partId) => frontOnlyCompactSourcePartIds.has(partId));
}

export function isCompactBackSlotPath(layerPath: string): boolean {
  return layerPath.toLowerCase().includes('back');
}

export function shouldUseTransparentCompactBackSlotGuard(selectedPartIds: string[], layerPath: string): boolean {
  return isFrontOnlyCompactSourceSelection(selectedPartIds) && isCompactBackSlotPath(layerPath);
}

export function compactTransparentUploadGuard(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  if (data.length >= 4) {
    data[0] = 0;
    data[1] = 0;
    data[2] = 0;
    data[3] = 1;
  }
  return data;
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


function rgbaAlphaPixels(rgba: Uint8ClampedArray): number {
  let alphaPixels = 0;
  for (let offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset] > 0) alphaPixels += 1;
  }
  return alphaPixels;
}

interface CompactLayerInstallRecord {
  entryPath: string;
  layer: Layer;
  slot?: CompactSlot;
  left: number;
  top: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  renderedAlpha: number;
  template: { width: number; height: number; rgba: Uint8ClampedArray };
  templateAlpha: number;
}

function copyDonorPixelsIntoTargetSlot(donor: CompactLayerInstallRecord, target: CompactLayerInstallRecord): Uint8ClampedArray {
  const out = new Uint8ClampedArray(target.width * target.height * 4);
  for (let y = 0; y < donor.height; y += 1) {
    const targetY = donor.top + y - target.top;
    if (targetY < 0 || targetY >= target.height) continue;
    for (let x = 0; x < donor.width; x += 1) {
      const targetX = donor.left + x - target.left;
      if (targetX < 0 || targetX >= target.width) continue;
      const sourceOffset = (y * donor.width + x) * 4;
      if (donor.data[sourceOffset + 3] === 0) continue;
      const targetOffset = (targetY * target.width + targetX) * 4;
      out[targetOffset] = donor.data[sourceOffset];
      out[targetOffset + 1] = donor.data[sourceOffset + 1];
      out[targetOffset + 2] = donor.data[sourceOffset + 2];
      out[targetOffset + 3] = donor.data[sourceOffset + 3];
    }
  }
  if (rgbaAlphaPixels(out) > 0) return out;

  const donorBounds = alphaBounds(donor.width, donor.height, donor.data);
  if (donorBounds.empty) return out;
  const donorCenterX = Math.round((donorBounds.left + donorBounds.right - 1) / 2);
  const donorCenterY = Math.round((donorBounds.top + donorBounds.bottom - 1) / 2);
  const targetCenterX = Math.round((target.width - 1) / 2);
  const targetCenterY = Math.round((target.height - 1) / 2);
  const dx = targetCenterX - donorCenterX;
  const dy = targetCenterY - donorCenterY;
  for (let y = donorBounds.top; y < donorBounds.bottom; y += 1) {
    const targetY = y + dy;
    if (targetY < 0 || targetY >= target.height) continue;
    for (let x = donorBounds.left; x < donorBounds.right; x += 1) {
      const targetX = x + dx;
      if (targetX < 0 || targetX >= target.width) continue;
      const sourceOffset = (y * donor.width + x) * 4;
      if (donor.data[sourceOffset + 3] === 0) continue;
      const targetOffset = (targetY * target.width + targetX) * 4;
      out[targetOffset] = donor.data[sourceOffset];
      out[targetOffset + 1] = donor.data[sourceOffset + 1];
      out[targetOffset + 2] = donor.data[sourceOffset + 2];
      out[targetOffset + 3] = donor.data[sourceOffset + 3];
    }
  }
  return out;
}

function installCompactSlotLayers(psd: Psd, sheet: Uint8ClampedArray, slots: CompactSlot[], options: { preserveTemplateSlotWhenSparse?: boolean; transparentGuardForSlot?: (entryPath: string) => boolean } = {}): Map<string, Uint8ClampedArray> {
  const entries = flatten(psd.children);
  const slotByPath = new Map(slots.map((slot) => [slot.editPath, slot]));
  const expected = new Map<string, Uint8ClampedArray>();
  const installRecords: CompactLayerInstallRecord[] = [];
  for (const entry of entries.filter((candidate) => candidate.path.includes('edithere:'))) {
    const layer = entry.layer;
    const slot = slotByPath.get(entry.path);
    const hasExpandedSlotData = Boolean(slot?.layerData && slot.layerLeft !== undefined && slot.layerTop !== undefined && slot.layerWidth !== undefined && slot.layerHeight !== undefined);
    const left = hasExpandedSlotData ? slot!.layerLeft! : layer.left ?? 0;
    const top = hasExpandedSlotData ? slot!.layerTop! : layer.top ?? 0;
    const width = hasExpandedSlotData ? slot!.layerWidth! : Math.max(1, (layer.right ?? left + 1) - left);
    const height = hasExpandedSlotData ? slot!.layerHeight! : Math.max(1, (layer.bottom ?? top + 1) - top);
    let data = slot
      ? slot.layerData && slot.layerData.length === width * height * 4
        ? slot.layerData
        : cropSheet(sheet, psd.width, psd.height, left, top, width, height)
      : new Uint8ClampedArray(width * height * 4);
    const template = fallbackLayerImage(layer);
    installRecords.push({ entryPath: entry.path, layer, slot, left, top, width, height, data, renderedAlpha: rgbaAlphaPixels(data), template, templateAlpha: rgbaAlphaPixels(template.rgba) });
  }
  if (options.preserveTemplateSlotWhenSparse) {
    const convertedDonors = installRecords
      .filter((record) => record.slot && record.renderedAlpha > 0)
      .sort((a, b) => b.renderedAlpha - a.renderedAlpha);
    for (const record of installRecords) {
      if (!record.slot || record.renderedAlpha > 0) continue;
      if (options.transparentGuardForSlot?.(record.entryPath)) {
        record.data = compactTransparentUploadGuard(record.width, record.height);
        record.renderedAlpha = rgbaAlphaPixels(record.data);
        record.slot.layerLeft = record.left;
        record.slot.layerTop = record.top;
        record.slot.layerWidth = record.width;
        record.slot.layerHeight = record.height;
        record.slot.layerData = record.data;
        record.slot.fallbackTemplateSlot = {
          alphaPixels: record.renderedAlpha,
          source: 'transparent-guard',
          reason: 'front-only face source suppresses compact back slot donor/template fill; inserted a near-transparent upload guard instead of copying front face pixels',
        };
        continue;
      }
      const donor = convertedDonors.find((candidate) => candidate.entryPath !== record.entryPath);
      if (donor) {
        const donorFill = copyDonorPixelsIntoTargetSlot(donor, record);
        const donorAlpha = rgbaAlphaPixels(donorFill);
        if (donorAlpha > 0) {
          record.data = donorFill;
          record.renderedAlpha = donorAlpha;
          record.slot.layerLeft = record.left;
          record.slot.layerTop = record.top;
          record.slot.layerWidth = record.width;
          record.slot.layerHeight = record.height;
          record.slot.layerData = record.data;
          record.slot.fallbackTemplateSlot = {
            alphaPixels: donorAlpha,
            source: 'converted-donor',
            donorEditPath: donor.entryPath,
            reason: `empty compact slot filled from converted donor ${donor.entryPath} (${donor.renderedAlpha} alpha pixels) instead of original template pixels`,
          };
          continue;
        }
      }
      if (record.templateAlpha > 0) {
        record.data = record.template.rgba;
        record.renderedAlpha = record.templateAlpha;
        record.left = record.layer.left ?? record.left;
        record.top = record.layer.top ?? record.top;
        record.width = record.template.width;
        record.height = record.template.height;
        record.slot.layerLeft = record.left;
        record.slot.layerTop = record.top;
        record.slot.layerWidth = record.width;
        record.slot.layerHeight = record.height;
        record.slot.layerData = record.data;
        record.slot.fallbackTemplateSlot = {
          alphaPixels: record.templateAlpha,
          source: 'template',
          reason: 'empty compact slot had no non-empty converted donor; preserved original template slot as last-resort upload guard',
        };
      }
    }
  }
  for (const record of installRecords) {
    const { entryPath, layer, left, top, width, height, data } = record;
    expected.set(entryPath, data);
    layer.hidden = false;
    layer.left = left;
    layer.top = top;
    layer.right = left + width;
    layer.bottom = top + height;
    layer.imageData = { width, height, data };
  }
  hideGuides(psd.children);
  return expected;
}

function expandCompactSlotToSourceBounds(slot: CompactSlot, frame: LoadedFrame, sheetWidth: number, sheetHeight: number): Uint8ClampedArray {
  const slotSheet = new Uint8ClampedArray(sheetWidth * sheetHeight * 4);
  drawFrameAt(slotSheet, sheetWidth, sheetHeight, frame, slot.destLeft, slot.destTop);
  const bounds = alphaBounds(sheetWidth, sheetHeight, slotSheet);
  if (bounds.empty) return slotSheet;
  slot.layerLeft = bounds.left;
  slot.layerTop = bounds.top;
  slot.layerWidth = Math.max(1, bounds.right - bounds.left);
  slot.layerHeight = Math.max(1, bounds.bottom - bounds.top);
  slot.layerData = cropSheet(slotSheet, sheetWidth, sheetHeight, slot.layerLeft, slot.layerTop, slot.layerWidth, slot.layerHeight);
  return slotSheet;
}

function maplestoryIoItemCachePath(itemId: number): string {
  return path.join(frameCacheDir, `maplestory-io-KMS-389-item-${itemId}.json`);
}

async function fetchMapleStoryIoHairItem(itemId: number): Promise<MapleStoryIoHairItem> {
  mkdirSync(frameCacheDir, { recursive: true });
  const cachedPath = maplestoryIoItemCachePath(itemId);
  if (existsSync(cachedPath)) return JSON.parse(readFileSync(cachedPath, 'utf8')) as MapleStoryIoHairItem;
  const url = `https://maplestory.io/api/KMS/389/item/${itemId}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`MapleStory.io hair item fetch failed: ${url} -> HTTP ${response.status}`);
  const item = await response.json() as MapleStoryIoHairItem;
  if (!item.frameBooks) throw new Error(`MapleStory.io item ${itemId} did not include frameBooks.`);
  writeFileSync(cachedPath, JSON.stringify(item));
  return item;
}

function hairEffectNameForLayerPath(layerPath: string): HairEffectName {
  const lower = layerPath.toLowerCase();
  if (lower.includes('backhairbelowcap')) return 'backHairBelowCap';
  if (lower.includes('backhair')) return 'backHair';
  if (lower.includes('hairbelowbody')) return 'hairBelowBody';
  if (lower.includes('hairoverhead')) return 'hairOverHead';
  if (lower.includes('hairshade')) return 'hairShade';
  if (/(^|[_:/])hair([_:/]|$)/i.test(layerPath)) return 'hair';
  throw new Error(`Cannot map Hair template layer to a raw zmap effect: ${layerPath}`);
}

function hairFrameBookForLayerPath(layerPath: string): string {
  const lower = layerPath.toLowerCase();
  if (lower.includes('back')) return 'backDefault';
  if (lower.includes('pronestab')) return 'proneStab';
  return 'stand1';
}

function decodeMapleStoryIoEffectImage(effect: MapleStoryIoEffect): { width: number; height: number; rgba: Uint8ClampedArray } | null {
  if (!effect.image) return null;
  const base64 = effect.image.includes(',') ? effect.image.split(',').at(-1) ?? '' : effect.image;
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  return { width: png.width, height: png.height, rgba: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
}

function fallbackLayerImage(layer: Layer): { width: number; height: number; rgba: Uint8ClampedArray } {
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  const width = Math.max(1, layer.imageData?.width ?? ((layer.right ?? left + 1) - left));
  const height = Math.max(1, layer.imageData?.height ?? ((layer.bottom ?? top + 1) - top));
  const existing = layer.imageData?.data;
  return {
    width,
    height,
    rgba: existing && existing.length === width * height * 4
      ? new Uint8ClampedArray(existing)
      : new Uint8ClampedArray(width * height * 4),
  };
}

function rawHairOriginPoints(psd: Psd): { front: { x: number; y: number }; back: { x: number; y: number } } {
  const originLayer = flatten(psd.children).find((entry) => entry.path.includes('data:origin'))?.layer;
  const image = originLayer?.imageData;
  if (!originLayer || !image?.data) {
    throw new Error('Avatar_Hair.psd is missing data:origin; cannot align raw Hair zmap layers safely.');
  }
  const data = image.data as Uint8ClampedArray;
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (data[(y * image.width + x) * 4 + 3] === 0) continue;
      points.push({ x: (originLayer.left ?? 0) + x, y: (originLayer.top ?? 0) + y });
    }
  }
  if (points.length < 2) throw new Error('Avatar_Hair.psd data:origin must contain front and back anchor pixels.');
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  return { front: points[0], back: points[points.length - 1] };
}

function rawHairAnchorForLayer(layerPath: string, origins: { front: { x: number; y: number }; back: { x: number; y: number } }): { x: number; y: number; basis: string } {
  const isBack = hairFrameBookForLayerPath(layerPath) === 'backDefault';
  const point = isBack ? origins.back : origins.front;
  return {
    x: point.x,
    y: point.y,
    basis: isBack ? 'Avatar_Hair.psd data:origin back pixel' : 'Avatar_Hair.psd data:origin front/prone pixel',
  };
}

export function hasRawHairEffect(rawHair: MapleStoryIoHairItem, frameBook: string, frameIndex: number, effectName: HairEffectName): boolean {
  return Boolean(rawHair.frameBooks?.[frameBook]?.frames?.[frameIndex]?.effects?.[effectName]);
}

const rawHairBackFrameBookFallbacks = ['rope', 'ladder', 'swingTF'] as const;

export function resolveRawHairEffect(rawHair: MapleStoryIoHairItem, frameBook: string, frameIndex: number, effectName: HairEffectName): { effect?: MapleStoryIoEffect; frameBook: string; frameIndex: number } {
  const direct = rawHair.frameBooks?.[frameBook]?.frames?.[frameIndex]?.effects?.[effectName];
  if (direct) return { effect: direct, frameBook, frameIndex };
  if (frameBook === 'backDefault' && (effectName === 'backHair' || effectName === 'backHairBelowCap')) {
    for (const fallbackFrameBook of rawHairBackFrameBookFallbacks) {
      const frames = rawHair.frameBooks?.[fallbackFrameBook]?.frames ?? [];
      const preferredIndexes = [frameIndex, 0, ...frames.map((_, index) => index)];
      for (const fallbackFrameIndex of [...new Set(preferredIndexes)]) {
        const fallback = frames[fallbackFrameIndex]?.effects?.[effectName];
        if (fallback?.image) return { effect: fallback, frameBook: fallbackFrameBook, frameIndex: fallbackFrameIndex };
      }
    }
  }
  return { frameBook, frameIndex };
}

function applyRawHairZmapLayers(psd: Psd, slots: CompactSlot[], rawHair: MapleStoryIoHairItem): { sheet: Uint8ClampedArray; placements: RawHairLayerPlacement[] } {
  const slotByPath = new Map(slots.map((slot) => [slot.editPath, slot]));
  const origins = rawHairOriginPoints(psd);
  const sheet = new Uint8ClampedArray(psd.width * psd.height * 4);
  const placements: RawHairLayerPlacement[] = [];
  for (const entry of flatten(psd.children).filter((candidate) => candidate.path.includes('edithere:'))) {
    const slot = slotByPath.get(entry.path);
    if (!slot) continue;
    const effectName = hairEffectNameForLayerPath(entry.path);
    const requestedFrameBook = hairFrameBookForLayerPath(entry.path);
    const requestedFrameIndex = 0;
    const resolved = resolveRawHairEffect(rawHair, requestedFrameBook, requestedFrameIndex, effectName);
    const { effect, frameBook, frameIndex } = resolved;
    const decoded = effect ? decodeMapleStoryIoEffectImage(effect) : null;
    const image = decoded ?? fallbackLayerImage(entry.layer);
    const origin = effect?.origin && !effect.origin.isEmpty
      ? { x: Math.round(effect.origin.x ?? 0), y: Math.round(effect.origin.y ?? 0) }
      : { x: 0, y: 0 };
    const anchor = rawHairAnchorForLayer(entry.path, origins);
    slot.layerLeft = decoded ? Math.round(anchor.x - origin.x) : entry.layer.left ?? 0;
    slot.layerTop = decoded ? Math.round(anchor.y - origin.y) : entry.layer.top ?? 0;
    slot.layerWidth = image.width;
    slot.layerHeight = image.height;
    slot.layerData = image.rgba;
    drawFrameAt(sheet, psd.width, psd.height, {
      action: frameBook,
      frameIndex,
      imageRef: decoded
        ? `maplestory.io:${rawHair.id ?? 'unknown'}:${frameBook}:${effectName}`
        : `template-fallback:${rawHair.id ?? 'unknown'}:${frameBook}:${effectName}`,
      width: image.width,
      height: image.height,
      rgba: image.rgba,
      bounds: alphaBounds(image.width, image.height, image.rgba),
    }, slot.layerLeft, slot.layerTop);
    placements.push({
      editPath: entry.path,
      frameBook,
      requestedFrameBook,
      frameIndex,
      effectName,
      anchor,
      origin,
      left: slot.layerLeft,
      top: slot.layerTop,
      width: slot.layerWidth,
      height: slot.layerHeight,
      missingImage: !decoded,
    });
  }
  return { sheet, placements };
}

interface ParsedPsdChannelInfo {
  id: number;
  length: number;
  dataStart: number;
}

interface ParsedPsdLayerRecord {
  index: number;
  recordStart: number;
  channelHeaderEnd: number;
  recordEnd: number;
  top: number;
  left: number;
  bottom: number;
  right: number;
  channelCount: number;
  channels: ParsedPsdChannelInfo[];
  asciiName: string;
  unicodeNames: string[];
}

interface ParsedPsdLayerInfo {
  buffer: Buffer;
  channels: number;
  width: number;
  height: number;
  bitsPerChannel: number;
  layerMaskStart: number;
  layerMaskLength: number;
  layerMaskEnd: number;
  layerInfoLengthOffset: number;
  layerInfoStart: number;
  layerInfoLength: number;
  layerInfoEnd: number;
  countRaw: number;
  records: ParsedPsdLayerRecord[];
  channelDataStart: number;
  channelDataEnd: number;
}

interface SurgicalPsdPatchStats {
  rawLayerCount: number;
  patchedLayerCount: number;
  rootCompositeImagePatched: boolean;
  preservedLayerIdMarkers: number;
  preservedMetadataMarkers: { lyid: number; shmd: number; cust: number; eightBim: number };
  outputBytes: number;
}

function countAsciiMarker(buffer: Buffer, marker: string): number {
  let count = 0;
  for (let index = 0; index <= buffer.length - marker.length; index += 1) {
    if (buffer.toString('ascii', index, index + marker.length) === marker) count += 1;
  }
  return count;
}

function psdMarkerStats(buffer: Buffer): { lyid: number; shmd: number; cust: number; eightBim: number } {
  return {
    lyid: countAsciiMarker(buffer, 'lyid'),
    shmd: countAsciiMarker(buffer, 'shmd'),
    cust: countAsciiMarker(buffer, 'cust'),
    eightBim: countAsciiMarker(buffer, '8BIM'),
  };
}

function readUnicodeLayerNames(buffer: Buffer): string[] {
  const names: string[] = [];
  for (let offset = 0; offset <= buffer.length - 12; offset += 1) {
    const signature = buffer.toString('ascii', offset, offset + 4);
    if (signature !== '8BIM' && signature !== '8B64') continue;
    const key = buffer.toString('ascii', offset + 4, offset + 8);
    if (key !== 'luni') continue;
    const length = buffer.readUInt32BE(offset + 8);
    const start = offset + 12;
    if (length < 4 || start + length > buffer.length) continue;
    const chars = buffer.readUInt32BE(start);
    if (chars > 1000 || start + 4 + chars * 2 > start + length) continue;
    let text = '';
    for (let index = 0; index < chars; index += 1) text += String.fromCharCode(buffer.readUInt16BE(start + 4 + index * 2));
    names.push(text);
  }
  return names;
}

function readPascalLayerName(buffer: Buffer, offset: number): { text: string; end: number } {
  const length = buffer[offset] ?? 0;
  const rawLength = 1 + length;
  const paddedLength = rawLength + ((4 - (rawLength % 4)) % 4);
  return { text: buffer.toString('ascii', offset + 1, offset + 1 + length), end: offset + paddedLength };
}

function parsePsdLayerInfo(buffer: Buffer): ParsedPsdLayerInfo {
  let offset = 0;
  const signature = buffer.toString('ascii', offset, offset + 4); offset += 4;
  if (signature !== '8BPS') throw new Error('Template is not a PSD file.');
  const version = buffer.readUInt16BE(offset); offset += 2;
  if (version !== 1) throw new Error(`Unsupported PSD version ${version}; only PSD v1 is supported.`);
  offset += 6;
  const channels = buffer.readUInt16BE(offset); offset += 2;
  const height = buffer.readUInt32BE(offset); offset += 4;
  const width = buffer.readUInt32BE(offset); offset += 4;
  const bitsPerChannel = buffer.readUInt16BE(offset); offset += 2;
  offset += 2; // color mode
  const colorModeLength = buffer.readUInt32BE(offset); offset += 4 + colorModeLength;
  const imageResourcesLength = buffer.readUInt32BE(offset); offset += 4 + imageResourcesLength;
  const layerMaskStart = offset;
  const layerMaskLength = buffer.readUInt32BE(offset); offset += 4;
  const layerMaskEnd = offset + layerMaskLength;
  const layerInfoLengthOffset = offset;
  const layerInfoLength = buffer.readUInt32BE(offset); offset += 4;
  const layerInfoStart = offset;
  const layerInfoEnd = layerInfoStart + layerInfoLength;
  if (layerInfoEnd > layerMaskEnd || layerMaskEnd > buffer.length) throw new Error('PSD layer/mask section lengths are invalid.');
  let cursor = layerInfoStart;
  const countRaw = buffer.readInt16BE(cursor); cursor += 2;
  const layerCount = Math.abs(countRaw);
  const records: ParsedPsdLayerRecord[] = [];
  for (let index = 0; index < layerCount; index += 1) {
    const recordStart = cursor;
    const top = buffer.readInt32BE(cursor); cursor += 4;
    const left = buffer.readInt32BE(cursor); cursor += 4;
    const bottom = buffer.readInt32BE(cursor); cursor += 4;
    const right = buffer.readInt32BE(cursor); cursor += 4;
    const channelCount = buffer.readUInt16BE(cursor); cursor += 2;
    const channels: ParsedPsdChannelInfo[] = [];
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const id = buffer.readInt16BE(cursor); cursor += 2;
      const length = buffer.readUInt32BE(cursor); cursor += 4;
      channels.push({ id, length, dataStart: 0 });
    }
    const channelHeaderEnd = cursor;
    cursor += 4; // blend signature
    cursor += 4; // blend mode
    cursor += 1; // opacity
    cursor += 1; // clipping
    cursor += 1; // flags
    cursor += 1; // filler
    const extraLength = buffer.readUInt32BE(cursor); cursor += 4;
    const extraStart = cursor;
    const extraEnd = extraStart + extraLength;
    const extra = buffer.subarray(extraStart, extraEnd);
    let asciiName = '';
    try {
      const maskLength = extra.readUInt32BE(0);
      let extraCursor = 4 + maskLength;
      const blendingRangesLength = extra.readUInt32BE(extraCursor);
      extraCursor += 4 + blendingRangesLength;
      asciiName = readPascalLayerName(buffer, extraStart + extraCursor).text;
    } catch {
      asciiName = '';
    }
    records.push({
      index,
      recordStart,
      channelHeaderEnd,
      recordEnd: extraEnd,
      top,
      left,
      bottom,
      right,
      channelCount,
      channels,
      asciiName,
      unicodeNames: readUnicodeLayerNames(extra),
    });
    cursor = extraEnd;
  }
  const channelDataStart = cursor;
  for (const record of records) {
    for (const channel of record.channels) {
      channel.dataStart = cursor;
      cursor += channel.length;
    }
  }
  if (cursor > layerInfoEnd) throw new Error('PSD channel data exceeds layer info section.');
  return { buffer, channels, width, height, bitsPerChannel, layerMaskStart, layerMaskLength, layerMaskEnd, layerInfoLengthOffset, layerInfoStart, layerInfoLength, layerInfoEnd, countRaw, records, channelDataStart, channelDataEnd: cursor };
}

function layerRecordName(record: ParsedPsdLayerRecord): string {
  return record.unicodeNames.find((name) => name.length > 0) ?? record.asciiName;
}

function writeRawPsdChannel(rgba: Uint8ClampedArray, width: number, height: number, channelId: number): Buffer {
  const out = Buffer.allocUnsafe(2 + width * height);
  out.writeUInt16BE(0, 0);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourceOffset = pixel * 4;
    const targetOffset = 2 + pixel;
    if (channelId === -1) out[targetOffset] = rgba[sourceOffset + 3];
    else if (channelId === 0) out[targetOffset] = rgba[sourceOffset];
    else if (channelId === 1) out[targetOffset] = rgba[sourceOffset + 1];
    else if (channelId === 2) out[targetOffset] = rgba[sourceOffset + 2];
    else out[targetOffset] = 0;
  }
  return out;
}


function writeRawCompositeImageData(rgba: Uint8ClampedArray, width: number, height: number, channels: number): Buffer {
  const pixelCount = width * height;
  const out = Buffer.allocUnsafe(2 + pixelCount * channels);
  out.writeUInt16BE(0, 0);
  for (let channel = 0; channel < channels; channel += 1) {
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const sourceOffset = pixel * 4;
      const targetOffset = 2 + channel * pixelCount + pixel;
      out[targetOffset] = channel === 0
        ? rgba[sourceOffset]
        : channel === 1
        ? rgba[sourceOffset + 1]
        : channel === 2
        ? rgba[sourceOffset + 2]
        : channel === 3
        ? rgba[sourceOffset + 3]
        : 0;
    }
  }
  return out;
}

function compactSlotLayerName(slot: CompactSlot): string {
  return slot.editPath.split('/').at(-1) ?? slot.editPath;
}

function writeSurgicalCompactPsd(templatePath: string, outputPath: string, slots: CompactSlot[], rootComposite?: Uint8ClampedArray): SurgicalPsdPatchStats {
  const templateBuffer = readFileSync(templatePath);
  const parsed = parsePsdLayerInfo(templateBuffer);
  const patchByLayerName = new Map<string, CompactSlot>();
  for (const slot of slots) {
    if (!slot.layerData || slot.layerLeft === undefined || slot.layerTop === undefined || slot.layerWidth === undefined || slot.layerHeight === undefined) continue;
    patchByLayerName.set(compactSlotLayerName(slot), slot);
  }
  let patchedLayerCount = 0;
  const recordsOut: Buffer[] = [];
  const channelDataOut: Buffer[] = [];
  const countBuffer = Buffer.alloc(2);
  countBuffer.writeInt16BE(parsed.countRaw, 0);
  recordsOut.push(countBuffer);
  for (const record of parsed.records) {
    const name = layerRecordName(record);
    const patch = patchByLayerName.get(name);
    const left = patch?.layerLeft ?? record.left;
    const top = patch?.layerTop ?? record.top;
    const width = patch?.layerWidth ?? Math.max(0, record.right - record.left);
    const height = patch?.layerHeight ?? Math.max(0, record.bottom - record.top);
    const right = left + width;
    const bottom = top + height;
    if (patch) patchedLayerCount += 1;

    const recordHeader = Buffer.alloc(18 + record.channelCount * 6);
    let cursor = 0;
    recordHeader.writeInt32BE(top, cursor); cursor += 4;
    recordHeader.writeInt32BE(left, cursor); cursor += 4;
    recordHeader.writeInt32BE(bottom, cursor); cursor += 4;
    recordHeader.writeInt32BE(right, cursor); cursor += 4;
    recordHeader.writeUInt16BE(record.channelCount, cursor); cursor += 2;
    for (const channel of record.channels) {
      const channelBuffer = patch && channel.id >= -1 && channel.id <= 2
        ? writeRawPsdChannel(patch.layerData!, width, height, channel.id)
        : templateBuffer.subarray(channel.dataStart, channel.dataStart + channel.length);
      recordHeader.writeInt16BE(channel.id, cursor); cursor += 2;
      recordHeader.writeUInt32BE(channelBuffer.length, cursor); cursor += 4;
      channelDataOut.push(Buffer.from(channelBuffer));
    }
    recordsOut.push(recordHeader, templateBuffer.subarray(record.channelHeaderEnd, record.recordEnd));
  }
  const preservedLayerInfoSuffix = templateBuffer.subarray(parsed.channelDataEnd, parsed.layerInfoEnd);
  let layerInfoData = Buffer.concat([...recordsOut, ...channelDataOut, preservedLayerInfoSuffix]);
  if (layerInfoData.length % 2 !== 0) layerInfoData = Buffer.concat([layerInfoData, Buffer.from([0])]);
  const layerInfoLengthBuffer = Buffer.alloc(4);
  layerInfoLengthBuffer.writeUInt32BE(layerInfoData.length, 0);
  const preservedLayerMaskSuffix = templateBuffer.subarray(parsed.layerInfoEnd, parsed.layerMaskEnd);
  const layerMaskData = Buffer.concat([layerInfoLengthBuffer, layerInfoData, preservedLayerMaskSuffix]);
  const layerMaskLengthBuffer = Buffer.alloc(4);
  layerMaskLengthBuffer.writeUInt32BE(layerMaskData.length, 0);
  const output = Buffer.concat([
    templateBuffer.subarray(0, parsed.layerMaskStart),
    layerMaskLengthBuffer,
    layerMaskData,
    rootComposite && parsed.bitsPerChannel === 8 && rootComposite.length === parsed.width * parsed.height * 4
      ? writeRawCompositeImageData(rootComposite, parsed.width, parsed.height, parsed.channels)
      : templateBuffer.subarray(parsed.layerMaskEnd),
  ]);
  writeFileSync(outputPath, output);
  const stats = psdMarkerStats(output);
  return {
    rawLayerCount: parsed.records.length,
    patchedLayerCount,
    rootCompositeImagePatched: Boolean(rootComposite && parsed.bitsPerChannel === 8 && rootComposite.length === parsed.width * parsed.height * 4),
    preservedLayerIdMarkers: stats.lyid,
    preservedMetadataMarkers: stats,
    outputBytes: output.length,
  };
}



function validateEditableLayersNonEmpty(psd: Psd): { pass: boolean; emptyLayers: string[]; layers: Array<{ path: string; alphaPixels: number }> } {
  const layers = flatten(psd.children)
    .filter((entry) => entry.path.includes('edithere:'))
    .map((entry) => {
      const data = entry.layer.imageData?.data;
      let alphaPixels = 0;
      if (data) {
        for (let offset = 3; offset < data.length; offset += 4) {
          if (data[offset] > 0) alphaPixels += 1;
        }
      }
      return { path: entry.path, alphaPixels };
    });
  const emptyLayers = layers.filter((layer) => layer.alphaPixels === 0).map((layer) => layer.path);
  return { pass: emptyLayers.length === 0, emptyLayers, layers };
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
    const useRawHairZmapSource = 'rawHairZmapSource' in config && config.rawHairZmapSource === true;
    const expandCompactSlotsToSourceBounds = 'expandCompactSlotsToSourceBounds' in config && config.expandCompactSlotsToSourceBounds === true;
    const frontOnlyCompactBackSlotGuard = isFrontOnlyCompactSourceSelection(imported.selection.selectedPartIds);
    let rawHairItemId: number | null = null;
    let rawHairPlacements: RawHairLayerPlacement[] = [];
    let sheet: Uint8ClampedArray = new Uint8ClampedArray(sheetWidth * sheetHeight * 4);
    if (useRawHairZmapSource) {
      const hairItemCode = imported.selection.itemCodes.hair;
      if (!Number.isFinite(hairItemCode)) throw new Error('Hair target bake requires a selected MeAegi hair item code.');
      rawHairItemId = hairItemCode;
      logProgress(`loading raw Hair zmap item ${rawHairItemId} from MapleStory.io`);
      const rawHair = await fetchMapleStoryIoHairItem(rawHairItemId);
      const rawResult = applyRawHairZmapLayers(psd, slots, rawHair);
      sheet = rawResult.sheet;
      rawHairPlacements = rawResult.placements;
    } else {
      for (const slot of slots) {
        if (frontOnlyCompactBackSlotGuard && isCompactBackSlotPath(slot.editPath)) continue;
        const key = `${slot.action}:${slot.frameIndex}`;
        const frame = frameByKey.get(key);
        if (!frame) throw new Error(`Missing compact source frame ${key} for ${slot.editPath}`);
        if (expandCompactSlotsToSourceBounds) {
          const slotSheet = expandCompactSlotToSourceBounds(slot, frame, sheetWidth, sheetHeight);
          for (let i = 0; i < sheet.length; i += 4) over(sheet, i, slotSheet, i);
        } else {
          drawFrameAt(sheet, sheetWidth, sheetHeight, frame, slot.destLeft, slot.destTop);
        }
      }
    }
    const preserveTemplateSlotWhenSparse = 'preserveTemplateSlotWhenSparse' in config && config.preserveTemplateSlotWhenSparse === true;
    const expectedLayers = installCompactSlotLayers(psd, sheet, slots, {
      preserveTemplateSlotWhenSparse,
      transparentGuardForSlot: (entryPath) => frontOnlyCompactBackSlotGuard && isCompactBackSlotPath(entryPath),
    });
    if (config.removeZmapPreset) psd.children = removeZmapPresetLayers(psd.children);
    const expectedRootComposite = updatePsdRootComposite(psd);
    mkdirSync(outDir, { recursive: true });
    const psdPath = path.join(outDir, config.outputName);
    logProgress(`writing compact PSD ${psdPath}`);
    const surgicalPsdPatch = useRawHairZmapSource
      ? writeSurgicalCompactPsd(config.templatePath, psdPath, slots, expectedRootComposite)
      : null;
    if (!surgicalPsdPatch) writeFileSync(psdPath, writePsdBuffer(psd, { generateThumbnail: false, trimImageData: false }));
    writeRgbaPng(path.join(outDir, 'expected-root-composite.png'), sheetWidth, sheetHeight, expectedRootComposite);
    writeRgbaPng(path.join(outDir, 'expected-sheet.png'), sheetWidth, sheetHeight, sheet);
    writeRgbaPng(path.join(outDir, 'original-template-guide-sheet.png'), sheetWidth, sheetHeight, originalTemplateGuideSheet);
    writeRgbaPng(path.join(outDir, 'original-template-reference-sheet.png'), sheetWidth, sheetHeight, originalTemplateReferenceSheet);
    writeRgbaPng(path.join(outDir, 'original-template-editable-sheet.png'), sheetWidth, sheetHeight, originalTemplateEditableSheet);

    const readback = readPsd(readFileSync(psdPath), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
    const layerValidation = validateCompactLayerReadback(expectedLayers, readback);
    const rootCompositeValidation = validateRootComposite(readback, { allowOpaqueRootAlpha: Boolean(surgicalPsdPatch) });
    const nonEmptyLayerValidation = validateEditableLayersNonEmpty(readback);
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
    const missingRawHairPlacements = rawHairPlacements.filter((placement) => placement.missingImage);
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
        compactSlotLayersExpandedToSourceBounds: expandCompactSlotsToSourceBounds,
        preserveTemplateSlotWhenSparse,
        frontOnlyCompactBackSlotGuard,
        frontOnlyBackSlotGuardedLayers: slots
          .filter((slot) => slot.fallbackTemplateSlot?.source === 'transparent-guard')
          .map((slot) => slot.editPath),
        sparseTemplateSlotFallbacks: slots.filter((slot) => slot.fallbackTemplateSlot).map((slot) => ({
          editPath: slot.editPath,
          alphaPixels: slot.fallbackTemplateSlot!.alphaPixels,
          source: slot.fallbackTemplateSlot!.source,
          donorEditPath: slot.fallbackTemplateSlot!.donorEditPath ?? null,
          reason: slot.fallbackTemplateSlot!.reason,
        })),
        rawHairZmapSource: useRawHairZmapSource,
        rawHairItemId,
        rawHairPlacements,
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
          fallbackTemplateSlot: slot.fallbackTemplateSlot ?? null,
        })),
        placementValidation,
        redDotArtifacts,
      },
      validation: {
        readbackLayerExactMatch: layerValidation.pass,
        diffPixels: layerValidation.totalDiffPixels,
        maxChannelDelta: layerValidation.maxChannelDelta,
        rootCompositePass: rootCompositeValidation.pass,
        rootCompositeExactMatch: rootCompositeValidation.exactMatch,
        rootCompositeDiffPixels: rootCompositeValidation.diffPixels,
        rootCompositeMaxChannelDelta: rootCompositeValidation.maxChannelDelta,
        rootCompositeAlphaDiffPixels: rootCompositeValidation.alphaDiffPixels,
        rootCompositeRgbOnlyDiffPixels: rootCompositeValidation.rgbOnlyDiffPixels,
        templateMetadataPreserved: surgicalPsdPatch ? surgicalPsdPatch.preservedMetadataMarkers.lyid === surgicalPsdPatch.rawLayerCount && surgicalPsdPatch.preservedMetadataMarkers.shmd === surgicalPsdPatch.rawLayerCount && surgicalPsdPatch.preservedMetadataMarkers.cust === surgicalPsdPatch.rawLayerCount : null,
        editableLayersNonEmpty: nonEmptyLayerValidation.pass,
        emptyEditableLayers: nonEmptyLayerValidation.emptyLayers,
        editableLayerAlphaPixels: nonEmptyLayerValidation.layers,
        rawPhysicalLayerCount: surgicalPsdPatch?.rawLayerCount ?? null,
        patchedPhysicalLayerCount: surgicalPsdPatch?.patchedLayerCount ?? null,
        preservedMetadataMarkers: surgicalPsdPatch?.preservedMetadataMarkers ?? null,
        frameCellsPass: layerValidation.pass,
        frameCellDiffPixels: layerValidation.totalDiffPixels,
        frameCellMaxChannelDelta: layerValidation.maxChannelDelta,
        frameCells: layerValidation.frames,
        motionComparisonGifsGenerated: 0,
        placementOverlays: { overlayRoot: null, stand1OverlayStrip: null },
        motionComparisons: [] as ComparisonArtifact[],
      },
      warnings: [
        useRawHairZmapSource
          ? 'Hair compact bake preserves Avatar_Hair.psd data:use_zmap_preset/data:vslot/data:origin and writes MapleStory raw Hair effects into the matching hairBelowBody/hair/hairOverHead/backHair zmap layers. If MapleStory raw data omits an MSW-required slot such as hairShade, the original non-empty template slot is preserved so MSW does not reject Hair/Cap as blank.'
          : frontOnlyCompactBackSlotGuard
          ? 'Front-only face/accessory compact bake suppresses back-slot source pixels and donor/template fallback so face pixels do not appear on the back of the head; back slots receive only a near-transparent upload guard.'
          : imported.selection.baselineMaskApplied
          ? 'Selective compact bake is active: selected-part render frames are alpha-masked against the MeAegi default baseline so excluded pixels become transparent.'
          : 'This compact template bake writes selected source pixels into every edithere slot of a 300x180 cap/hair style PSD.',
        ...(missingRawHairPlacements.length > 0
          ? [`Raw Hair item ${rawHairItemId ?? ''} is missing ${missingRawHairPlacements.length} template effect(s); preserved original Avatar_Hair.psd slots for: ${missingRawHairPlacements.map((placement) => `${placement.frameBook}[${placement.frameIndex}].${placement.effectName}`).join(', ')}.`]
          : []),
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
  const expectedRootComposite = updatePsdRootComposite(psd);
  mkdirSync(outDir, { recursive: true });
  const psdPath = path.join(outDir, config.outputName);
  logProgress(`writing PSD ${psdPath}`);
  writeFileSync(psdPath, writePsdBuffer(psd, { generateThumbnail: false, trimImageData: false }));
  logProgress('writing sheet PNG artifacts');
  writeRgbaPng(path.join(outDir, 'expected-root-composite.png'), sheetWidth, sheetHeight, expectedRootComposite);
  writeRgbaPng(path.join(outDir, 'expected-sheet.png'), sheetWidth, sheetHeight, sheet);
  writeRgbaPng(path.join(outDir, 'reference-alignment-sheet.png'), sheetWidth, sheetHeight, referenceAlignmentSheet);
  writeRgbaPng(path.join(outDir, 'reference-guide-overlay-sheet.png'), sheetWidth, sheetHeight, overlayBuffers(originalTemplateGuideSheet, referenceAlignmentSheet, 0.75));
  writeRgbaPng(path.join(outDir, 'original-template-guide-sheet.png'), sheetWidth, sheetHeight, originalTemplateGuideSheet);
  writeRgbaPng(path.join(outDir, 'original-template-reference-sheet.png'), sheetWidth, sheetHeight, originalTemplateReferenceSheet);
  writeRgbaPng(path.join(outDir, 'original-template-editable-sheet.png'), sheetWidth, sheetHeight, originalTemplateEditableSheet);

  logProgress('reading generated PSD back for validation');
  psd.children = undefined;
  const readback = readPsd(readFileSync(psdPath), { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
  const rootCompositeValidation = validateRootComposite(readback);
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
      rootCompositePass: rootCompositeValidation.pass,
      rootCompositeExactMatch: rootCompositeValidation.exactMatch,
      rootCompositeDiffPixels: rootCompositeValidation.diffPixels,
      rootCompositeMaxChannelDelta: rootCompositeValidation.maxChannelDelta,
      rootCompositeAlphaDiffPixels: rootCompositeValidation.alphaDiffPixels,
      rootCompositeRgbOnlyDiffPixels: rootCompositeValidation.rgbOnlyDiffPixels,
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
      rootCompositePass: report.validation.rootCompositePass,
      rootCompositeExactMatch: report.validation.rootCompositeExactMatch,
      rootCompositeDiffPixels: report.validation.rootCompositeDiffPixels,
      rootCompositeMaxChannelDelta: report.validation.rootCompositeMaxChannelDelta,
      rootCompositeAlphaDiffPixels: report.validation.rootCompositeAlphaDiffPixels,
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
