import type { SourceAdapter, SourceAdapterInput } from './types.js';
import type { SourceFrameSet } from '../../core/src/index.js';

function requireNonEmpty(value: unknown, field: string, fileName: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Image source file ${fileName} is missing required ${field}.`);
  return value;
}

function requireFrameIndex(value: unknown, fileName: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`Image source file ${fileName} is missing required non-negative integer frameIndex.`);
  return Number(value);
}

export class ImageUploadAdapter implements SourceAdapter {
  readonly id = 'image-upload';
  readonly supportsPublicNoLogin = false;

  load(input: SourceAdapterInput): SourceFrameSet {
    const files = input.files ?? [];
    if (input.completeDetectedAnimationRange !== true) {
      throw new Error('Image source adapter requires completeDetectedAnimationRange=true from the discovery stage before conversion.');
    }
    const normalizedFiles = files.map((file) => ({
      ...file,
      partId: requireNonEmpty(file.partId, 'partId', file.name),
      action: requireNonEmpty(file.action, 'action', file.name),
      frameIndex: requireFrameIndex(file.frameIndex, file.name),
    }));
    const partIds = [...new Set(normalizedFiles.map((file) => file.partId))];
    const actions = [...new Set(normalizedFiles.map((file) => file.action))];
    return {
      id: input.id,
      sourceKind: 'image-upload',
      assets: normalizedFiles.map((file, index) => ({
        id: `${input.id}:asset-${index + 1}`,
        kind: 'image-upload',
        label: file.name,
        uri: file.imageRef,
        provenance: { acquiredAt: new Date().toISOString(), publicNoLogin: false, userProvided: true, notes: 'Strict image-upload adapter: part/action/frame metadata supplied by discovery stage.' },
        metadata: input.metadata ?? {},
      })),
      parts: partIds.map((partId) => ({ id: partId, label: partId, category: 'user-provided', assetIds: [], metadata: {} })),
      frames: normalizedFiles.map((file, index) => ({
        id: `${input.id}:frame-${index + 1}`,
        action: file.action,
        frameIndex: file.frameIndex,
        partId: file.partId,
        assetId: `${input.id}:asset-${index + 1}`,
        imageRef: file.imageRef,
        width: file.width,
        height: file.height,
      })),
      actions,
      completeDetectedAnimationRange: true,
      metadata: { ...(input.metadata ?? {}), completenessProvenance: 'caller-certified-discovery' },
    };
  }
}
