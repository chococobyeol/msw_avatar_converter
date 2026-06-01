# PRD — MSW Avatar PSD Converter MVP

## Status

- Planning workflow: `$plan --consensus --direct`
- Requirements source: `.omx/specs/deep-interview-msw-avatar-converter.md`
- Consensus result: Architect `APPROVE_WITH_CHANGES`; Critic `APPROVE_WITH_REQUIRED_CHANGES`; required changes applied in this PRD/test-spec.
- No implementation has been performed.

## Requirements Summary

Build a local/single-user web UI that converts MapleStory/MeAegi/avatar-frame image inputs into MapleStory Worlds-uploadable PSDs by modifying the existing uploadable `avatartemplate/*.psd` files. The MVP must force the user to map **every** source part to a target MSW template part, support grouping multiple source parts into one target part, preview source and converted animations, export completed PSD review bundles, and validate frame-by-frame pixel golden-match before manual upload review. MVP animation coverage is the complete source animation range: if any source animation/action/frame cannot be converted and previewed, the conversion is incomplete. The implementation team must choose representative MVP validation cody sets and present the selected set plus results to the user.

## Evidence and Constraints

### Local evidence

- Repository currently has no app source; preflight found `.omx/` and `avatartemplate/` only.
- `avatartemplate/` contains 17 PSDs:
  - `Avatar_Cap_A1.psd`, `Avatar_Cap_A2.psd`, `Avatar_Cap_Ani.psd`, `Avatar_Cap_B.psd`, `Avatar_Cap_C1.psd`, `Avatar_Cap_C2.psd`, `Avatar_Cap_D.psd`, `Avatar_Cap_E.psd`, `Avatar_Cap_F.psd`, `Avatar_Cap_G.psd`
  - `Avatar_Cape.psd`, `Avatar_Cape_balloon.psd`, `Avatar_Gloves.psd`, `Avatar_Hair.psd`, `Avatar_Longcoat.psd`, `Avatar_Pants.psd`, `Avatar_Shoes.psd`
- `file avatartemplate/*.psd` reported:
  - Cap/hair templates: 300 x 180 RGB, 3x 8-bit channels
  - Cape/gloves/longcoat/pants/shoes templates: 2750 x 3500 RGB, 3x 8-bit channels

### External evidence used for planning

- MSW Creator Center has avatar item production/registration and part-specific guide pages for avatar items including cape, cap, top, shoes, gloves, pants, hair, and longcoat. Source: https://maplestoryworlds-creators.nexon.com/ko/docs?postId=590
- MSW MCP documentation exists, but MVP excludes automated MSW upload/ingame validation. Source: https://maplestoryworlds-creators.nexon.com/ko/docs?postId=1368
- Nexon Open API has application/API guide surfaces and terms/support areas. Source: https://openapi.nexon.com/ko/
- MeAegi dressing room exposes public item categories, many actions/expressions/motion controls, reports 16,353 items, and states it is based on Nexon Open API but is not an official Nexon site. Source: https://meaegi.com/dressing-room
- `ag-psd` exposes JavaScript PSD read/write APIs and layer canvas structures. Source: https://www.npmjs.com/package/ag-psd/v/7.0.0
- `psd-tools` documents low-level PSD/PSB read/write support but limited editing/compositing support for many Photoshop features. Source: https://psd-tools.readthedocs.io/
- Playwright visual comparison docs warn screenshot baselines depend on a consistent environment. Source: https://playwright.dev/docs/next/test-snapshots

## RALPLAN-DR Summary

### Principles

1. **Template-derived output only**: generated PSDs start from the provided uploadable MSW templates and replace/insert pixels; they do not synthesize unrelated PSD structures.
2. **Every mapping is user-owned**: the app may suggest defaults, but every source part must have explicit user-confirmed target MSW part mapping before export.
3. **One canonical frame contract**: import, preview, PSD export, and validation all consume the same normalized frame buffers and coordinate contract.
4. **Fidelity is measurable**: frame-by-frame pixel golden-match/diff is the primary acceptance signal; any tolerance must be numeric and recorded.
5. **Adapters over hardcoding**: image/MeAegi/Nexon/future-AI inputs are thin adapters into generic source assets; conversion logic is source-agnostic.
6. **Human review before upload**: generated PSDs are review bundles for manual inspection; MVP does not automate MSW upload or publication.

