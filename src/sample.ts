export interface UiPart {
  id: string;
  label: string;
  category: string;
  color: string;
  itemCode?: number;
  iconRef?: string;
}

export interface UiFrame {
  action: string;
  frameIndex: number;
  partId: string;
  imageRef?: string;
}

export type UiMappingMode = 'part' | 'group' | 'whole-avatar';

export interface UiMappingInput {
  partId: string;
  targetPartId: string;
  mode: UiMappingMode;
  groupId: string;
  confirmed: boolean;
}

export interface UiValidationSummary {
  totalFrames: number;
  totalPartFrames: number;
  diffPixels: number;
  maxChannelDelta: number;
  pass: boolean;
  messages: string[];
}

export const targetParts = [
  'cap-a1', 'cap-a2', 'cap-ani', 'cap-b', 'cap-c1', 'cap-c2', 'cap-d', 'cap-e', 'cap-f', 'cap-g',
  'cape', 'cape-balloon', 'gloves', 'hair', 'longcoat', 'pants', 'shoes',
] as const;

export const aggregateTargetParts = ['cape', 'cape-balloon', 'longcoat'] as const;

export function isAggregateTargetPart(targetPartId: string): targetPartId is typeof aggregateTargetParts[number] {
  return (aggregateTargetParts as readonly string[]).includes(targetPartId);
}

export const sampleParts: UiPart[] = [
  { id: 'body', label: '상의/몸통', category: 'top', color: '#60a5fa' },
  { id: 'weapon', label: '무기', category: 'weapon', color: '#f97316' },
  { id: 'capeFx', label: '망토 이펙트', category: 'cape', color: '#a78bfa' },
];

export const sampleFrames: UiFrame[] = sampleParts.flatMap((part) =>
  ['stand', 'walk', 'jump', 'attack'].flatMap((action) =>
    [0, 1].map((frameIndex) => ({ action, frameIndex, partId: part.id })),
  ),
);

function frameKeys(frames: UiFrame[]): string[] {
  return [...new Set(frames.map((frame) => `${frame.action}:${frame.frameIndex}`))].sort();
}

export function defaultTargetForSourcePart(part: Pick<UiPart, 'id' | 'category'>): typeof targetParts[number] {
  const key = `${part.id} ${part.category}`.toLowerCase();
  if (key.includes('hair') || key.includes('헤어')) return 'hair';
  if (key.includes('cap') || key.includes('hat') || key.includes('모자')) return 'cap-a1';
  if (key.includes('pants') || key.includes('하의')) return 'pants';
  if (key.includes('shoes') || key.includes('신발')) return 'shoes';
  if (key.includes('glove') || key.includes('장갑') || key.includes('weapon') || key.includes('무기') || key.includes('subweapon') || key.includes('방패')) return 'gloves';
  if (key.includes('cape') || key.includes('망토')) return 'cape';
  return 'longcoat';
}

