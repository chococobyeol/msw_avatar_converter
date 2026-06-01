import type { SourceAdapter, SourceAdapterInput } from './types.js';
import type { SourceFrameSet } from '../../core/src/index.js';
import { ImageUploadAdapter } from './image-upload.js';

export class PublicMeAegiAdapter implements SourceAdapter {
  readonly id = 'public-meaegi';
  readonly supportsPublicNoLogin = true;

  load(input: SourceAdapterInput): SourceFrameSet {
    // MVP boundary: this adapter translates already-discovered public frame image refs into the generic model.
    // Page parsing/fetching stays outside core conversion and can evolve without leaking MeAegi shapes.
    const generic = new ImageUploadAdapter().load({ ...input, id: input.id });
    return { ...generic, sourceKind: 'public-meaegi', assets: generic.assets.map((asset) => ({ ...asset, kind: 'public-meaegi', provenance: { ...asset.provenance, publicNoLogin: true, userProvided: false } })) };
  }
}
