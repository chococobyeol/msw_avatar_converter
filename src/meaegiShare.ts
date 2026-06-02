export const MEAEGI_GET_SHARE_ACTION_ID = '10eba6e9f9badb7a6412e4a2a9db55024c24a323';
export const MEAEGI_BUILD_HASH_ACTION_ID = 'f6097e19afeedc0220b15f769fbcae478c540a0f';

const slotLabels: Record<string, string> = {
  skin: '피부',
  face: '성형',
  hair: '헤어',
  cap: '모자',
  faceDeco: '얼굴장식',
  eyeDeco: '눈장식',
  earring: '귀고리',
  dress: '상의/한벌옷',
  pants: '하의',
  shoes: '신발',
  glove: '장갑',
  cape: '망토',
  weapon: '무기',
  subWeapon: '방패/보조무기',
};

const itemIconHashMap = [
  ['B', 'A', 'D', 'C', 'F', 'E', 'H', 'G', 'J', 'I'],
  ['O', 'P', 'M', 'N', 'K', 'L', 'I', 'J', 'G', 'H'],
  ['H', 'G', 'F', 'E', 'D', 'C', 'B', 'A', 'P', 'O'],
  ['L', 'K', 'J', 'I', 'P', 'O', 'N', 'M', 'D', 'C'],
  ['C', 'D', 'A', 'B', 'G', 'H', 'E', 'F', 'K', 'L'],
  ['P', 'O', 'N', 'M', 'L', 'K', 'J', 'I', 'H', 'G'],
  ['E', 'E', '?', '?', '?', 'A', 'E', 'E', 'E', 'E'],
  ['K', 'K', 'K', 'K', 'K', 'K', '?', '?', '?', '?'],
];

const meaegiActions = [
  ['기본(한손)', 'A00', 2],
  ['기본(두손)', 'A01', 2],
  ['걷기(한손)', 'A02', 3],
  ['걷기(두손)', 'A03', 3],
  ['엎드리기', 'A04', 0],
  ['날기', 'A05', 1],
  ['점프', 'A06', 0],
  ['앉기', 'A07', 0],
  ['사다리', 'A08', 1],
  ['밧줄', 'A09', 1],
  ['치유', 'A10', 2],
  ['전투 대기', 'A11', 2],
  ['엎드려 찌르기', 'A12', 1],
  ['스윙O1', 'A13', 2],
  ['스윙O2', 'A14', 2],
  ['스윙O3', 'A15', 2],
  ['스윙OF', 'A16', 3],
  ['스윙P1', 'A17', 2],
  ['스윙P2', 'A18', 2],
  ['스윙PF', 'A19', 3],
  ['스윙T1', 'A20', 2],
  ['스윙T2', 'A21', 2],
  ['스윙T3', 'A22', 2],
  ['스윙TF', 'A23', 3],
  ['찌르기O1', 'A24', 1],
  ['찌르기O2', 'A25', 1],
  ['찌르기OF', 'A26', 2],
  ['찌르기T1', 'A27', 2],
  ['찌르기T2', 'A28', 2],
  ['찌르기TF', 'A29', 3],
  ['쏘기(활)', 'A30', 2],
  ['쏘기(석궁)', 'A31', 4],
  ['쏘기F', 'A32', 2],
  ['유령', 'A33', 0],
  ['걷기(유령)', 'A34', 3],
  ['기본(유령)', 'A35', 2],
  ['점프(유령)', 'A36', 0],
  ['엎드리기(유령)', 'A37', 1],
  ['사다리(유령)', 'A38', 1],
  ['밧줄(유령)', 'A39', 1],
  ['날기(유령)', 'A40', 1],
  ['앉기(유령)', 'A41', 0],
] as const;

const hiddenEmotionFrames = [
  {
    label: '눈깜빡임(E06)',
    emotionCode: 'E06',
    lastFrameIndex: 2,
    includedInDefaultImport: false,
    note: 'MeAegi UI does not expose this emotion label, and MVP PSD bake excludes expression/blink frames to avoid unnatural fixed-loop blinking.',
  },
] as const;

export function mapleItemIconUrl(itemCode: number): string {
  const digits = String(Math.max(0, Math.min(Number(itemCode) || 0, 99_999_999))).padStart(8, '0');
  const hash = [...digits].map((digit, index) => itemIconHashMap[7 - index][Number(digit)]).join('');
  return `https://avatar.maplestory.nexon.com/ItemIcon/${hash}.png`;
}

