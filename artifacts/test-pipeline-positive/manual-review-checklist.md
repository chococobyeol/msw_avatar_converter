# Manual PSD Review Checklist

Before manually uploading generated PSDs to MapleStory Worlds:

- [ ] Open the exported PSD in Photoshop or a compatible editor.
- [ ] Confirm the file is derived from the corresponding `avatartemplate/*.psd`.
- [ ] Confirm expected visible pixels appear in the target MSW part.
- [ ] Review `mapping-plan.json` for every source part and grouped/whole-avatar mappings.
- [ ] Review `validation-report.json` and diff PNGs.
- [ ] Confirm `human-signoff.json` is marked approved by a human reviewer.
- [ ] If MSW upload is manually tested, record the result in the review bundle.

## Required mapping review

- [ ] For every source part, confirm the chosen target MSW part in `mapping-plan.json`.
- [ ] For `group` mappings, confirm the grouped source parts are intended to share one target PSD.
- [ ] For `whole-avatar` mappings, confirm the entire animation is intentionally baked into one target part.
- [ ] Confirm every detected action/frame appears in the preview folder and validation report.
