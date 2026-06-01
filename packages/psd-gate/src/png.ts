import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

export interface PixelDataLike {
  width: number;
  height: number;
  data: ArrayLike<number> & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };
}

export function writePixelDataPng(file: string, imageData: PixelDataLike | undefined): boolean {
  if (!imageData?.data) return false;
  if (!(imageData.data instanceof Uint8Array) && !(imageData.data instanceof Uint8ClampedArray)) return false;
  const png = new PNG({ width: imageData.width, height: imageData.height });
  png.data = Buffer.from(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
  writeFileSync(file, PNG.sync.write(png));
  return true;
}

export function diffPixelData(a: PixelDataLike | undefined, b: PixelDataLike | undefined) {
  if (!a || !b || !a.data || !b.data || a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) {
    return { comparable: false, diffPixels: null, diffRatio: null, maxChannelDelta: null };
  }
  let diffPixels = 0;
  let maxChannelDelta = 0;
  const pixelCount = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    let pixelDifferent = false;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(a.data[i + c] - b.data[i + c]);
      if (delta !== 0) pixelDifferent = true;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
    }
    if (pixelDifferent) diffPixels += 1;
  }
  return { comparable: true, diffPixels, diffRatio: pixelCount === 0 ? 0 : diffPixels / pixelCount, maxChannelDelta };
}
