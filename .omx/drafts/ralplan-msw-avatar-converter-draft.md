# RALPLAN-DR Draft — MSW Avatar PSD Converter

## Requirements Summary

Build a local/single-user web UI that converts MapleStory/MeAegi avatar cody frames into MapleStory Worlds-uploadable PSDs by modifying the existing `avatartemplate/*.psd` files. The app must force the user to map **every** source part to a target MSW template part, support grouping multiple source parts into one target part, preview source and converted animations, export completed PSDs, and validate frame-by-frame pixel golden-match before manual upload review.

Primary requirements source: `.omx/specs/deep-interview-msw-avatar-converter.md`.

Local evidence:
- Current repo has no app source; only `.omx/` and `avatartemplate/` were found by `find . -maxdepth 2 -type f`.
- `avatartemplate/` has 17 PSDs; `file avatartemplate/*.psd` reports cap/hair templates as 300x180 RGB and cape/gloves/longcoat/pants/shoes templates as 2750x3500 RGB.

External evidence:
- MSW Creator Center lists avatar item production/registration and part-specific guides for cape, cap, top, shoes, gloves, pants, hair, longcoat (docs page updated 2025-12-02).
- MSW Creator Center has an MSW MCP page (docs page updated 2026-04-09), but MVP excludes automated MSW upload.
- Nexon Open API has app registration, API guide, support and terms surfaces.
- MeAegi dressing room publicly exposes item categories and action/expression/motion UI, reports 16,353 items, and states it is based on Nexon Open API but is not an official Nexon site.
- `psd-tools` documentation says it supports low-level PSD/PSB read/write but has limited support for editing/compositing many layer types.
- `ag-psd` npm docs expose read/write options and a JS PSD document model with layer canvases.
- Playwright docs include visual comparisons/screenshot snapshots and warn that rendering consistency depends on a controlled environment.

## RALPLAN-DR Summary

### Principles

1. **Template-derived output only**: generated PSDs must start from the provided uploadable MSW templates and replace/insert pixels, not synthesize unrelated PSD structures.
2. **Every mapping is user-owned**: the app may suggest defaults, but every source part must have an explicit target MSW part mapping before export.
3. **Fidelity is measurable**: frame-by-frame pixel golden-match/diff is the primary acceptance signal, with any non-zero tolerance explicitly recorded.
4. **Adapters over hardcoding**: source ingestion, frame extraction, PSD IO, and future AI conversion must be isolated behind interfaces so MeAegi/Nexon/API changes do not rewrite the core converter.
5. **Human review before upload**: generated PSDs are reviewable artifacts; MVP does not automate MSW upload or publication.

### Decision Drivers

1. **PSD roundtrip fidelity/uploadability risk**: wrong library choice can corrupt template structure or fail MSW upload.
2. **All-item coverage via generic frames**: the plan must support MeAegi’s item breadth through image/frame composition, not per-item hardcoding.
3. **Deterministic validation**: pixel matching must run in a stable rendering environment to avoid false positives/negatives.

### Viable Options

#### Option A — TypeScript local web app + Node PSD pipeline (favored after spike)

Approach: Vite/React UI with a local Node API/worker, using `ag-psd` for PSD IO where it passes template roundtrip tests, `sharp`/canvas for image normalization/compositing, and Playwright for UI/visual validation.

Pros:
- One language/runtime for UI, server, importer, and tests.
- `ag-psd` is JS-native and exposes read/write operations plus layer canvas data.
- Easier interactive previews and browser canvas integration.
- Fits local/single-user web app without Python service packaging.

Cons:
- PSD uploadability depends on whether `ag-psd` preserves enough template metadata/layer structure.
- Large 2750x3500 PSDs may need worker processes and memory caps.
- Browser rendering and Node canvas/sharp rendering must be normalized to avoid diff mismatch.

#### Option B — Python PSD service + TypeScript UI

Approach: React UI calls a Python backend using `psd-tools`/Pillow/NumPy for PSD analysis/export and pixel diff.

Pros:
- `psd-tools` has mature PSD inspection, compositing helpers, and documented low-level read/write support.
- Python image diff/NumPy pipelines are straightforward.
- Easier one-off PSD structure introspection scripts.

