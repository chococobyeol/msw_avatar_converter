import { createCanvas, ImageData } from 'canvas';
import { initializeCanvas } from 'ag-psd';

let initialized = false;

export function ensureCanvasInitialized(): void {
  if (initialized) return;
  initializeCanvas(
    ((width: number, height: number) => createCanvas(width, height)) as any,
    ((width: number, height: number) => new ImageData(width, height)) as any,
  );
  initialized = true;
}