### Decision Drivers

1. **PSD roundtrip fidelity/uploadability risk**: wrong library choice can corrupt template structure or fail MSW upload.
2. **All-item and all-animation coverage via generic frames**: MeAegi item and animation breadth must be handled through generic image/frame composition, not per-item or per-animation hardcoding.
3. **Deterministic validation**: pixel matching must run from canonical buffers in a pinned environment to avoid false pass/fail results.

### Viable Options

#### Option A — TypeScript local web app + Node PSD pipeline

- Approach: Vite/React UI with local Node API/worker; `ag-psd` for PSD IO if template roundtrip passes; `sharp`/canvas for image normalization/compositing.
- Pros: one runtime; good browser/canvas preview fit; simple local packaging.
- Cons: PSD uploadability depends on `ag-psd` preserving enough template metadata; large PSD memory risk.

#### Option B — Python PSD service + TypeScript UI

- Approach: React UI calls a Python backend using `psd-tools`/Pillow/NumPy for PSD analysis/export and pixel diff.
- Pros: mature PSD inspection tools and NumPy diff workflows.
- Cons: two runtimes; `psd-tools` editing/compositing limitations still require proof.

#### Option C — Narrow synthesis: TypeScript product + swappable PSD adapter

- Approach: build UI/domain/validation in TypeScript, but put PSD IO behind a narrow adapter; first try `ag-psd`, switch only the adapter to Python/`psd-tools` or another proven backend if Phase 0 fails.
- Pros: manages PSD risk without rewriting product logic.
- Cons: adds some up-front interface work.

### Decision

Use **Option C as a narrow synthesis**, not a broad abstraction project: TypeScript local product and canonical frame pipeline, with PSD IO behind a small adapter. `ag-psd` is the first candidate only if the hard PSD roundtrip gate passes; otherwise the PSD adapter must be replaced before product work expands.

## Architecture

### Hard Gate: G0 PSD Roundtrip / Uploadability Evidence

**No UI/product implementation beyond minimal scaffold may proceed until G0 passes.**

G0 pass/fail artifacts:

- `artifacts/g0/original-template-manifest.json`
- `artifacts/g0/roundtrip-template-manifest.json`
- layer tree diff for every PSD
- dimensions/channels/depth/color mode comparison for every PSD
- resource blocks / metadata comparison where the chosen library exposes them
- original composite PNG and roundtrip composite PNG for every PSD
- numeric composite diff report: exact pixel diff count, diff ratio, max channel delta
- manual open result in Photoshop or compatible editor for a representative exported PSD set
- manual MSW Creator upload-readiness checklist result for representative PSDs
- chosen PSD backend decision record

G0 pass criteria:

- Every template can be opened and written by the candidate backend without changing dimensions/channels/color mode.
- Layer/group tree names and editable target layers are preserved or differences are explicitly proven harmless.
- Composite diff is zero by default; any non-zero diff needs numeric tolerance and user-visible rationale.
- Representative output PSDs are manually openable and reviewable.
- If MSW manual upload is tested during planning/execution, result is recorded; automated upload remains out of scope.

If G0 fails for `ag-psd`, test Python/`psd-tools` or another backend through the same adapter contract before continuing.

### Canonical Conversion / Normalization Contract

All source adapters, previews, PSD export, and validation must use the same canonical data:

