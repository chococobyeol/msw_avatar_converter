# MVP Fixture Results

Generated: 2026-06-01T11:30:20.525Z

Policy: exact RGBA, diffPixels=0, maxChannelDelta=0. Expected frames are generated through an independent golden-reference renderer and stored under each fixture `golden/` folder.

| Fixture | Purpose | Source parts | Source frames | Mapping coverage | Result | Export evidence |
| --- | --- | ---: | ---: | --- | --- | --- |
| Separated daily outfit | Ordinary MeAegi-style cody with independently mapped clothing/hair/cap parts. | 5 | 70 | part:hair→hair<br>part:cap→cap-a1<br>part:top→longcoat<br>part:pants→pants<br>part:shoes→shoes | PASS (0 diff px, max Δ 0) | hair:psd-target-slot-fixture<br>cap-a1:psd-target-slot-fixture<br>longcoat:large-template-validated-no-psd-artifact<br>pants:large-template-validated-no-psd-artifact<br>shoes:large-template-validated-no-psd-artifact |
| Weapon/shield remapped to gloves | Unsupported source parts are user-mapped into an available MSW part. | 3 | 42 | group:weapon+shield+hand-fx→gloves | PASS (0 diff px, max Δ 0) | gloves:large-template-validated-no-psd-artifact |
| Multi-source cape effect group | Several source effect layers are bundled into one cape PSD target. | 3 | 42 | group:cape+sparkle+back-aura→cape | PASS (0 diff px, max Δ 0) | cape:large-template-validated-no-psd-artifact |
| Whole avatar baked into longcoat | All visible source parts are collapsed into one target part for single-piece animation. | 5 | 70 | whole-avatar:body+hair+face-proxy+weapon+cape→longcoat | PASS (0 diff px, max Δ 0) | longcoat:large-template-validated-no-psd-artifact |
| Transparent accessory and balloon cape | Alpha preservation fixture for semi-transparent accessory pixels. | 3 | 42 | part:accessory→cap-ani<br>part:balloon→cape-balloon<br>part:hair→hair | PASS (0 diff px, max Δ 0) | cap-ani:psd-target-slot-fixture<br>cape-balloon:large-template-validated-no-psd-artifact<br>hair:psd-target-slot-fixture |

Large MSW templates are not materialized for every fixture in this lightweight validation run to avoid committing hundreds of MB of generated PSD artifacts. G0 separately proves all 17 templates can be read/written with 0 composite diff; this fixture run proves mapping, grouping, whole-avatar mode, complete detected action/frame coverage, and exact RGBA validation over the selected representative codies.
