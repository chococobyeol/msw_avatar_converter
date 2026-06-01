# MVP Cody Fixture Set

Selected by the implementation team on 2026-06-01 for the first repeatable MVP validation pass. These are deterministic synthetic/public-image-style fixtures, not private account captures. They are designed to exercise the conversion invariants before plugging in live public MeAegi fetches.

Validation command:

```bash
npm run fixtures:validate
```

Current results are written to:

- `artifacts/fixtures/fixture-results.json`
- `docs/fixture-results.md`
- Review bundles for lightweight 300x180 targets under `artifacts/fixtures/*/{hair,cap-a1,cap-ani}`

## Selected fixtures

1. **Separated daily outfit** — ordinary separated hair/cap/top/pants/shoes mappings.
2. **Weapon/shield remapped to gloves** — unsupported source weapon/shield/hand effect grouped into MSW `gloves`.
3. **Multi-source cape effect group** — cape/effect/aura grouped into MSW `cape`.
4. **Whole avatar baked into longcoat** — all source parts collapsed into one `longcoat` mapping.
5. **Transparent accessory and balloon cape** — alpha-preservation fixture including `cap-ani`, `cape-balloon`, and `hair` targets.

## Acceptance policy

- Every source part must be present in at least one user-confirmed mapping.
- Every detected action/frame in the fixture must be normalized, previewed, and validated.
- Pixel validation uses `exact-rgba`: `diffPixels=0`, `maxChannelDelta=0`.
- Large 2750x3500 templates are not emitted for every fixture run to avoid enormous generated artifacts; G0 roundtrip evidence covers all 17 template PSDs, and fixture validation covers mapping/grouping/whole-avatar semantics.
