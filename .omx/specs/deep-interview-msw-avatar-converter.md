# Execution-Ready Spec — MSW Avatar PSD Converter

## Metadata

- Source workflow: `$deep-interview`
- Profile: standard
- Context type: brownfield-with-assets-only
- Final ambiguity: 0.14
- Threshold: 0.20
- Context snapshot: `.omx/context/msw-avatar-converter-20260601T051908Z.md`
- Transcript: `.omx/interviews/msw-avatar-converter-20260601T053357Z.md`

## Intent

Build a web UI tool that converts MapleStory main-server/MeAegi avatar cody output into MapleStory Worlds-uploadable avatar PSD files by modifying the provided uploadable PSD templates. The tool is only valuable if it produces visually correct converted animation frames and valid PSD outputs.

## Desired Outcome

A local/single-user MVP web app that can:

1. Load a MeAegi cody/share/public render source.
2. Show source avatar parts and the complete detected action/animation/frame range.
3. Require the user to choose, for **every source part**, which MSW avatar template part it should become.
4. Allow multiple source parts to be grouped into one target MSW part, including whole-avatar animation insertion into cape/longcoat-style parts.
5. Render converted output previews from the generated PSD/template mapping.
6. Export completed PSD files by modifying the provided `avatartemplate/*.psd` files.
7. Validate conversion fidelity by frame-by-frame pixel comparison between MeAegi/source frames and converted-output preview frames.

## In Scope

- Web UI for import, part mapping, preview, validation, and PSD export.
- Image-based ingestion is allowed broadly for conversion inputs, including public MeAegi cody/share/render images and user-provided avatar/frame images, as long as the tool does not require login, authentication bypass, or private data access.
- All MeAegi avatar item categories shown in the dressing room must be representable in the converter, including categories that MSW does not natively expose as separate avatar parts.
- User-controlled mapping for every source part:
  - Example: source top can map to MSW top, pants, longcoat, cape, etc.
  - Example: source weapon can map to gloves, pants, cape, etc.
  - Multiple source parts can be grouped into a single target PSD part.
- Part-level and whole-avatar conversion modes.
- Animation preview for source parts and converted output.
- Pixel golden-match validation as the primary correctness criterion.
- Architecture must leave extension seams for future image/person/object → natural pixel-motion avatar → MSW PSD conversion.

## Out of Scope / Non-goals for MVP

- Implementing AI image/person/object-to-avatar conversion now. Only design extension seams.
- Full automatic API integration across every possible source. MVP may prioritize public MeAegi ingestion; Nexon Open API can be an adapter/future or supporting data source.
- Automated upload into MSW or automated in-game/editor validation.
- Production deployment, accounts, multi-user permissions, billing, or cloud hosting.
- Private/login-gated scraping, bypassing access controls, or using non-public user data.
- Automated publication/upload without human review; PSDs are manually reviewed before MSW upload.

## Decision Boundaries

OMX/planning may decide without further confirmation:

- Concrete web stack, PSD library, image-processing library, and test tooling.
- Internal data model for source frames, target templates, mapping presets, and validation results.
- How to normalize image frames for deterministic pixel comparison, provided the default is strict enough to catch visible mismatch.
- How to structure future AI conversion extension points, as long as the MVP does not implement that feature.
- Use of image inputs for conversion, including public MeAegi page/image data and user-provided images, provided access-control bypass or private data use is not required.

OMX/planning must preserve or ask before changing:

- Every source part must require user-selectable target MSW part mapping; do not limit this to unsupported parts.
- Pixel golden-match remains the primary fidelity acceptance criterion.
- Output must be completed PSD files derived from/modifying the provided uploadable template PSDs.
- MeAegi all-item conversion is an MVP requirement, not a post-MVP stretch goal, though implementation may use a generic mapping/render pipeline rather than hand-coded per-item support.
- Final upload responsibility stays with the human: generated PSD files should be reviewable and manually inspected before upload.

## Constraints

