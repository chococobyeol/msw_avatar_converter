# Test Spec — MSW Avatar PSD Converter MVP

## Purpose

Verify that the implementation satisfies `.omx/plans/prd-msw-avatar-converter.md` and the deep-interview spec without silently weakening the core requirements: template-derived PSD output, every-part user mapping, pixel golden-match validation, image-input flexibility, complete animation/action/frame coverage, and manual PSD review before upload.

## Test Strategy

### G0 PSD Roundtrip Gate Tests

Artifacts required before product work expands:

- Original and roundtripped PSDs for all 17 `avatartemplate/*.psd` files.
- Original and roundtripped manifests with dimensions, channels, color mode, layer/group tree, and editable target layers.
- Layer tree diff for every PSD.
- Composite PNGs and numeric composite diff reports.
- Manual open/checklist result for representative PSDs.
- Backend decision record.

Pass criteria:

- dimensions/channels/color mode unchanged for all templates;
- layer tree and editable regions preserved or deviations documented harmless;
- composite diff exact by default, or numeric tolerance recorded with rationale;
- representative PSDs are manually openable/reviewable.

Planned command:

```bash
npm run psd:roundtrip
```

### Unit Tests

Cover:

- `SourceAsset` / `SourceFrameSet` schema validation.
- `NormalizedFrameSet` / `CanonicalFrame` creation.
- frame indexing and action ordering.
- `ScalePolicy`, `AlphaPolicy`, `ColorPolicy`, `ValidationPolicy`.
- every-source-part mapping requirement.
- one-to-any target mapping.
- multi-source grouping into one target part.
- whole-avatar insertion plan.
- placement math and anchor application.
- pixel diff exact match, threshold match, mismatch reports.

Planned command:

```bash
npm run test:unit
```

### Integration Tests

Cover:

1. User-uploaded frame images → `SourceFrameSet` → mapping plan → converted preview → diff report.
2. Public MeAegi/public-image fixture → `SourceFrameSet` without login/bypass, including all detected actions/animations/frames.
3. Template manifest generation from all local PSDs.
4. Conversion job generates PSDs from template-derived outputs.
5. Export review bundle contains:
   - PSDs
   - `mapping-plan.json`
   - `validation-report.json`
   - preview PNGs
   - diff PNGs
   - template inventory reference
   - validation policy
   - `manual-review-checklist.md`
   - `human-signoff.json`
6. Preview and export consume the same canonical buffers and mapping plan.
7. Representative MVP cody fixture set is selected by the implementation team, documented in `fixtures/mvp-cody-set.md`, and validation results are shown to the user.

Planned command:

```bash
npm run test:integration
```

### E2E UI Tests

Core flow:

1. Import image/MeAegi fixture.
2. Confirm source parts and **all detected action/animation frames** are visible.
3. Attempt export before mapping every part; expect blocked state.
4. Map every source part to target MSW parts.
5. Group multiple source parts into a single target part.
6. Enable whole-avatar insertion for a target part.
7. Preview converted animation.
8. Run validation across every detected animation/action/frame and inspect diff report.
9. Export review bundle.

Planned command:

```bash
npm run test:e2e
```

### Visual / Golden-Match Tests

Primary correctness gate is buffer-level golden-match, not arbitrary page screenshots.

Required environment doc:

- `docs/validation-environment.md` must record OS/container, Node, browser/Playwright, image library versions, fonts/render assumptions, and snapshot update policy.

Golden-match expectations:

- Exact RGBA match by default after canonical normalization.
- Any tolerance must be numeric and recorded in `fixtures/validation-policy.json`.
- Reports include frame action, frame index, diff pixel count, diff ratio, max delta, and diff image path.

Planned commands:

```bash
npm run fixtures:validate
npm run test:visual   # only in pinned environment
```

### Manual Review Tests

For representative exported PSDs:

- Open PSD in Photoshop or compatible editor.
- Confirm expected layers/regions are present and reviewable.
- Confirm preview PNGs and mapping JSON match intent.
- Complete `manual-review-checklist.md`.
- If MSW upload is manually tested, record result; automated upload is out of scope.

## Acceptance Matrix

| Requirement | Evidence |
|---|---|
| all 17 templates inventoried | template manifest + inventory doc |
| PSD backend selected by evidence | G0 decision record |
| every part must be mapped | unit + e2e blocked export test |
| arbitrary source-to-target part mapping | unit + e2e mapping tests |
| grouping/whole-avatar mode | unit + integration + e2e tests |
| source and converted animation preview | e2e screenshots/video + canonical frame assertions across all detected animations/actions/frames |
| pixel golden-match | fixture validation report + diff images for every animation/action/frame |
| template-derived PSD export | integration test + manual PSD open |
| manual review before upload | review bundle + checklist/signoff |
| no automated upload/accounts/deployment | absence from implementation + docs |
| future AI seam only | adapter interface tests/docs; no AI implementation |
| implementation-chosen MVP cody fixtures | `fixtures/mvp-cody-set.md` + user-visible validation result summary |
| complete animation range | tests fail when any detected source action/animation/frame lacks converted output or diff result |

## Quality Gates Before Completion Claim

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run fixtures:validate
npm run psd:roundtrip
npm run export:review-bundle
```

If `npm run test:visual` is claimed, it must run only inside the pinned validation environment.