Cons:
- `psd-tools` docs call out limited editing/compositing support for several Photoshop features, so uploadability still requires spikes.
- Two runtimes complicate local packaging.
- More IPC and deployment friction for a local creator tool.

#### Option C — Hybrid adapter-first: TypeScript product with swappable PSD backend

Approach: Build the product and interfaces in TypeScript, but make PSD IO a replaceable adapter. Start with `ag-psd`; keep a Python `psd-tools` fallback adapter if the template roundtrip fails.

Pros:
- Avoids overcommitting before PSD evidence.
- Keeps UI/domain model stable if PSD backend changes.
- Best risk management for unknown template internals.

Cons:
- Slightly more up-front interface work.
- Must avoid building two full backends unless the spike justifies it.

Favored decision: **Option C with Option A as the first implementation path**, gated by a PSD roundtrip spike. If `ag-psd` cannot preserve uploadable templates, switch only the PSD adapter to Python/`psd-tools` or another proven backend.

## Architecture Plan

### Proposed Modules

- `apps/web/`: React UI for source import, action/frame preview, mapping matrix, target preview, diff viewer, export queue.
- `apps/local-api/`: local Node service for MeAegi/public image ingestion, PSD/template analysis, conversion jobs, filesystem export.
- `packages/core/`: pure TypeScript domain model and conversion planner.
- `packages/source-adapters/`: `PublicMeAegiAdapter`, `ImageUploadAdapter`, later `NexonApiAdapter`.
- `packages/template-adapters/`: `MswTemplateManifest`, `PsdTemplateReader`, `PsdTemplateWriter`, `TemplateRoundtripValidator`.
- `packages/render/`: frame normalization, placement, composition, preview rendering, grouping/whole-avatar mode.
- `packages/validation/`: pixel diff, golden-match reports, tolerance config, artifact snapshots.
- `fixtures/`: curated public/user-provided sample frame sets and expected outputs.
- `tests/`: unit, integration, e2e, visual regression, PSD roundtrip checks.

### Core Data Contracts

- `SourcePart`: `{ id, label, category, framesByAction, sourceBounds, metadata }`
- `SourceFrame`: `{ action, frameIndex, imageRef, width, height, anchor?, duration? }`
- `TargetTemplatePart`: `{ id, templatePath, canvasSize, frameGrid, editableRegions, layerTargets }`
- `MappingPlan`: `{ sourcePartIds[], targetTemplatePartId, mode: 'part'|'group'|'wholeAvatar', placementRules, userConfirmedAt }`
- `ConversionJob`: `{ sourceSet, mappingPlans, normalization, validationPolicy, outputTargets }`
- `ValidationReport`: `{ action, frameIndex, diffPixels, diffRatio, maxDelta, pass, diffImagePath }`

## Implementation Steps

### Phase 0 — Feasibility spikes and evidence capture

1. PSD inventory spike:
   - Inspect each `avatartemplate/*.psd` for layer/group names, dimensions, channels, editable pixel layers, and frame/action grids.
   - Produce `.omx/artifacts/template-inventory.json` and a human-readable `docs/template-inventory.md`.
   - Acceptance: all 17 PSDs are listed with dimensions, layer tree, inferred editable regions, and unknowns.

2. PSD roundtrip spike:
   - Use `ag-psd` to open and write each template with no pixel edits, then compare structural metadata and composite previews.
   - If roundtrip fails materially, test a minimal Python `psd-tools` adapter against the same fixtures.
   - Acceptance: chosen PSD adapter can roundtrip templates without visible composite changes and with manually inspectable PSD output; otherwise planning blocks implementation until a working PSD writer is chosen.

3. MeAegi/public image ingestion spike:
   - Verify public page/render/image access for representative cody/share examples without login/bypass.
   - Also support user-uploaded frame images as a guaranteed fallback input.
   - Acceptance: at least one public-source fixture and one uploaded-image fixture produce normalized `SourcePart`/`SourceFrame` data.

