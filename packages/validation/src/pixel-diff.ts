import type { ValidationFrameResult, ValidationPolicy } from '../../core/src/index.js';

export interface DiffableFrame {
  action: string;
  frameIndex: number;
  width: number;
  height: number;
  rgbaBuffer: Uint8ClampedArray;
}

function frameKey(frame: Pick<DiffableFrame, 'action' | 'frameIndex'>): string {
  return `${frame.action}:${frame.frameIndex}`;
}

export function diffFrames(expected: DiffableFrame, actual: DiffableFrame, policy: ValidationPolicy): ValidationFrameResult {
  const expectedLength = expected.width * expected.height * 4;
  const actualLength = actual.width * actual.height * 4;
  if (expected.width !== actual.width || expected.height !== actual.height || expected.rgbaBuffer.length !== expectedLength || actual.rgbaBuffer.length !== actualLength) {
    return { action: actual.action, frameIndex: actual.frameIndex, pass: false, diffPixels: Math.max(expected.width * expected.height, actual.width * actual.height), diffRatio: 1, maxChannelDelta: 255 };
  }
  let diffPixels = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < expected.rgbaBuffer.length; i += 4) {
    let pixelDifferent = false;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(expected.rgbaBuffer[i + c] - actual.rgbaBuffer[i + c]);
      if (delta > policy.maxChannelDelta) pixelDifferent = true;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
    }
    if (pixelDifferent) diffPixels += 1;
  }
  const pixelCount = expected.width * expected.height;
  return {
    action: actual.action,
    frameIndex: actual.frameIndex,
    pass: diffPixels <= policy.diffPixels && maxChannelDelta <= policy.maxChannelDelta,
    diffPixels,
    diffRatio: pixelCount === 0 ? 0 : diffPixels / pixelCount,
    maxChannelDelta,
  };
}

function duplicateFrameResult(frame: DiffableFrame): ValidationFrameResult {
  return {
    action: frame.action,
    frameIndex: frame.frameIndex,
    pass: false,
    diffPixels: Math.max(1, frame.width * frame.height),
    diffRatio: 1,
    maxChannelDelta: 255,
  };
}

function missingFrameResult(frame: DiffableFrame): ValidationFrameResult {
  return {
    action: frame.action,
    frameIndex: frame.frameIndex,
    pass: false,
    diffPixels: frame.width * frame.height,
    diffRatio: 1,
    maxChannelDelta: 255,
  };
}

function duplicates(frames: DiffableFrame[]): DiffableFrame[] {
  const seen = new Set<string>();
  const duplicateFrames: DiffableFrame[] = [];
  for (const frame of frames) {
    const key = frameKey(frame);
    if (seen.has(key)) duplicateFrames.push(frame);
    seen.add(key);
  }
  return duplicateFrames;
}

export function validateRenderedFrames(expected: DiffableFrame[], actual: DiffableFrame[], policy: ValidationPolicy) {
  const duplicateResults = [...duplicates(expected), ...duplicates(actual)].map(duplicateFrameResult);
  const expectedByKey = new Map(expected.map((frame) => [frameKey(frame), frame]));
  const actualByKey = new Map(actual.map((frame) => [frameKey(frame), frame]));
  const keys = [...new Set([...expectedByKey.keys(), ...actualByKey.keys()])].sort();
  const results = keys.map((key) => {
    const expectedFrame = expectedByKey.get(key);
    const actualFrame = actualByKey.get(key);
    if (!expectedFrame && actualFrame) return missingFrameResult(actualFrame);
    if (expectedFrame && !actualFrame) return missingFrameResult(expectedFrame);
    return diffFrames(expectedFrame!, actualFrame!, policy);
  });
  const frames = [...duplicateResults, ...results];
  return { policy, pass: frames.every((result) => result.pass), frames };
}