function meaegiBeautyIconUrl(slot: string, itemCode: number): string {
  return `https://storage.meaegi.com/storage/images/dressing-room/${slot}/${String(itemCode).padStart(8, '0')}.png`;
}

function partIconUrl(slot: string, itemCode: number): string | undefined {
  if (['hair', 'face', 'skin'].includes(slot)) return meaegiBeautyIconUrl(slot, itemCode);
  return mapleItemIconUrl(itemCode);
}

function characterLookFrameUrl(hash: string, actionCode: string, frameIndex: number): string {
  const params = new URLSearchParams({
    width: '180',
    height: '180',
    x: '90',
    y: '140',
    action: `${actionCode}.${frameIndex}`,
  });
  return `https://open.api.nexon.com/static/maplestory/character/look/${hash}?${params.toString()}`;
}

export interface MeaegiAvatarPayload {
  itemCode?: Record<string, number>;
  hash?: string;
  itemPrism?: Record<string, unknown>;
  [key: string]: unknown;
}

export function extractMeaegiShareId(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    return url.searchParams.get('share')?.trim() || trimmed;
  } catch {
    return trimmed;
  }
}

export function parseMeaegiFlight(text: string): MeaegiAvatarPayload {
  const payloadIndex = text.indexOf('1:{');
  if (payloadIndex < 0) throw new Error('MeAegi share payload was not found in the server response.');
  const hashMatch = text.slice(0, payloadIndex).match(/2:T[0-9a-fA-F]+,([\s\S]*)$/);
  const payload = JSON.parse(text.slice(payloadIndex + 2).trim()) as MeaegiAvatarPayload;
  if (hashMatch && payload.hash === '$2') payload.hash = hashMatch[1];
  return payload;
}

export function buildMeaegiShareImport(share: string, avatar: MeaegiAvatarPayload) {
  if (!avatar.itemCode || Object.keys(avatar.itemCode).length === 0) throw new Error('MeAegi share did not contain itemCode data.');
  const parts = Object.entries(avatar.itemCode)
    .filter(([, code]) => Number.isFinite(code))
    .map(([slot, code]) => ({
      id: slot,
      label: `${slotLabels[slot] ?? slot} ${code}`,
      category: slot,
      itemCode: code,
      iconRef: partIconUrl(slot, code),
      prism: avatar.itemPrism?.[slot] ?? null,
    }));
  const actionFrameKeys = meaegiActions.flatMap(([label, actionCode, lastFrameIndex]) => Array.from({ length: lastFrameIndex + 1 }, (_, frameIndex) => ({ label, actionCode, frameIndex })));
  const frames = parts.flatMap((part) => actionFrameKeys.map(({ label, actionCode, frameIndex }) => ({
    action: label,
    frameIndex,
    partId: part.id,
    imageRef: avatar.hash ? characterLookFrameUrl(avatar.hash, actionCode, frameIndex) : `${share}:${part.id}:${actionCode}:${frameIndex}`,
  })));
  const renderImageUrl = avatar.hash ? `https://open.api.nexon.com/static/maplestory/Character/${avatar.hash}.png` : null;
  return {
    source: 'meaegi-share',
    share,
    avatar,
    parts,
    frames,
    diagnostics: {
      itemSlots: parts.length,
      actions: meaegiActions.map(([label, actionCode, lastFrameIndex]) => ({ label, actionCode, frameCount: lastFrameIndex + 1 })),
      hiddenEmotions: hiddenEmotionFrames.map(({ label, emotionCode, lastFrameIndex, includedInDefaultImport, note }) => ({ label, emotionCode, frameCount: lastFrameIndex + 1, includedInDefaultImport, note })),
      totalPartFrames: frames.length,
      totalActionFrames: actionFrameKeys.length,
      totalPoseActionFrames: actionFrameKeys.length,
      totalHiddenEmotionFrames: 0,
      renderImageUrl,
      warnings: [
        'Part preview thumbnails use item icons; worn per-part animation isolation is not complete yet.',
        'Character animation preview uses Nexon character/look frame URLs generated from the MeAegi share hash.',
        'Hidden blink emotion E06 is detected but excluded from default PSD bake because MSW avatar PSDs do not expose per-frame blink timing.',
        'Pixel-golden PSD parity still needs the real crop/alignment extractor and PSD writer integration.',
      ],
    },
  };
}
