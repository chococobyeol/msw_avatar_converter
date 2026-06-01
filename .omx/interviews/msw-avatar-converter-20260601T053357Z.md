# Deep Interview Transcript — MSW Avatar PSD Converter

- Profile: standard
- Context type: brownfield-with-assets-only
- Started: 2026-06-01T05:19:08Z
- Completed: 2026-06-01T05:33:57Z
- Context snapshot: `.omx/context/msw-avatar-converter-20260601T051908Z.md`
- Final ambiguity: 0.14 (threshold 0.20)

## Local Context Found

- Repository currently contains `.omx/` and `avatartemplate/`; no app source/package manifest found during preflight.
- `avatartemplate/` contains 17 PSD files:
  - `Avatar_Cap_A1.psd`, `Avatar_Cap_A2.psd`, `Avatar_Cap_Ani.psd`, `Avatar_Cap_B.psd`, `Avatar_Cap_C1.psd`, `Avatar_Cap_C2.psd`, `Avatar_Cap_D.psd`, `Avatar_Cap_E.psd`, `Avatar_Cap_F.psd`, `Avatar_Cap_G.psd`
  - `Avatar_Cape.psd`, `Avatar_Cape_balloon.psd`, `Avatar_Gloves.psd`, `Avatar_Hair.psd`, `Avatar_Longcoat.psd`, `Avatar_Pants.psd`, `Avatar_Shoes.psd`
- PSD metadata observed via `file`:
  - cap/hair templates: 300 x 180 RGB
  - cape/gloves/longcoat/pants/shoes templates: 2750 x 3500 RGB

## External Reference Facts

- MSW Creator Center has avatar item docs under resource creation/avatar item production, with pages for registration and part types including cape, cap, top, shoes, gloves, pants, hair, and longcoat. Source: https://maplestoryworlds-creators.nexon.com/ko/docs?postId=590
- MSW Creator Center has an MSW MCP page under Maker usage. Source: https://maplestoryworlds-creators.nexon.com/ko/docs?postId=1368
- Nexon Open API has application registration, guide, support, and terms sections. Source: https://openapi.nexon.com/ko/
- MeAegi dressing room publicly lists part categories including hair, face, skin, cap, face accessory, eye accessory, earrings, top, longcoat, bottom, shoes, gloves, cape, weapon, shield, and many actions/expressions; it reports 16,353 items and states its data is based on Nexon Open API and is not an official Nexon site. Source: https://meaegi.com/dressing-room

## Rounds

### Round 1 — Intent / Outcome
Question: MVP가 넓어서 아키텍처가 갈립니다. 여러 기능을 모두 넣더라도, 일정·품질 충돌이 생길 때 가장 먼저 지켜야 하는 ‘성공의 중심축’은 무엇인가요?

Answer: 업로드는 당연히 성공해야하고, 주어진 PSD 파일을 수정하는 방식이면 실패해서는 안 된다. 코디 변환도 이미지 파일을 PSD에 붙여넣고 위치를 맞추는 수준으로 보이며, 정확히 구현하지 못한다면 만들 가치가 없다.

Interpretation: MSW-uploadable PSD output and conversion fidelity are both non-negotiable.

### Round 2 — Success Criteria / Assumption Probe
Question: ‘정확히 구현’의 최종 합격 판정은 무엇이 기준이어야 하나요?

Answer: `pixel-golden-match`

Interpretation: Main automated pass/fail should be frame-by-frame pixel golden match between MeAegi/source cody render frames and converted PSD preview frames.

### Round 3 — Non-goals / Scope Boundary
Question: MVP에서 제외하거나 설계만 할 항목은?

Answer selected:
- AI 이미지→아바타 구현 제외
- 완전 자동 API 연동 제외
- 인게임 검증 자동화 제외
- 배포/계정 시스템 제외

Additional answer: 메애기에 있는 모든 아바타 아이템을 변환 가능해야 한다. MSW 자동 업로드는 필요 없고, 업로드 가능한 원본 PSD를 수정해서 완성본 PSD를 만들면 된다. MeAegi 사이트의 동작별 프레임과 변환 PSD 프레임이 프레임별로 일치하는지 확인하면 된다.

### Round 4 — Decision Boundary / Mapping Authority
Question: MSW 템플릿에 직접 대응 파트가 없거나 프레임 위치가 충돌하는 경우 변환기가 사용자 확인 없이 어떤 우선순위로 결정해도 되나요?

Answer: 처음 UI에서 사용자가 어떤 파트로 변환할지 물어봐야 한다. 예: MeAegi 상의 파트를 MSW 상의/하의/한벌옷 중 어디로 넣을지 UI에서 선택. 무기는 장갑/바지 등으로 선택 가능. 여러 파트를 한 번에 묶어 망토 파트에 넣는 것도 가능해야 한다.

Correction after Round 5: 미지원 파트만이 아니라 모든 파트를 어떤 MSW 파트로 변환할지 사용자가 선택해야 한다.

Interpretation: Mapping authority belongs to the user for every source part, not only unsupported parts. The converter provides target-part selection and grouped conversion, then renders/export accordingly.

### Round 5 — External Integration Boundary
Question: MeAegi가 공식 API를 제공하지 않거나 공유 코디/프레임 이미지 접근이 비공식 경로일 때, MVP에서 어디까지 허용할까요?

Answer: `public-page-image-ok`

Follow-up clarification: 모든 이미지 사용 허용. 업로드 전에 PSD 파일을 수동 검토할 예정.

Interpretation: Public MeAegi pages/image URLs and user-provided images may be analyzed/used if they are accessible without login or bypass. Generated PSDs remain subject to manual human review before upload. No automated login, paywall bypass, private data access, or automated upload/publication is in scope.

## Final Scoring

| Dimension | Score |
|---|---:|
| Intent clarity | 0.90 |
| Outcome clarity | 0.92 |
| Scope clarity | 0.88 |
| Constraint clarity | 0.78 |
| Success criteria clarity | 0.92 |
| Context clarity | 0.80 |

Brownfield weighted ambiguity = 0.14.

## Readiness Gates

- Non-goals: explicit
- Decision boundaries: explicit enough for planning
- Pressure pass: complete; exactness/pixel-match assumption and mapping-authority assumption were challenged and clarified
- Closure audit: further questions would mainly refine implementation details, better handled by `$ralplan` with source/PSD feasibility research
