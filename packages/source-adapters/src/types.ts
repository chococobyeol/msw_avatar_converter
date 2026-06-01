import type { SourceFrameSet } from '../../core/src/index.js';

export interface SourceAdapterInput {
  id: string;
  label: string;
  uri?: string;
  files?: Array<{ name: string; imageRef: string; width: number; height: number; partId?: string; action?: string; frameIndex?: number }>;
  /** True only after the caller/discovery stage has enumerated every detected action/frame for every source part. */
  completeDetectedAnimationRange?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SourceAdapter {
  readonly id: string;
  readonly supportsPublicNoLogin: boolean;
  load(input: SourceAdapterInput): Promise<SourceFrameSet> | SourceFrameSet;
}
