# Source and API Boundaries

Last checked: 2026-06-01.

Reference pages:

- MapleStory Worlds Creator Center, **아바타 아이템 등록하기**: `https://maplestoryworlds-creators.nexon.com/ko/docs?postId=590` (page shows avatar item-production docs under resource creation and update date 2025-12-02).
- NEXON Open API portal: `https://openapi.nexon.com/ko/` (portal links app registration, API guide, support; page listed current notice dated 2026-05-21 when checked).
- MapleStory Worlds Creator Center, **MSW MCP**: `https://maplestoryworlds-creators.nexon.com/ko/docs?postId=1368` (page shows MSW MCP docs and update date 2026-04-09).

## MVP source policy

- Accept user-provided image/frame files and public no-login MeAegi-style image URLs as source assets.
- Keep source adapters thin: they emit `SourceFrameSet` only and do not decide MSW target parts.
- Do not automate private login, production accounts, in-game upload, or Open API flows in MVP.
- Nexon API integration remains an adapter boundary (`sourceKind: "nexon-api"`) for a later authenticated story.
- AI image-to-avatar conversion is explicitly out of MVP, but `sourceKind: "future-ai"` is reserved so generated frames can enter the same normalization/mapping/export pipeline later.

## Mapping policy

- All source parts, including already-supported-looking parts, must be shown to the user and confirmed before export.
- Unsupported MapleStory parts such as weapon/shield/skin/face are mapped by user decision into available MSW template targets such as `gloves`, `pants`, `cape`, or `longcoat`.
- Multi-source grouping and whole-avatar bake modes are first-class `MappingPlan.mode` values.

## MeAegi public share import

- The web UI accepts a public MeAegi dressing-room share URL or raw share id in the source import box.
- Local development uses the Vite middleware endpoint `/api/meaegi-share?share=...` because the browser cannot call MeAegi's Next Server Action directly under CORS.
- The adapter reads the public share payload (`itemCode`, prism settings, gender, and render hash), converts each slot into a user-confirmable source part, and assigns default target-part suggestions that the user can override.
- Current import evidence for `https://meaegi.com/dressing-room?share=5gcTvkPmcFn5`: 14 source parts are resolved and expanded into 112 preview frame records (14 parts × 4 actions × 2 placeholder frame indexes).
- Boundary: this bridge imports public share metadata and a character render image reference. It is not yet a verified per-part/per-action MeAegi sprite-frame extractor, so pixel-golden parity for all MeAegi animation frames still depends on implementing the true frame extraction/render adapter.
