# What went missing from src/App.jsx
Commits examined: 338 | names ever declared: 1575 | present now: 1457

## Features lost and never restored (46)

Local variables are excluded -- a renamed local inside a refactor is not a lost feature. Re-run with --all to see everything.

| name | kind | disappeared in | date | commit subject |
|---|---|---|---|---|
| `num_frames` | credit | `fc2949c22` | 2026-06-27 | Stage 2: secure video backend (WaveSpeed v3) |
| `guidance_scale` | credit | `fc2949c22` | 2026-06-27 | Stage 2: secure video backend (WaveSpeed v3) |
| `STRIPE_PK` | const | `367044319` | 2026-06-27 | add image link helper hint in admin |
| `STRIPE_PRICE_ID` | const | `367044319` | 2026-06-27 | add image link helper hint in admin |
| `StripeClass` | local | `367044319` | 2026-06-27 | add image link helper hint in admin |
| `quantity` | credit | `367044319` | 2026-06-27 | add image link helper hint in admin |
| `/api/contact` | api route | `a543adbb9` | 2026-06-27 | Add Ad Campaign Builder and Business Audit tools |
| `upvote` | credit | `9c689ef7b` | 2026-06-28 | points system |
| `/api/admin-inquiries` | api route | `9a041b57e` | 2026-06-30 | merge contract api into one function, fix sop bug |
| `/api/submit-inquiry` | api route | `9a041b57e` | 2026-06-30 | merge contract api into one function, fix sop bug |
| `/api/marketer-contracts` | api route | `9a041b57e` | 2026-06-30 | merge contract api into one function, fix sop bug |
| `todaysGiftType` | function | `16cc5eef1` | 2026-07-02 | Redesign daily gift: all-tools rotation, rollover, home-feed |
| `StoreTestBuild` | function | `9ff0ffd88` | 2026-07-04 | final |
| `/api/store-test-build` | api route | `9ff0ffd88` | 2026-07-04 | final |
| `MarketerClients` | function | `58a0b8791` | 2026-07-05 | Marketer intake + luxury photo set |
| `STATUSES` | local | `58a0b8791` | 2026-07-05 | Marketer intake + luxury photo set |
| `STATUS_LABEL` | local | `58a0b8791` | 2026-07-05 | Marketer intake + luxury photo set |
| `STATUS_COLOR` | local | `58a0b8791` | 2026-07-05 | Marketer intake + luxury photo set |
| `EnhancePhoto` | function | `5258b7387` | 2026-07-06 | add Do-this-in-Chelgy tool callouts to strategies, guide & b |
| `PrintShop` | function | `32b4de2f1` | 2026-07-06 | yea |
| `PRODUCTS` | local | `32b4de2f1` | 2026-07-06 | yea |
| `COUNTRIES` | local | `32b4de2f1` | 2026-07-06 | yea |
| `SIZES` | local | `32b4de2f1` | 2026-07-06 | yea |
| `/api/print-quote` | api route | `32b4de2f1` | 2026-07-06 | yea |
| `/api/print-checkout` | api route | `32b4de2f1` | 2026-07-06 | yea |
| `SALES_ADS` | const | `8ef22138c` | 2026-07-08 | text-only freebies, sales find-clients tab, why-chelgy premi |
| `HF2_LOOKS` | const | `b2c3ffec8` | 2026-07-14 | revert Fake It to c560eec (last good twin state) |
| `HF2_FRAMING` | const | `b2c3ffec8` | 2026-07-14 | revert Fake It to c560eec (last good twin state) |
| `buildHF2Prompt` | function | `b2c3ffec8` | 2026-07-14 | revert Fake It to c560eec (last good twin state) |
| `HighFashion2` | function | `b2c3ffec8` | 2026-07-14 | revert Fake It to c560eec (last good twin state) |
| `hf2Std` | credit | `b2c3ffec8` | 2026-07-14 | revert Fake It to c560eec (last good twin state) |
| `hf2High` | credit | `b2c3ffec8` | 2026-07-14 | revert Fake It to c560eec (last good twin state) |
| `FakeIt` | function | `b291e3084` | 2026-07-16 | CHELGY-6E02466D: Fake It — add Veo + Seedance video (animate |
| `TRAIN_COST` | local | `b291e3084` | 2026-07-16 | CHELGY-6E02466D: Fake It — add Veo + Seedance video (animate |
| `IMAGE_COST` | local | `b291e3084` | 2026-07-16 | CHELGY-6E02466D: Fake It — add Veo + Seedance video (animate |
| `MIN_PHOTOS` | local | `b291e3084` | 2026-07-16 | CHELGY-6E02466D: Fake It — add Veo + Seedance video (animate |
| `/api/fakeit-train` | api route | `b291e3084` | 2026-07-16 | CHELGY-6E02466D: Fake It — add Veo + Seedance video (animate |
| `/api/fakeit-generate` | api route | `b291e3084` | 2026-07-16 | CHELGY-6E02466D: Fake It — add Veo + Seedance video (animate |
| `IDEAS` | local | `b291e3084` | 2026-07-16 | CHELGY-6E02466D: Fake It — add Veo + Seedance video (animate |
| `/api/fakeit-video` | api route | `b291e3084` | 2026-07-16 | CHELGY-6E02466D: Fake It — add Veo + Seedance video (animate |
| `cat_fakeit_old` | tool id | `b291e3084` | 2026-07-16 | CHELGY-6E02466D: Fake It — add Veo + Seedance video (animate |
| `compressVideoForUpload` | function | `52687069b` | 2026-07-17 | CHELGY-DC4C9D38: fix AI Editor upload — remove broken in-bro |
| `MAX_DIRECT` | local | `52687069b` | 2026-07-17 | CHELGY-DC4C9D38: fix AI Editor upload — remove broken in-bro |
| `TUS_CHUNK` | const | `926fa85e5` | 2026-07-17 | CHELGY-7E7007EC: resumable uploads via tus-js-client (Supaba |
| `b64meta` | function | `926fa85e5` | 2026-07-17 | CHELGY-7E7007EC: resumable uploads via tus-js-client (Supaba |
| `musicScoreMin` | credit | `3ee6809b3` | 2026-07-21 | CHELGY-21774227: original cinematic score on the video edito |

## Biggest deletions (the likely overwrites)

A commit that removes far more than it adds is usually a whole-file drop-in rather than an edit. Check these first.

| removed | added | commit | date | subject |
|---|---|---|---|---|
| 1621 | 1621 | `b9a667e09` | 2026-07-22 | CHELGY-7F198D75: uppercase big display headlines; body font  |
| 1614 | 1614 | `699dd43fc` | 2026-07-22 | CHELGY-CED37E91: Cormorant serif as the app-wide body font,  |
| 1007 | 1007 | `946df2497` | 2026-07-22 | CHELGY-94A1B81C: larger body text for Cormorant readability; |
| 924 | 36 | `54cd22247` | 2026-06-26 | move to src |
| 675 | 249 | `0a656d925` | 2026-07-22 | CHELGY-0BF4624D: CAVELINE loads app-wide as the display font |
| 444 | 90 | `58508cc8e` | 2026-07-05 | Add self-contained UGC Studio tool with Seedance-2.0-only vi |
| 422 | 145 | `b291e3084` | 2026-07-16 | CHELGY-6E02466D: Fake It — add Veo + Seedance video (animate |
| 350 | 94 | `b2c3ffec8` | 2026-07-14 | revert Fake It to c560eec (last good twin state) |
| 275 | 59 | `506a54d12` | 2026-07-14 | Fake It: rebuild on Gemini reference photos |
| 251 | 251 | `ec4267755` | 2026-07-22 | CHELGY-BF2E138F: dark mode sweep — themed 168 white backgrou |
| 213 | 213 | `fe578f936` | 2026-07-22 | CHELGY-64BC8BCE: Bodoni Moda for app titles (Caveline stays  |
| 198 | 70 | `5258b7387` | 2026-07-06 | add Do-this-in-Chelgy tool callouts to strategies, guide & b |

## Recovering one

The last commit that still had `num_frames` is the one BEFORE `fc2949c22`. To read it:

```bash
git show fc2949c22^:src/App.jsx > /tmp/before.jsx
grep -n "num_frames" /tmp/before.jsx
```

That gives you the old version of the whole file to copy the piece out of. Don't check the old file in wholesale -- that is the same move that caused this.
