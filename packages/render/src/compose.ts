import type { CanonicalFrame, MappingPlan, NormalizedFrameSet } from '../../core/src/index.js';

export interface RenderedFrame {
  action: string;
  frameIndex: number;
  width: number;
  height: number;
  rgbaBuffer: Uint8ClampedArray;
  sourceFrameIds: string[];
}

export function blankFrame(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4);
}

export function alphaCompositePixel(dst: Uint8ClampedArray, dstOffset: number, src: Uint8ClampedArray, srcOffset: number): void {
  const srcA = src[srcOffset + 3] / 255;
  if (srcA <= 0) return;
  const dstA = dst[dstOffset + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c++) {
    const srcC = src[srcOffset + c] / 255;
    const dstC = dst[dstOffset + c] / 255;
    dst[dstOffset + c] = Math.round(((srcC * srcA) + (dstC * dstA * (1 - srcA))) / outA * 255);
  }
  dst[dstOffset + 3] = Math.round(outA * 255);
}

export function blitFrame(target: Uint8ClampedArray, targetWidth: number, targetHeight: number, source: CanonicalFrame, x: number, y: number): void {
  for (let sy = 0; sy < source.height; sy++) {
    const ty = sy + y;
    if (ty < 0 || ty >= targetHeight) continue;
    for (let sx = 0; sx < source.width; sx++) {
      const tx = sx + x;
      if (tx < 0 || tx >= targetWidth) continue;
      const srcOffset = (sy * source.width + sx) * 4;
      const dstOffset = (ty * targetWidth + tx) * 4;
      alphaCompositePixel(target, dstOffset, source.rgbaBuffer, srcOffset);
    }
  }
}

export function renderMappingPreview(normalized: NormalizedFrameSet, mappings: MappingPlan[], width = normalized.coordinateSpace.width, height = normalized.coordinateSpace.height): RenderedFrame[] {
  const actionFrameKeys = [...new Set(normalized.frames.map((frame) => `${frame.action}:${frame.frameIndex}`))]
    .map((key) => {
      const [action, frameIndex] = key.split(':');
      return { action, frameIndex: Number(frameIndex) };
    })
    .sort((a, b) => a.action.localeCompare(b.action) || a.frameIndex - b.frameIndex);

  return actionFrameKeys.map(({ action, frameIndex }) => {
    const rgbaBuffer = blankFrame(width, height);
    const sourceFrameIds: string[] = [];
    for (const mapping of mappings) {
      const mappedFrames = normalized.frames.filter((frame) => frame.action === action && frame.frameIndex === frameIndex && mapping.sourcePartIds.includes(frame.partId));
      for (const frame of mappedFrames) {
        sourceFrameIds.push(frame.id);
        blitFrame(rgbaBuffer, width, height, frame, mapping.placement.offsetX, mapping.placement.offsetY);
      }
    }
    return { action, frameIndex, width, height, rgbaBuffer, sourceFrameIds };
  });
}