export function computeUiValidation(parts: UiPart[], frames: UiFrame[], mappings: UiMappingInput[]): UiValidationSummary {
  const expectedKeys = frameKeys(frames);
  const expectedPartIds = parts.map((part) => part.id);
  const mappedPartIds = mappings.map((mapping) => mapping.partId);
  const confirmed = mappings.length > 0 && mappings.every((mapping) => mapping.confirmed && targetParts.includes(mapping.targetPartId as typeof targetParts[number]));
  const messages: string[] = [];
  const missingParts = expectedPartIds.filter((partId) => !mappedPartIds.includes(partId)).length;
  const duplicateParts = mappedPartIds.length - new Set(mappedPartIds).size;
  const unknownParts = mappedPartIds.filter((partId) => !expectedPartIds.includes(partId)).length;
  const wholeAvatarRows = mappings.filter((mapping) => mapping.mode === 'whole-avatar');
  let wholeAvatarErrors = 0;
  if (wholeAvatarRows.length > 0) {
    const targetIds = new Set(wholeAvatarRows.map((mapping) => mapping.targetPartId));
    const wholeGroups = new Set(wholeAvatarRows.map((mapping) => mapping.groupId));
    if (wholeAvatarRows.length !== mappings.length) {
      wholeAvatarErrors += 1;
      messages.push('whole-avatar mode is an all-source bake: set every source row to whole-avatar, or use group mode for partial bundles.');
    }
    if (wholeGroups.size !== 1 || !wholeGroups.has('whole-avatar')) {
      wholeAvatarErrors += 1;
      messages.push('whole-avatar rows must share groupId "whole-avatar".');
    }
    if (targetIds.size !== 1) {
      wholeAvatarErrors += 1;
      messages.push('whole-avatar rows must share one target MSW part, e.g. cape or longcoat.');
    }
  }
  const groupSizes = new Map<string, number>();
  for (const mapping of mappings.filter((mapping) => mapping.mode === 'group')) groupSizes.set(mapping.groupId, (groupSizes.get(mapping.groupId) ?? 0) + 1);
  const modeErrors = mappings.filter((mapping) => {
    if (mapping.mode === 'part') return Boolean(mapping.groupId);
    if (mapping.mode === 'group') return !mapping.groupId || (groupSizes.get(mapping.groupId) ?? 0) < 2;
    if (mapping.mode === 'whole-avatar') return mapping.groupId !== 'whole-avatar' || !isAggregateTargetPart(mapping.targetPartId);
    return true;
  }).length;
  const targetBuckets = new Map<string, UiMappingInput[]>();
  for (const mapping of mappings) targetBuckets.set(mapping.targetPartId, [...(targetBuckets.get(mapping.targetPartId) ?? []), mapping]);
  const duplicateTargetErrors = [...targetBuckets.entries()].filter(([targetPartId, rows]) => rows.length > 1 && !isAggregateTargetPart(targetPartId)).length;
  const aggregateModeErrors = mappings.filter((mapping) => mapping.mode === 'group' && !isAggregateTargetPart(mapping.targetPartId)).length;
  const partFrameCoverageErrors = expectedPartIds.reduce((sum, partId) => sum + expectedKeys.filter((key) => {
    const [action, frameIndex] = key.split(':');
    return !frames.some((frame) => frame.partId === partId && frame.action === action && frame.frameIndex === Number(frameIndex));
  }).length, 0);
  const semanticErrors = missingParts + duplicateParts + unknownParts + wholeAvatarErrors + modeErrors + duplicateTargetErrors + aggregateModeErrors + partFrameCoverageErrors;
  if (!confirmed) messages.push('Every source part must be confirmed before export.');
  if (missingParts) messages.push(`${missingParts} source part(s) are missing a mapping row.`);
  if (duplicateParts) messages.push(`${duplicateParts} duplicate mapping row(s) were found.`);
  if (unknownParts) messages.push(`${unknownParts} mapping row(s) reference unknown source parts.`);
  if (modeErrors) messages.push(`${modeErrors} mapping mode setting(s) are invalid.`);
  if (duplicateTargetErrors) messages.push(`${duplicateTargetErrors} non-aggregate target(s) have multiple source parts. Multiple-source mapping is only allowed for cape/cape-balloon/longcoat.`);
  if (aggregateModeErrors) messages.push(`${aggregateModeErrors} group mapping row(s) target non-aggregate parts. Use cape/cape-balloon/longcoat for grouped leftovers.`);
  if (partFrameCoverageErrors) messages.push(`${partFrameCoverageErrors} source part-frame coverage error(s) were found.`);
  const actualKeys = confirmed && semanticErrors === 0 ? expectedKeys : [];
  const missingFrames = expectedKeys.filter((key) => !actualKeys.includes(key)).length;
  const diffPixels = missingFrames + semanticErrors;
  if (missingFrames) messages.push(`${missingFrames} action frame(s) are not export-ready yet.`);
  return {
    totalFrames: expectedKeys.length,
    totalPartFrames: frames.length,
    diffPixels,
    maxChannelDelta: diffPixels > 0 ? 255 : 0,
    pass: confirmed && diffPixels === 0,
    messages: messages.length ? messages : ['Validation passed: exact RGBA diff 0 for current UI mapping model.'],
  };
}

export function computeSampleValidation(mappings: UiMappingInput[]): UiValidationSummary {
  return computeUiValidation(sampleParts, sampleFrames, mappings);
}
