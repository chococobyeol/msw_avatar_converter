import type { MappingPlan, SourceFrameSet, TargetPartId, ValidationPolicy } from './types.js';

export const exactRgbaPolicy: ValidationPolicy = { kind: 'exact-rgba', diffPixels: 0, maxChannelDelta: 0 };

export const allowedTargetPartIds: TargetPartId[] = [
  'cap-a1', 'cap-a2', 'cap-ani', 'cap-b', 'cap-c1', 'cap-c2', 'cap-d', 'cap-e', 'cap-f', 'cap-g',
  'cape', 'cape-balloon', 'gloves', 'hair', 'longcoat', 'pants', 'shoes',
];

export function isTargetPartId(value: unknown): value is TargetPartId {
  return typeof value === 'string' && (allowedTargetPartIds as string[]).includes(value);
}

export function assertEveryPartMapped(source: SourceFrameSet, mappings: MappingPlan[]): void {
  const sourceIds = new Set(source.parts.map((part) => part.id));
  const mapped = new Map<string, string[]>();
  for (const mapping of mappings) {
    for (const partId of mapping.sourcePartIds) {
      if (!sourceIds.has(partId)) throw new Error(`Mapping ${mapping.id} references unknown source part: ${partId}`);
      mapped.set(partId, [...(mapped.get(partId) ?? []), mapping.id]);
    }
  }
  const missing = source.parts.filter((part) => !mapped.has(part.id));
  if (missing.length > 0) {
    throw new Error(`Every source part must be mapped before export. Missing: ${missing.map((part) => part.id).join(', ')}`);
  }
  const duplicated = [...mapped.entries()].filter(([, ids]) => ids.length > 1);
  if (duplicated.length > 0) {
    throw new Error(`Source parts must not be mapped more than once. Duplicates: ${duplicated.map(([partId, ids]) => `${partId}(${ids.join(',')})`).join(', ')}`);
  }
}

export function assertCompleteAnimationRange(source: SourceFrameSet): void {
  if (!source.completeDetectedAnimationRange) throw new Error('Source frame set does not cover the complete detected animation range.');
  const sourcePartIds = source.parts.map((part) => part.id);
  for (const action of source.actions) {
    const frameIndexes = [...new Set(source.frames.filter((frame) => frame.action === action).map((frame) => frame.frameIndex))];
    if (frameIndexes.length === 0) throw new Error(`Missing frames for action: ${action}`);
    for (const partId of sourcePartIds) {
      for (const frameIndex of frameIndexes) {
        if (!source.frames.some((frame) => frame.action === action && frame.frameIndex === frameIndex && frame.partId === partId)) {
          throw new Error(`Missing frame for action=${action}, frameIndex=${frameIndex}, part=${partId}`);
        }
      }
    }
  }
}

export function validateMappingsForExport(source: SourceFrameSet, mappings: MappingPlan[]): void {
  assertCompleteAnimationRange(source);
  assertEveryPartMapped(source, mappings);
  const allSourcePartIds = source.parts.map((part) => part.id).sort().join('\u0000');
  for (const mapping of mappings) {
    if (!isTargetPartId(mapping.targetPartId)) throw new Error(`Mapping ${mapping.id} targets an unknown MSW part: ${String(mapping.targetPartId)}`);
    if (!mapping.userConfirmedAt) throw new Error(`Mapping ${mapping.id} is not user-confirmed.`);
    if (mapping.sourcePartIds.length === 0) throw new Error(`Mapping ${mapping.id} has no source parts.`);
    if (mapping.mode === 'part' && mapping.sourcePartIds.length !== 1) throw new Error(`Part mapping ${mapping.id} must contain exactly one source part.`);
    if (mapping.mode === 'group' && mapping.sourcePartIds.length < 2) throw new Error(`Group mapping ${mapping.id} must contain two or more source parts.`);
    if (mapping.mode === 'whole-avatar' && [...mapping.sourcePartIds].sort().join('\u0000') !== allSourcePartIds) {
      throw new Error(`Whole-avatar mapping ${mapping.id} must contain every source part exactly once.`);
    }
  }
}
