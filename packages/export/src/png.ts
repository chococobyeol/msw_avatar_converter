import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

export function writeRgbaPng(file: string, width: number, height: number, rgbaBuffer: Uint8ClampedArray): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const png = new PNG({ width, height });
  png.data = Buffer.from(rgbaBuffer.buffer, rgbaBuffer.byteOffset, rgbaBuffer.byteLength);
  writeFileSync(file, PNG.sync.write(png));
}