- Existing uploadable template PSDs live in `avatartemplate/`.
- Observed template files:
  - Cap: `Avatar_Cap_A1.psd`, `Avatar_Cap_A2.psd`, `Avatar_Cap_Ani.psd`, `Avatar_Cap_B.psd`, `Avatar_Cap_C1.psd`, `Avatar_Cap_C2.psd`, `Avatar_Cap_D.psd`, `Avatar_Cap_E.psd`, `Avatar_Cap_F.psd`, `Avatar_Cap_G.psd`
  - Other: `Avatar_Cape.psd`, `Avatar_Cape_balloon.psd`, `Avatar_Gloves.psd`, `Avatar_Hair.psd`, `Avatar_Longcoat.psd`, `Avatar_Pants.psd`, `Avatar_Shoes.psd`
- PSD export should preserve uploadability by starting from the provided PSD templates and changing avatar pixels/layers as needed, not inventing an unrelated PSD structure.
- Need follow-up feasibility checks for exact layer structure, coordinate grid, frame/action mapping, and PSD writer fidelity.

## Testable Acceptance Criteria

1. Given a public MeAegi cody/share/render source or user-provided frame images, the app imports source part/frame data or render frames without login/bypass.
2. The UI lists every detected source part and forces/selects a target MSW template part for each before export.
3. The UI supports mapping multiple source parts into one target MSW part.
4. The UI supports whole-avatar frame insertion into a single target part such as cape or longcoat.
5. The app previews source animation frames by action/part for the complete detected animation range.
6. The app previews converted-output animation frames derived from the target PSD/template placement for every detected source animation/action/frame.
7. The validator compares source and converted frames frame-by-frame and reports pixel diff/mismatch locations.
8. For accepted fixtures, converted preview frames match the MeAegi/source golden frames under the agreed normalization rules for every detected animation/action/frame.
9. Export produces completed PSD files based on the original `avatartemplate` PSDs.
10. Generated PSD files can be manually inspected and then manually uploaded to MSW using the normal creator workflow; automated upload is not required.
11. Architecture includes adapters/stages for future image-to-avatar conversion without implementing it in MVP.

## Assumptions Exposed + Resolutions

- Assumption: Upload should be easy because template PSDs are already uploadable.
  - Resolution: Preserve template-derived PSD output as a hard constraint; still verify PSD writing and manual upload path during planning/testing.
- Assumption: Conversion is mostly image placement.
  - Resolution: Primary fidelity proof is frame-by-frame pixel golden match, not subjective visual review.
- Assumption: Only unsupported parts need mapping decisions.
  - Resolution: Corrected by user: every source part must be user-mapped to a target MSW part.
- Assumption: All items are feasible if one works.
  - Resolution: Treat all MeAegi items as in-scope via a generic render/frame pipeline and mapping table, but planning must validate edge cases and avoid hand-coded item exceptions where possible.

## Technical Context Findings

- MSW docs reference avatar item production/registration and specific part guides. Source: https://maplestoryworlds-creators.nexon.com/ko/docs?postId=590
- MSW MCP docs exist and may help later with MSW-side workflows, but MVP excludes automated upload. Source: https://maplestoryworlds-creators.nexon.com/ko/docs?postId=1368
- Nexon Open API provides official app/API guide surfaces; use it only where it materially helps import metadata. Source: https://openapi.nexon.com/ko/
- MeAegi dressing room publicly shows item categories, action/expression/motion options, and a large item count; it states data is based on Nexon Open API and that it is not official Nexon. Source: https://meaegi.com/dressing-room
- User clarification after crystallization: all image inputs are allowed for conversion use because PSD output will be manually reviewed before upload.
- User correction during planning: MVP validation cody sets should be selected by the implementation team and results shown to the user; animation scope is the full detected source animation range, and missing any animation/action/frame means conversion failed.

## Recommended Next Step

Use `$ralplan` / `$plan --consensus --direct .omx/specs/deep-interview-msw-avatar-converter.md` before implementation. The next phase should validate architecture, legal/ToS risk, PSD read/write feasibility, MeAegi ingestion feasibility, and the testing strategy for pixel golden-match fixtures.