- `SourceAsset`: original imported asset metadata and provenance.
- `SourceFrameSet`: generic, source-agnostic collection of **all detected actions/animations**, parts, and frames; incomplete action/frame capture means the conversion is not complete.
- `NormalizedFrameSet`: deterministic normalized frames ready for mapping/render/export.
- `CanonicalFrame`: `{ action, frameIndex, partId, rgbaBufferRef, width, height, anchor, bounds, duration? }`.
- `FrameCoordinateSpace`: origin, units, scale, target canvas, frame grid cell, and anchor reference.
- `FrameGrid`: target template frame/action layout.
- `Anchor`: placement point used by preview, export, and diff.
- `ScalePolicy`: exact scale/no resampling by default unless user-approved fixture policy says otherwise.
- `AlphaPolicy`: preserve alpha; define premultiplied/unpremultiplied handling once.
- `ColorPolicy`: fixed RGBA/sRGB conversion; no browser-dependent color transforms in validation.
- `ValidationPolicy`: exact match default; optional numeric tolerance recorded per fixture/policy.

Rules:

- Preview and PSD export consume `NormalizedFrameSet` and `MappingPlan`; they must not implement separate render logic.
- Pixel golden-match compares canonical converted preview buffers against canonical source/golden buffers.
- Any visual UI screenshot test is secondary; buffer-level diff is the product correctness gate.

### Source Adapter Boundary

Source adapters are thin translators only:

- `ImageUploadAdapter`: user-provided frames/images → `SourceAsset`/`SourceFrameSet`.
- `PublicMeAegiAdapter`: public no-login/no-bypass MeAegi pages/images → `SourceAsset`/`SourceFrameSet`.
- `NexonApiAdapter`: optional/future metadata adapter → `SourceAsset`/`SourceFrameSet`; not required for MVP unless it materially helps.
- Future AI adapter: image/person/object → `SourceAsset`/`SourceFrameSet`; not implemented in MVP.

No MeAegi/Nexon-specific shape may leak into core mapping, rendering, export, or validation.

### Proposed Modules

- `apps/web/`: React UI for import, action/frame preview, mapping matrix, target preview, diff viewer, export queue.
- `apps/local-api/`: local Node service for public image ingestion, PSD/template analysis, conversion jobs, filesystem export.
- `packages/core/`: source assets, canonical frames, target templates, mapping plans, conversion jobs.
- `packages/source-adapters/`: image upload, public MeAegi, future Nexon/AI adapters.
- `packages/template-adapters/`: PSD template manifest, reader/writer interface, G0 roundtrip validator.
- `packages/render/`: normalization, placement, composition, preview rendering, grouping/whole-avatar mode.
- `packages/validation/`: buffer-level pixel diff, golden-match reports, tolerance config, diff artifact writing.
- `fixtures/`: curated sample inputs, expected buffers, validation policies.
- `docs/`: template inventory, validation environment, manual review/upload checklist.

## Implementation Plan

### Phase 0 — Gates and evidence before product expansion

1. Create minimal repo scaffold only: package manager, TypeScript config, lint/test scripts, artifact directories.
2. Implement PSD inventory script for all `avatartemplate/*.psd`.
3. Run G0 PSD roundtrip gate against `ag-psd`.
4. If G0 fails, run the same gate against a Python/`psd-tools` adapter or another candidate backend.
5. Define `docs/validation-environment.md` with OS/container, Node, browser/Playwright, image library versions, fonts/render assumptions, and snapshot update policy.
6. Define `fixtures/validation-policy.json` with exact-match default and any explicit numeric tolerance.
7. Select representative MVP validation cody sets (target 3–5) covering common outfit, weapon/shield or non-MSW-native part mapping, multi-part grouping, whole-avatar insertion, and varied animation/action frames; write the selected set and rationale to `fixtures/mvp-cody-set.md` and show results in validation reports.
8. Implement a source-ingestion spike for one public MeAegi/public-image fixture and one user-uploaded image fixture.

### Phase 1 — Domain and adapter contracts

9. Implement `SourceAsset`, `SourceFrameSet`, `NormalizedFrameSet`, `CanonicalFrame`, `FrameCoordinateSpace`, `FrameGrid`, `Anchor`, policies, and schema validation.
10. Implement thin source adapters into generic contracts.
11. Implement `PsdTemplateReader`/`PsdTemplateWriter` interface selected by G0 evidence.
12. Implement template manifest generation from `avatartemplate/`.

### Phase 2 — User mapping and preview UI