4. Pixel comparison policy spike:
   - Default policy: exact RGBA match after deterministic normalization unless a fixture proves unavoidable alpha/color differences.
   - If tolerance is needed, record numeric thresholds and rationale in `fixtures/validation-policy.json`.
   - Acceptance: pixel diff report identifies frame index, diff count/ratio, max delta, and writes diff images.

### Phase 1 — Project scaffold and domain model

5. Create monorepo scaffold with TypeScript strict mode, lint/typecheck/test scripts, and local-only run scripts.
6. Implement `packages/core` contracts for source sets, target templates, mapping plans, conversion jobs, and validation reports.
7. Add fixture loaders and schema validation for imported source frames and template manifests.

### Phase 2 — Template and source adapters

8. Implement `PsdTemplateReader`/`PsdTemplateWriter` behind an interface chosen by the Phase 0 spike.
9. Implement `MswTemplateManifest` generation from the local `avatartemplate/` directory.
10. Implement `ImageUploadAdapter` for user-provided frame images.
11. Implement `PublicMeAegiAdapter` only for public, no-login/no-bypass pages/images; include a clear failure mode when source structure changes.
12. Keep `NexonApiAdapter` as a documented extension/stub unless needed for metadata enrichment.

### Phase 3 — UI and mapping workflow

13. Build source import screen for MeAegi URL/public image source and manual image/frame upload.
14. Build action/frame viewer for source frames by part and action.
15. Build mapping matrix where **every source part must be assigned** to a target MSW template part before export.
16. Add grouping controls to assign multiple source parts to one target part and whole-avatar insertion mode.
17. Add mapping presets/recommendations only as editable defaults; never silently export without user-confirmed mapping.

### Phase 4 — Rendering, preview, export

18. Implement deterministic frame normalization and placement engine.
19. Render converted preview frames from the same conversion plan used for PSD export.
20. Implement PSD pixel insertion/replacement into template-derived outputs.
21. Export completed PSDs and sidecar reports: mapping plan JSON, validation report JSON, preview PNGs, diff PNGs.

### Phase 5 — Validation and QA hardening

22. Implement frame-by-frame pixel golden-match validator with exact-match default and explicit tolerance config.
23. Add unit tests for mapping validation, grouping, placement math, normalization, and diff logic.
24. Add integration tests for template roundtrip, source fixture conversion, PSD export, and report generation.
25. Add Playwright e2e tests for import → map every part → preview → validate → export.
26. Add visual regression snapshots only in a controlled environment; do not use uncontrolled full-page screenshots as the sole correctness gate.
27. Document manual PSD review/upload checklist for MSW Creator workflow.

## Acceptance Criteria

1. All 17 local PSD templates are inventoried and have an adapter roundtrip result.
2. The chosen PSD writer modifies template-derived outputs without losing upload-relevant structure identified in the inventory.
3. The app imports at least one public MeAegi/public-image fixture and one user-uploaded frame fixture without login/bypass.
4. The UI prevents export until every source part has a user-confirmed target MSW template part.
5. The UI supports mapping one source part to any target part and grouping multiple source parts into one target part.
6. Whole-avatar insertion into a single target part is supported.
7. Source animation preview and converted animation preview use the same action/frame indexing used by validation.
8. Pixel golden-match validation reports pass/fail per frame with diff images and machine-readable JSON.
9. Accepted fixture conversions pass the recorded validation policy.
10. Export outputs PSD files plus sidecar mapping/validation artifacts.
11. Manual review checklist explains how to inspect generated PSDs before MSW upload.
12. Future AI image-to-avatar conversion has explicit extension interfaces but no MVP implementation.

## Risks and Mitigations

- **PSD writer corrupts template metadata**: make PSD roundtrip Phase 0 a hard gate; keep PSD adapter swappable.
- **MeAegi page/image structure changes**: preserve user-uploaded image fallback and isolate `PublicMeAegiAdapter`.
- **“All items” hides edge cases**: use generic frame-image pipeline and fixture expansion; do not hand-code item IDs.
- **Pixel diff flakiness**: compare normalized frame buffers, not arbitrary screenshots; run Playwright visual tests only in controlled environment.
- **Large PSD memory/performance issues**: use worker processes, streaming where possible, and benchmark 2750x3500 templates early.
- **Legal/ToS ambiguity**: restrict automation to public/no-login/no-bypass sources; keep final upload/manual review outside the tool.
- **Mapping UX overload**: provide editable recommendations and batch/group operations while still requiring explicit confirmation for every part.

