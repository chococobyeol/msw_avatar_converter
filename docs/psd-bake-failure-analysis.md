# PSD bake failure analysis

This document records why the MeAegi → MSW PSD converter repeatedly failed during the `2026-06-05` hair/cap cleanup and what must not be repeated.

## What failed

### 1. Useful UI was removed together with obsolete preview UI

The `Whole-avatar PSD Bake` preview panel was obsolete, but the toolbar shortcut **`전체 아바타를 cape 한 파트로 굽기`** was still useful. Removing the whole panel also removed that shortcut.

Fix:
- The obsolete preview/GIF panel stays removed.
- The toolbar shortcut is restored next to `추천 매핑 전체 확인` / `확인된 매핑대로 PSD 시트 생성`.
- The shortcut sets all current rows to `targetPartId=cape`, `mode=whole-avatar`, `groupId=whole-avatar`, `confirmed=true`.

Rule:
- Do not delete a UI control just because the surrounding panel is obsolete. Separate “dead preview display” from “still-useful execution/mapping shortcut”.

### 2. CLI-only whole-avatar bake guidance was hidden in logs

After removing the whole-avatar panel, the CLI/API fallback was only described as plain text in the conversion log area, which users could easily miss.

Fix:
- Add a visible help icon beside `Import / Conversion Log`.
- The help popover shows the console command and examples.

Rule:
- If a UI feature is replaced by CLI/API access, expose the replacement path through an explicit help affordance, not only through logs.

### 3. Face-to-cap bakes copied face pixels into back slots

For compact cap templates, empty slots were protected by `preserveTemplateSlotWhenSparse`. When `face` was baked into a cap target, the back slot became empty, then the fallback copied the front face donor into the back slot. This caused eyes/face pixels on the back of the head.

Fix:
- `face`, `faceDeco`, and `eyeDeco` are treated as front-only compact sources.
- For front-only sources, back slots skip source drawing and donor/template fallback.
- Back slots receive only a near-transparent 1px upload guard, preventing MSW blank-slot rejection without visible face pixels.

Rule:
- Fallbacks that are valid for real two-sided parts such as caps/hair must not be reused for front-only face/accessory sources.

### 4. Hair raw zmap lookup assumed `backDefault` always exists

`Avatar_Hair.psd` back layers were mapped to MapleStory.io `backDefault[0].backHair` and `backDefault[0].backHairBelowCap`. Hair item `61860` has an empty `backDefault` frameBook; its real back hair images exist in `rope[0]` and `ladder[0]`.

Initial bad fix:
- Missing raw effects were preserved from the original template. That avoided export failure but did not show the actual 61860 back hair.

Final fix:
- Resolve missing `backDefault` back hair effects through fallback frameBooks: `rope`, `ladder`, then `swingTF`.
- Preserve the original template slot only when no usable raw effect image exists anywhere.
- Log/report missing raw effects and fallback source frameBooks via `rawHairPlacements` and `rawHairMissingEffects`.

Verified for `share=khS3rruGEnp6`, `hair=61860`:
- `back_backHairBelowCapNarrow_95` uses `rope[0].backHairBelowCap`, alpha `3587`.
- `back_backHairBelowCapWide_94` uses `rope[0].backHairBelowCap`, alpha `3587`.
- `back_backHair_91` uses `rope[0].backHair`, alpha `3656`.

Rule:
- Do not assume a MapleStory.io frameBook exists just because the MSW template has a similarly named slot. Inspect available frameBooks and use semantic fallbacks for back-facing hair.

## Verification used

- `npm run typecheck`
- `npm run test:unit`
- `npm run build`
- Manual bake checks:
  - `khS3rruGEnp6`, `target=hair`, `parts=hair`
  - `5ygONGbs3Cqp`, `target=cap-c1`, `parts=face`
  - ordinary cap source bakes for cap targets

## Remaining limitation

Local PSD generation/readback passes. MSW upload/runtime rendering is still a manual external validation step.
