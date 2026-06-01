# Validation Environment

Golden-match validation must run from canonical RGBA buffers, not uncontrolled screenshots.

Initial pinned environment for G0:

- OS: macOS local development environment (record exact CI/container once added)
- Node: 20.18.0
- npm: 10.8.2
- PSD candidate backend: ag-psd (version locked in package-lock.json)
- Image comparison: canonical RGBA buffer exact match by default
- Browser/Playwright: not part of G0; must be pinned before UI visual tests are accepted
- Fonts/rendering: not used in G0 buffer comparisons

Snapshot update policy: visual snapshots are secondary and may only be updated when canonical buffer diffs and fixture reports justify the change.

## MVP fixture validation

- Fixture command: `npm run fixtures:validate`
- Fixture definitions: `fixtures/mvp-cody-fixtures.json`
- Fixture result summary: `docs/fixture-results.md` and `artifacts/fixtures/fixture-results.json`
- Exact-match default remains `diffPixels=0` and `maxChannelDelta=0`.
- Large MSW PSD templates are validated by G0 read/write roundtrip and are not generated for every fixture by default to keep artifacts reviewable.