13. Build import screen for public image/MeAegi URL and manual frame upload.
14. Build action/frame viewer for source parts and animations.
15. Build mapping matrix where every source part must be assigned to a target MSW template part.
16. Add grouping controls and whole-avatar insertion into a single target part such as cape/longcoat.
17. Add editable mapping recommendations/presets, but require explicit confirmation before export.

### Phase 3 — Render, export, and review bundle

18. Implement deterministic normalization and placement from canonical frames.
19. Render converted previews from the exact same canonical buffers and mapping plan used for PSD export.
20. Insert/replace pixels into template-derived PSD outputs.
21. Export a review bundle containing:
    - completed PSDs
    - `mapping-plan.json`
    - `validation-report.json`
    - preview PNGs
    - diff PNGs
    - template inventory reference
    - validation policy
    - `manual-review-checklist.md`
    - `human-signoff.json` with pending/approved/rejected status

### Phase 4 — Validation and QA hardening

22. Implement buffer-level pixel golden-match validator with exact-match default.
23. Add unit tests for canonical contracts, mapping validation, grouping, placement math, policies, and diff logic.
24. Add integration tests for PSD roundtrip, source fixture conversion, PSD export, and review bundle generation.
25. Add Playwright e2e tests for import → map every part → preview → validate → export.
26. Add visual snapshots only inside the pinned validation environment; they are secondary to canonical buffer diffs.
27. Document manual PSD review and upload workflow.

## Testable Acceptance Criteria

1. G0 PSD roundtrip gate has artifacts for all 17 PSD templates.
2. No product feature depending on PSD writing proceeds until G0 has passed or backend has been switched and passed.
3. The chosen PSD adapter preserves dimensions/channels/color mode and upload-relevant layer/template structure identified by inventory.
4. The canonical conversion contract is implemented and used by import, preview, export, and validation.
5. Public/no-login image sources and user-provided image inputs can produce `SourceFrameSet` fixtures containing all detected source actions/animations and frames.
6. The UI prevents export until every source part has a user-confirmed target MSW part.
7. The UI supports one-to-any target mapping, multi-source grouping, and whole-avatar insertion into one target part.
8. Source and converted animation previews cover the complete source animation/action/frame range and share the same indexing as validation; missing any source animation/action/frame is a failing conversion.
9. Pixel validation reports per-frame pass/fail, diff pixel count, diff ratio, max delta, and diff image path.
10. Accepted fixture conversions pass the recorded validation policy across all animations/actions/frames in each fixture.
10a. The implementation team selects representative MVP cody fixtures and presents the selected set, rationale, and validation results to the user.
11. Export produces PSDs plus the complete manual review/sign-off bundle.
12. Generated PSDs are manually inspectable before MSW upload; automated upload/publication is not implemented.
13. Future AI image-to-avatar conversion has adapter seams but no MVP implementation.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| PSD writer corrupts template metadata | G0 hard gate with structural/composite/manual-open artifacts; swappable PSD adapter. |
| Adapter abstraction slows MVP | Keep PSD interface narrow; no second backend unless G0 fails. |
| MeAegi/public source changes | User-uploaded image fallback; source adapters are thin and isolated. |
| “All items/all animations” hides edge cases | Generic frame pipeline; representative MVP cody selection by the implementation team; fixture expansion; no item-ID or animation hardcoding. |
| Pixel diff flakiness | Canonical buffer-level diff; pinned validation environment; visual snapshots secondary. |
| Large 2750x3500 PSD memory issues | Benchmark during G0; use workers and memory caps before broad UI work. |
| Legal/ToS ambiguity | No login/private-data bypass; human review before upload; automated publication out of scope. |
| Mapping UX overload | Editable presets, batch/group mapping, explicit per-part confirmation. |

## Verification Commands / Checks

