import type { CanonicalFrame, NormalizedFrameSet, SourceFrameSet } from './types.js';

export interface ImageLoaderResult { width: number; height: number; rgbaBuffer: Uint8ClampedArray }
export type ImageLoader = (imageRef: string) => Promise<ImageLoaderResult> | ImageLoaderResult;

export async function normalizeSourceFrameSet(source: SourceFrameSet, loadImage: ImageLoader): Promise<NormalizedFrameSet> {
  const frames: CanonicalFrame[] = [];
  for (const frame of source.frames) {
    const loaded = await loadImage(frame.imageRef);
    frames.push({
      id: frame.id,
      action: frame.action,
      frameIndex: frame.frameIndex,
      partId: frame.partId,
      rgbaBuffer: loaded.rgbaBuffer,
      width: loaded.width,
      height: loaded.height,
      anchor: frame.anchor ?? { x: 0, y: 0, origin: 'top-left' },
      bounds: { left: 0, top: 0, right: loaded.width, bottom: loaded.height },
      durationMs: frame.durationMs,
    });
  }
  const maxWidth = Math.max(0, ...frames.map((frame) => frame.width));
  const maxHeight = Math.max(0, ...frames.map((frame) => frame.height));
  return {
    id: `${source.id}:normalized`,
    sourceFrameSetId: source.id,
    coordinateSpace: { origin: 'top-left', width: maxWidth, height: maxHeight, scale: 1 },
    frames,
    actions: [...source.actions],
    policies: {
      scale: { kind: 'exact-no-resample', factor: 1 },
      alpha: { kind: 'preserve-straight-alpha' },
      color: { kind: 'srgb-rgba' },
    },
  };
}