## Verification Steps

- `npm run typecheck`
- `npm run lint`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test:visual` in the pinned visual environment
- `npm run fixtures:validate` for golden-match fixtures
- Manual PSD inspection checklist for a small fixture set before claiming MSW upload readiness

## ADR

### Decision

Adopt an adapter-first TypeScript local web architecture, starting with a Node/`ag-psd` PSD adapter only after a successful template roundtrip spike, and preserving a Python/`psd-tools` adapter fallback if template fidelity fails.

### Drivers

- Need template-derived PSD outputs.
- Need deterministic pixel validation.
- Need all-item coverage through generic frame composition.
- Need future AI conversion seams without implementing AI now.

### Alternatives considered

- Pure TypeScript/`ag-psd` from the start: fastest product path but too risky without roundtrip proof.
- Python PSD service first: strong PSD inspection path but adds two-runtime complexity and still has documented editing limitations.
- Full MSW automation/MCP upload: rejected for MVP because user explicitly wants manual PSD review before upload.

### Why chosen

Adapter-first keeps product/domain work stable while forcing the riskiest assumption—PSD template roundtrip/edit fidelity—to be proven before deep implementation.

### Consequences

- Phase 0 may block implementation if no PSD writer preserves template outputs.
- Slightly more interface design is required early.
- The implementation can pivot PSD backends without rewriting UI/mapping/validation.

### Follow-ups

- Confirm exact pixel tolerance after fixtures are available.
- Expand fixture set until representative MeAegi categories/actions are covered.
- Revisit MSW MCP only if manual upload review becomes too slow post-MVP.

## Available-Agent-Types Roster

Known useful roles: `explore`, `researcher`, `dependency-expert`, `architect`, `planner`, `executor`, `test-engineer`, `designer`, `critic`, `verifier`, `code-reviewer`, `writer`.

## Follow-up Staffing Guidance

Recommended delivery mode: **Team + Ultragoal** for durable checkpointing and parallel execution.

- `explore` / low: inventory current PSD assets and repo state.
- `dependency-expert` / high: compare PSD IO libraries and image-processing packages after the Phase 0 spike.
- `executor` / medium: scaffold app, implement adapters, core pipeline, UI, and export path in separate lanes.
- `test-engineer` / medium: own fixtures, golden-match validator, Playwright/e2e and integration tests.
- `designer` / high: mapping matrix UX, diff viewer, preview workflow.
- `verifier` / high: validate plan acceptance criteria and final evidence before completion.
- `writer` / high: manual PSD review/upload checklist and developer docs.

### Goal-Mode Follow-up Suggestions

- Default: `$ultragoal .omx/plans/prd-msw-avatar-converter.md` after PRD/test-spec approval, because this is a durable multi-phase implementation goal.
- Parallel implementation: use `$team .omx/plans/prd-msw-avatar-converter.md` under Ultragoal checkpointing for PSD adapter, source adapter, UI, and validation lanes.
- `$performance-goal` is not primary unless Phase 0 benchmarks show conversion latency/memory targets become a dominant optimization project.
- `$autoresearch-goal` is not primary; external research is supporting evidence, not the final deliverable.
- `$ralph` only as an explicit fallback if a single-owner sequential verification/fix loop is intentionally requested.

### Team Launch Hints

```bash
$team .omx/plans/prd-msw-avatar-converter.md
# or with durable goal tracking after planning approval:
$ultragoal .omx/plans/prd-msw-avatar-converter.md
```

Team lanes:
1. PSD template/roundtrip lane.
2. Source ingestion/fixture lane.
3. Core mapping/render/export lane.
4. UI/UX preview/mapping lane.
5. Validation/test/docs lane.

Team verification path:
- Team proves each acceptance criterion with test output, fixture artifacts, and exported PSD samples.
- Ultragoal checkpoints Phase 0 gate, MVP feature completion, validation evidence, and manual-review documentation as durable completion artifacts.