Planned commands after implementation:

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:visual   # only in pinned validation environment
npm run fixtures:validate
npm run psd:roundtrip
npm run export:review-bundle
```

Manual checks:

- Open representative exported PSDs in Photoshop or compatible editor.
- Complete `manual-review-checklist.md`.
- If user chooses to test MSW upload manually, record the result in the review bundle.

## ADR

### Decision

Adopt a TypeScript local web architecture with a canonical frame pipeline and narrow swappable PSD adapter. Start with `ag-psd` only if G0 roundtrip passes; otherwise switch the PSD adapter before product implementation expands.

### Drivers

- Need template-derived PSD outputs.
- Need deterministic pixel validation.
- Need every-part user mapping and all-item coverage via generic frames.
- Need future AI conversion seams without implementing AI now.

### Alternatives considered

- Pure TypeScript/`ag-psd` from the start: fastest but too risky without uploadability/roundtrip proof.
- Python PSD service first: strong inspection path but adds two-runtime complexity and still has documented editing limitations.
- Full MSW automation/MCP upload: rejected because MVP requires manual PSD review and excludes automated upload.

### Why chosen

The selected architecture solves the hardest uncertainty first: preserving MSW template PSD structure. It keeps UI, mapping, preview, and validation stable while allowing the PSD backend to change if evidence requires it.

### Consequences

- Phase 0 can block implementation if no PSD writer passes.
- Up-front contracts are required, but limited to source assets, canonical frames, and PSD adapter boundaries.
- The implementation can pivot PSD backend without rewriting UI/mapping/validation.

### Follow-ups

- Confirm pixel tolerance from real fixtures; default remains exact match.
- Implementation team selects and presents representative MVP validation cody sets and results.
- Expand fixtures across representative MeAegi categories/actions until every source animation range is covered for selected fixtures.
- Revisit MSW MCP only if manual review/upload becomes a post-MVP bottleneck.

## Available-Agent-Types Roster

Known useful prompt roles: `explore`, `researcher`, `dependency-expert`, `architect`, `planner`, `executor`, `test-engineer`, `designer`, `critic`, `verifier`, `code-reviewer`, `writer`.

## Follow-up Staffing Guidance

Recommended delivery mode: **Team + Ultragoal** for parallel implementation with durable checkpoints.

- `explore` / low: PSD inventory and repo state mapping.
- `dependency-expert` / high: PSD IO/image-processing package comparison after G0 evidence.
- `executor` / medium: scaffold, adapters, core pipeline, UI, export in separate lanes.
- `test-engineer` / medium: select representative MVP cody fixtures, G0 scripts, golden-match validator, all-animation fixture validation, Playwright/e2e.
- `designer` / high: mapping matrix UX, grouping interactions, diff/review workflow.
- `verifier` / high: acceptance evidence and final readiness review.
- `writer` / high: manual review/upload checklist and developer docs.

## Goal-Mode Follow-up Suggestions

- Default: `$ultragoal .omx/plans/prd-msw-avatar-converter.md`
- Parallel build: `$team .omx/plans/prd-msw-avatar-converter.md` under Ultragoal checkpointing.
- `$performance-goal` only if G0/fixture benchmarks turn performance into the main measurable project.
- `$autoresearch-goal` is not the final delivery lane; external lookup is supporting planning evidence.
- `$ralph` only as explicit fallback for a single-owner sequential verification/fix loop.

## Team Launch Hints

```bash
$team .omx/plans/prd-msw-avatar-converter.md
# durable goal tracking default:
$ultragoal .omx/plans/prd-msw-avatar-converter.md
```

Suggested team lanes:

1. PSD template/G0 lane.
2. Source ingestion/fixture lane.
3. Canonical frame/render/export lane.
4. UI/UX mapping/preview lane.
5. Validation/test/docs lane.

Team verification path:

- Team proves each acceptance criterion with command output, fixture artifacts, review bundles, and exported PSD samples.
- Ultragoal checkpoints G0 pass, MVP feature completion, validation evidence, and manual-review docs as durable completion artifacts.

## Applied Consensus Improvements

- Promoted PSD roundtrip to named hard G0 gate.
- Added canonical conversion/normalization contract.
- Narrowed source adapters to generic `SourceAsset`/`SourceFrameSet` outputs.
- Added explicit manual review/sign-off export bundle.
- Added pinned validation environment requirement.
- Applied user correction: MVP animation coverage is the complete source animation range; selected cody fixtures are chosen by the implementation team and reported with results.
