# Nutrition Tracker Zero

**Voice integration:** Deepgram is now the default provider through a common voice interface. The complete Vapi implementation remains available as an alternative. See [Voice providers](docs/VOICE_PROVIDERS.md) for setup, switching, architecture and verification. The Vapi-specific sections below document the preserved implementation.

A daily voice food log for a few friends, running on free tiers only. At each person's call time their
phone rings **inside the app** (a full-screen call, like a normal phone call). Answering starts a
**Vapi web call**. The assistant asks what they ate, reads the list back, and saves it through a
webhook. Nutrition comes only from a **shared foods table that people fill in**. Our side makes no LLM
or nutrition-API calls. Once anyone enters a food's values, everyone's past logs of that food count
automatically.

On top of the log sit **personal targets and a weekly report** that is honest about what it does not know:
targets worked out from a short profile with published equations (no AI), a Report tab that says how many days
count and what stood out, and a "Nutrient mix" summary that is withheld whenever the data cannot support it.
That part stores body measurements, so it has its own access control and privacy rules: see
[Personal targets, the weekly report and privacy](#personal-targets-the-weekly-report-and-privacy).

[PLAN.md](PLAN.md) has the design and the reasoning behind the daily call;
[WEEKLY_BREAKDOWN_PLAN.md](WEEKLY_BREAKDOWN_PLAN.md) has the research, the rules and the phases of the targets and the report.

| Path | What |
|---|---|
| [worker/](worker/) | Cloudflare Worker (TypeScript, zero runtime deps), D1 migrations, tests, `scripts/replay-vapi.mjs` |
| [app/](app/) | Bare React Native 0.83.1 app (Android first; iOS builds for your own phone) |
| [scripts/migrate-from-mongo/](scripts/migrate-from-mongo/) | One-off import of the old app's history |

---

## Worker

### Local development

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars          # APP_TOKEN for wrangler dev
npm run db:migrate:local
npm run dev                             # http://localhost:8787
curl localhost:8787/health
```

### Tests

```sh
npm test             # 716 unit + integration tests in the Workers runtime (local D1)
npm run typecheck
npm run fixtures:app # rewrites app/__tests__/fixtures/*.json from the engine (see below)
```

Integration tests cover the D1 features we rely on, the cross-user resolution cascade, the Vapi webhook
scenarios (save, duplicate, correction, no-list, start failure, metadata fallback), a scan proving no
response contains a stored Vapi key, and a canary scan proving no response outside the health routes (and no
log line) carries a body measurement. The targets engine and the weekly report are tested against independent
Python implementations (`test/reference/`, the plan's Appendices E and F): sixteen personas, 400 random profiles,
ten report scenarios and 100 random weeks must agree. The app's report screens are tested against reports the
Worker's engine really produced (`app/__tests__/fixtures/`); a Worker test fails when those files drift, and
`npm run fixtures:app` regenerates them.

### Replaying Vapi webhooks

```sh
APP_TOKEN=dev-app-token-change-me node scripts/replay-vapi.mjs \
  --base http://localhost:8787 --user "Asha" --local --scenario all     # save | duplicate | correction | no-list
```

The script reads the profile's webhook token from D1 through wrangler (it is never printed), posts the
sample payloads from `test/fixtures/vapi/`, and checks the results through the API. Use `--remote`
and the workers.dev URL to run it against production.

### API

All routes need `Authorization: Bearer <APP_TOKEN>` except `/health` and the webhook. Routes marked † also
need `X-User-Id`. Routes marked ‡ also need `X-Profile-Secret`, the profile's own secret (see below): the
shared token alone is refused with 403 `profile_secret_required` / `profile_secret_invalid`.
Errors look like `{"error": {"code", "message"}}`.

| Route | Purpose |
|---|---|
| `GET /health` | Liveness |
| `GET /meta` | Units, base units, meals, nutrient catalog |
| `GET/POST /profiles` | List (id and name only) / create profiles (409 `name_taken`). Create also returns the profile's one-time `secret` |
| `POST /auth/register` | Create an account: `{username, password}` (password 8–128 characters). Makes the profile (the username is its name, 409 `name_taken`) and answers like `POST /profiles`: the profile and its one-time `secret` |
| `POST /auth/login` | `{username, password}` → `{profile}`. The username ignores case; one 401 `invalid_credentials` for a wrong password, an unknown username and a profile that has no password |
| † `POST /me/secret` | A profile made before secrets existed claims one, once (409 if it already has one) |
| † `GET/PUT /me/settings` | Name, timezone, call time, enabled, `vapi.configured`, last call. PUT accepts `vapiPublicKey` (write-only) |
| † `GET/PUT /me/goals` | Daily targets with their origin (recommended, custom, care team); `null` resets to recommended. Personal numbers only with the secret; typed values are bounded (plan 6.4) |
| ‡ `GET/PUT /me/profile` | The health profile; `PUT` takes the profile and a transient safety block (never stored), runs the gates, stores a new target set |
| † `POST /me/targets/preview` | The same computation without saving; reads nothing stored |
| ‡ `GET /me/targets?date=` | The target set in force that day, each target with its reason, source and evidence tag |
| ‡ `GET/POST /me/weights` · `DELETE /me/weights/:date` | Weigh-ins; a weight that moves the weight by 3% or 2 kg makes a new target set |
| ‡ `GET /me/export` · `DELETE /me/health-data` · `DELETE /me` | Everything stored about the health profile / erase exactly that / delete the whole profile |
| ‡ `GET /reports/range?from&to` | Inclusive nutrient totals and averages per logged day for any date range; includes all stored nutrients, excludes skipped days, respects hidden-number settings |
| ‡ `GET /reports/breakdown?from&to&nutrient` | Logged foods contributing to one nutrient, with per-item amounts, total and missing-value counts; up to 5,000 items, respects hidden-number settings |
| ‡ `GET /reports/weekly?start&weeks` | The weekly view: coverage, insights, energy, nutrients, the Nutrient mix, the weight line, eight weeks of history |
| † `POST /calls/start {kind}` | Records the call; returns `{callId, publicKey, assistant}` (the only response carrying the key) |
| † `POST /calls/:id/started` · `POST /calls/:id/failed` | Link the Vapi call id / record a client-side failure |
| † `GET /calls/latest` | Last call result |
| † `GET /days/:date` · `GET /days?from&to` | A day with per-item nutrients and totals / per-day totals (≤ 62 days); each carries the person's own mark on the day |
| † `PUT/DELETE /days/:date/status` | When day completion is enabled, set/clear `complete`, `partial` or `skip`; currently returns 409 `day_marking_off` |
| † `POST /days/:date/items` · `PATCH/DELETE /items/:id` | Manual add (optionally onto a no_list call) / edit / delete |
| `GET /uncached` | Global unknown foods and missing unit conversions; optional `X-User-Id` adds `mine` (newest first) and `myItemCount` on shared entries |
| `GET/POST /foods` · `GET/PUT /foods/:id` | Shared foods; writes return `resolvedCount` and any `warnings`. Impossible values (sugars over carbohydrate, …) are refused with 400 `invalid_nutrients`; a food records its `source` and `reviewedAt` |
| `POST /foods/check` | The editor's dry run: the same checks as a save, nothing written |
| † `GET /foods/gaps` | Foods eaten in the last four weeks that lack values the weekly view needs, most energy first |
| † `GET /foods/history` | The foods this profile logs, ranked for each meal by how often and how lately (the log screen's suggestions). Only the profile's own log is read, the last 180 days |
| `POST/DELETE /foods/:id/aliases[/:alias]` · `PUT/DELETE /foods/:id/units/:unit` | Aliases and unit conversions (each re-resolves affected items) |
| `POST /maintenance/resolve-pending` | Re-match all pending items (run after an import) |
| `POST /vapi/webhook/:token` | Vapi `tool-calls` and `end-of-call-report` |

---

## Current feature switches

`FEATURES.dayCompletion` in `worker/src/domain/features.ts` is currently **false**; the app shares that switch through
`app/src/config/features.ts`. The complete/incomplete/skip controls and voice question are hidden. Stored day marks are preserved
but ignored by daily and report reads, including range totals and breakdowns. The weekly engine's automatic data-quality rules
still apply. References below to manual day marks describe the behavior when this switch is enabled. Restore it by setting it
to `true`, rebuilding both apps and redeploying the Worker; no database migration is needed.

Tap a nutrient on Today or Report to see the logged foods contributing to its total. Report periods include day, week, month,
year and custom dates, with **By day / By food** grouping over spans. Unknown contributions remain unknown; hidden-number mode
does not reveal amounts. Pending separates **My pending items** from **Global pending items**; the tab badge counts your own items.

During a voice call, ask “call me again in 20 minutes” or specify a local clock time. The phone schedules one callback at a time,
with Cancel on Today. See [Voice providers](docs/VOICE_PROVIDERS.md#call-back-requests) and
[reminder delivery](docs/REMINDER_DELIVERY.md#requested-call-backs-call-later) for platform behavior and validation.

## Personal targets, the weekly report and privacy

**What it does.** A short profile (birth year, sex used for calculations, height, weight, activity, goal, eating pattern) gives
personal targets: energy from the 2023 National Academies equation shown as a range, protein per kilogram, fibre, sodium and
saturated fat and added-sugar limits, and vitamin and mineral reference intakes for the person's age and sex. Nothing is guessed by
a model, every number carries its source and an evidence tag, and "How we calculate this" is one tap away. The Report tab leads with
what is useful rather than a score: how many days count and how sure the figures are; **what was logged per day** (energy, protein,
carbohydrate and fat, with the share of energy, "at least" where values are missing, and how the week compares with the last three or
four weeks once there are enough of them); what stood out (at most three sentences); energy against the target; the rows that matter
for the goal; vitamins over four weeks; and **what is missing or uncertain** (foods without the values the report uses and which values
those are, amounts worth a second look, and where the numbers come from: pack labels, food databases, recipes, guesses or nobody said).
The **Nutrient mix** score is switched off by default (`NUTRIENT_SCORE`, below); where it is on, it comes last, is **withheld** on thin
data and **never rises because data is missing**. A person who gives no profile gets the general reference, labelled as such. Day
marks, a weight line and a trend, and a list of foods with missing values complete it. The rules and the evidence are in
[WEEKLY_BREAKDOWN_PLAN.md](WEEKLY_BREAKDOWN_PLAN.md).

**Four modules, kept apart.** The engine is pure TypeScript in `worker/src/domain/`: `targets/` (what a person is compared against),
`intake/` (what was logged, in nutrients: an item's amounts and grams, a day's energy, a nutrient's total and how much of it is known),
`quality/` (what is complete, missing or uncertain: day states, coverage, the food checks, foods with gaps, amounts worth a check) and
`report/` (the weekly view built from the other three: assessments, insights, trends, the score). `reference/` holds the published
tables they read. `test/unit/architecture.test.ts` fails if a module imports one it should not (only the report uses all three; the
data-quality checker reads intake; intake and the target calculator know nothing of the others) or if any of them reaches for the
database.

**Incomplete days and amounts.** Unknown is never zero. A past day with very little logged is left out of the weekly figures, and the
Today screen asks "Is that everything you ate?" with **It is complete** and **Leave this day out** one tap away; the report's insight
opens that day. A logged amount past the usual edges (more than 2,000 kcal in one item, more than 6 katoris or bowls, 1.5 kg, 3 litres)
gets **Check the amount** on Today and leads the report's data insights: it is often a misheard "two" or a kilogram for a katori, and
it still counts until the person changes it. The voice assistant now reads back an unusually large amount before recording it. Each
item shows what its amount comes to in grams when the food says ("2 katori · about 300 g").

**Raw or as eaten.** A food records whether its numbers are for it as eaten or raw and dry, before cooking (migration 0004). 100 g of
dry rice has about three times the energy of 100 g of cooked rice, so a raw food with a katori, bowl, plate or serving conversion gets a
question in the editor and on the conversion screen, and the editor shows conversions in grams ("1 katori = 150 g"). No food values
were added by this work: the shared foods table is still filled in by people, from labels (the plan's decision Q14).

**Who gets personal targets.** Adults 19 and over, through a safety check whose answers are used once and never stored. Someone who is
pregnant or breastfeeding, has had an eating disorder, or follows a clinician's diet gets amounts only (and low-pressure mode, with no
calorie, weight or score numbers, for the eating-disorder answer); a BMI outside 16 to 60 gets no personal targets; loss goals need a BMI
of 25 or more (23 on the India set below). A reference-only profile stores no body data and nothing that says why.

**Two reference sets.** The profile picks which published tables the numbers are read from; the National Academies set is the default.
Energy is the National Academies' 2023 equation on both, and `GET /meta` lists the sets.

| | US and Canada (National Academies) | India (ICMR-NIN, 2020) |
|---|---|---|
| Protein, never planned below | 0.8 g per kg | 0.83 g per kg |
| Fat, usual range | 20% to 35% of energy | 15% to 35% |
| Fibre | 14 g per 1,000 kcal, at least 25 g | 15 g per 1,000 kcal, at least 25 g |
| Sodium | 2,300 mg | 2,000 mg (about 5 g of salt) |
| Potassium | 2,600 mg women, 3,400 mg men | 3,500 mg |
| Added sugars | 10% of energy (WHO) | 5% of energy (Dietary Guidelines for Indians, 2024) |
| Iron, zinc, vitamin B12 | Recommended Dietary Allowance; iron 1.8 times higher on a plant-based diet | **Estimated Average Requirement** (the allowance is named in the explanation); no plant-based multiplier |
| Age bands | 19-30, 31-50, 51-70, over 70 | 19-59, 60 and over |
| Loss goals offered from BMI | 25 | 23 |

Changing the set, or crossing a band edge on a birthday, adds a new versioned target set; the old one stays in the history. The tables
are in `worker/src/domain/reference/{nasem,icmr}.ts`, each with a content hash that a test snapshots, so a change to a number is a
visible diff. The ICMR tables were read from a secondary copy of the report and **have not been checked by a second person against the
official book**; do that before relying on them (the plan's section 11.7).

**This is health data, so the old "friends-only, non-sensitive" assumption no longer holds for it.**

- **Account access.** Registration and username/password login return a 256-bit credential that the app stores automatically in
  Keychain / Keystore and sends as `X-Profile-Secret`. The Worker stores only credential hashes. Login adds a session in
  `account_sessions` without invalidating existing phones or changing saved health data. Every health route and the weekly report
  still refuse the shared app token alone. Existing installations keep using their stored credentials. No recovery code is shown
  or required: if secure storage is missing or stale, **Log in again** restores access with the account password. Credentials persist
  until the account is deleted or the deployment owner revokes them; there is no automatic expiry. The old `POST /me/secret` claim
  remains only for API compatibility and is no longer called by the app.
- **Nothing health-related leaves the Worker.** The voice assistant's prompt, first message and metadata never contain any of it (a canary
  test enforces this), no log line carries a profile field or a request body, and there are no analytics or advertising SDKs. The call
  itself still goes to Vapi and the providers it uses: set Vapi's **Zero Data Retention** on each account.
- **Export and erasure.** `GET /me/export`, `DELETE /me/health-data` (leaves the food log), and `DELETE /me` (everything, in one ordered
  batch). Erased rows leave D1's Time Travel backups within its window (7 days Free, 30 Paid); the in-app wording says "within 30 days".
- **Retention.** Call transcripts are emptied after 30 days: a daily schedule (`triggers.crons`) does it for everyone, and an expired
  transcript is never served even before it has run.
- **Residual risk.** Food logs and call transcripts remain reachable with the shared token alone, as before, until you set
  `REQUIRE_SECRET` (below). A breach runbook is in [docs/BREACH_RUNBOOK.md](docs/BREACH_RUNBOOK.md).

**Deployment switches** (`worker/wrangler.jsonc` `vars`; empty means off):

| Var | Effect | When to turn it on |
|---|---|---|
| `NUTRIENT_SCORE` = `1` | The weekly report shows the **Nutrient mix** score. Off by default: the report leads with the days that count, what was logged on average, what stood out and what is missing, because a score looks surer than incomplete food data allows | Once the foods people eat most have their mineral and sodium values (the **Foods with gaps** list in the Pending tab, and the report's "What is missing" card, show how far that is) |
| `SCORE_MODERATION` = `1` | Saturated fat and added sugars join the Nutrient mix (75 points instead of 55) | Once the foods people eat have values for both, which the **Foods with gaps** list in the Pending tab helps with. Until then every score would be withheld for thin data |
| `CALIBRATION` = `1` | An **experimental** suggestion of maintenance energy from four weeks of logs and the weight trend. Never applied to a target; nothing validates it | Only if you want to look at it |
| `REQUIRE_SECRET` = `1` | Every profile route, not only the health ones, needs a stored account credential. Password login grants it automatically; existing credentials also work | After every friend has updated and logged in. The voice webhook has its own token and is not affected |

**Not done, and why it matters.** The plan's expert reviews are not something code can do: a dietitian reading the gate matrix, the
floors, caps and every string; a reader with eating-disorder expertise for low-pressure mode and the safety wording; a privacy and legal
read of the data inventory and the store declarations (DPDP Act, Apple, Google Play). **Until they are signed off, the audience is your
own circle** (WEEKLY_BREAKDOWN_PLAN.md 8.7, 11.7). Everything they need to read is in one document, generated from the code:
[docs/REVIEW_PACKET.md](docs/REVIEW_PACKET.md) (`cd worker && npm run review:packet` after any change). The same goes for a second person re-deriving every reference table (the ICMR-NIN
ones especially, see above), and for the Hindi strings, which are not written.

---

## App

### On-device mode: no server to host

`ON_DEVICE = true` in `app/src/config/local.ts` (the default in `local.example.ts`) runs **the whole Worker inside the app**, on the
phone's own SQLite file. There is nothing to deploy, no Cloudflare or any other account, and nothing but the Vapi call leaves the
phone. It is the same code that runs on Cloudflare (`worker/src`: router, rules, report engine, migrations), not a port:

| Piece | Where | What it does |
|---|---|---|
| [app/src/embedded/d1.ts](app/src/embedded/d1.ts) | app | A D1 look-alike over SQLite (`prepare/bind/first/all/run/batch`; a batch is one transaction), plus the migration runner |
| [app/src/embedded/opSqlite.ts](app/src/embedded/opSqlite.ts) | app | The phone's SQLite file (`@op-engineering/op-sqlite`), foreign keys on as on D1 |
| [app/src/embedded/runtime.ts](app/src/embedded/runtime.ts) | app | Applies `worker/migrations` on first launch, builds the Worker's `env` (`ON_DEVICE=1`, the deployment's defaults) and answers `request()` |
| [app/src/embedded/polyfills.ts](app/src/embedded/polyfills.ts), `url.ts`, `request.ts` | app | What Hermes lacks and the Worker expects: `crypto.subtle` SHA-256 and `timingSafeEqual`, `randomUUID`, a UTF-8 `TextEncoder`/`TextDecoder`, a `URL` that reads `pathname` and `searchParams`, a stream body on `Request` |
| [app/src/embedded/vapi.ts](app/src/embedded/vapi.ts) | app | `CallBridge`: turns the call's client messages into the `tool-calls` and `end-of-call-report` payloads Vapi's server would have posted, and gives them to the Worker's own webhook handler |

**The voice call without a webhook.** Vapi cannot call a phone, so on-device the assistant's `save_foods` tool has no `server.url`.
Vapi then treats it as a *client-side* tool: the SDK sends the call to the app (`tool-calls` message) and the model gets no result
back, so the prompt says not to wait for one and the tool is `async`. The app also reads the same call out of the
`conversation-update` history as a fallback, and a call already handled is never saved twice. A corrected list still replaces the
call's earlier one. When the call ends the app writes the end-of-call report (the words spoken, how it ended), so "no list was saved"
and the manual form work exactly as when hosted.

Checked on 2026-10-13 against a real Vapi web call from the emulator (the replies were sent as text, so no voice was needed): the
assistant was accepted with no server, the SDK delivered `tool-calls` with an `id` and `arguments` as an object (the shape in
`app/__tests__/embedded/vapiBridge.test.ts`), the Worker inside the app saved the two items, and the call closed as `tool_saved`
with the transcript.

**What changes compared with a hosted Worker**
- Your data lives **only on the phone**. Uninstalling the app or clearing its storage erases it, and nothing is backed up
  (`allowBackup="false"`, deliberately: it holds food and body measurements). There is no second device.
- No friends sharing one foods table: the foods table is yours alone. Everything else (targets, the weekly report, the ring, the
  voice check-in) is unchanged.
- The Vapi **public key** and credit are still yours (a free account gives $5, about 2 to 3 weeks of daily calls).

After adding a migration to `worker/migrations`, run `npm run gen:migrations` in `app/` (`npm test` fails when it is stale).
Set `ON_DEVICE = false` to talk to a Worker over HTTP again.

### Configure

```sh
cd app
npm install
cp src/config/local.example.ts src/config/local.ts    # git-ignored: ON_DEVICE, API_BASE_URL, APP_TOKEN
```

- **On the phone, no server (`ON_DEVICE = true`):** nothing else to set. `API_BASE_URL` is not used.
- **Local Worker on the emulator or a USB phone (`ON_DEVICE = false`):** keep `API_BASE_URL = 'http://localhost:8787'` and run
  `npm run adb:reverse`, which reverses ports 8787 and 8081.
- **Deployed Worker (`ON_DEVICE = false`):** set `API_BASE_URL` to the workers.dev URL and `APP_TOKEN` to the production token.

### Run (debug)

```sh
npm start                                                   # Metro
cd android && ./gradlew app:installDebug -PreactNativeArchitectures=arm64-v8a
```

The app id is `com.nutritiontrackerzero`, so it installs next to the old app.

### Release APK for friends

1. Make a keystore **outside the repo**, once:
   ```sh
   keytool -genkeypair -v -storetype PKCS12 -keystore ~/keys/ntz-release.jks -alias ntz -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Add to `~/.gradle/gradle.properties` (not the repo):
   ```
   NTZ_RELEASE_STORE_FILE=/Users/<you>/keys/ntz-release.jks
   NTZ_RELEASE_STORE_PASSWORD=…
   NTZ_RELEASE_KEY_ALIAS=ntz
   NTZ_RELEASE_KEY_PASSWORD=…
   ```
3. With `local.ts` set (`ON_DEVICE = true` for a phone that needs no server, or pointing at the deployed Worker):
   `cd android && ./gradlew app:assembleRelease -PreactNativeArchitectures=arm64-v8a` →
   `app/android/app/build/outputs/apk/release/app-release.apk`. Without the properties the APK is built unsigned.
4. Put it on the phone: `adb install -r app-release.apk` over USB (USB debugging on), or copy the file to the phone (cable, Drive,
   a chat) and open it; Android asks to allow installs from that app once. Every update must be signed with the same keystore.

### iOS (your own phone)

`cd ios && pod install`, open `habit_builder_app.xcworkspace` in Xcode, choose your personal team, and run.
Free Apple IDs expire apps after 7 days. Daily reminders use a native repeating calendar notification,
with a sound and an **Answer** action that opens the voice call, including after the app is swiped away.
The selected profile time zone is preserved across DST. No APNs, paid notification entitlement, or
server scheduler is needed. Enable notifications, sounds and immediate delivery; Focus, silent mode
and Scheduled Summary can silence or postpone ordinary notifications. The optional existing VoIP
receiver is disabled unless `EnableRemoteVoIP` is explicitly enabled in Info.plist.

Rebuild/install the native app after this scheduling update, then open it once to migrate the saved
schedule. Android needs **Alarms & reminders**, notifications, and (for the full-screen surface)
full-screen-intent access; **Reminder health** shows the required settings. Swiping away the app is
supported. Android **Force stop** deliberately cancels alarms: reopen the app to restore them.
See [docs/REMINDER_DELIVERY.md](docs/REMINDER_DELIVERY.md) for the root cause and device checks.

### Tests

```sh
npm test            # Jest: API client, schedule math (incl. DST), ring payloads, conversions, reconciliation,
                    # the onboarding flow and its safety gates, the report screens, the log screen and its suggestions,
                    # the food form and its paste format, the light/dark choice, the string lint
npm run typecheck
npm run lint
```

### UI

Light and dark themes follow the system setting until the person chooses one in Settings (Appearance: System, Light or Dark). Every screen is assembled from one small design system:

| Path | What |
|---|---|
| `src/theme/` | Colours (`palette.ts`), type scale (`typography.ts`), spacing and radii (`layout.ts`), and `ThemeProvider` / `useTheme` / `createStyles` |
| `src/components/kit/` | The primitives: `Text`, `Button`, `Card`, `Field`, `Chip`, `Sheet`, `ListGroup`, `Notice`, `ProgressRing`… |
| `src/components/layout/` | Screen frames: `TabScreen` (large title and profile button), `StackScreen` (header, footer action, keyboard handling) and the tab bar |
| `src/components/{report,health,weight,food}/` | The weekly report cards, the personal-targets flow, the weigh-in sheet and the foods-with-gaps list |
| `src/i18n/strings.ts` | Every user-facing string of the targets and report modules in one table; `__tests__/copy.test.ts` lints it |

Rules that keep it consistent: screens take colours from `useTheme()` and text styles from `Text` variants, never hex values or raw font sizes; colour means status (green on target or within a limit, amber worth a look, grey for "not enough data"; red is kept for an exceeded safety ceiling and for data problems, never for eating less or more than a target), not category, and no state depends on colour alone; and `__tests__/palette.test.ts` fails if any text colour drops below WCAG AA contrast, or if the Android colour files (`res/values` and `res/values-night`, which paint the incoming-call screen and the window before React Native draws) drift from `palette.ts`. The in-app voice screen follows the same light/dark choice as everything else; the native ring screen is drawn by Android before the app runs, so it follows the phone's own setting. Inter (SIL Open Font License) is bundled for Android in `android/app/src/main/assets/fonts`; iOS uses the system font. The tab called **Pending** is the `Uncached` route.

### Logging food, and entering a food's values

**Log food** (`AddItemsScreen`) is a list you build. Pick the meal (it starts on the one that fits the time of day), pick foods, set each
amount with − and + (a tap moves it by what is natural for the unit: a piece, half a katori, ten grams), and add them all at once. Each
food keeps the meal it was added under, so a whole day goes in one visit (add breakfast, change the meal, add lunch; tap the chosen meal
again for no meal, and the food is listed under Other). The
foods on offer are the profile's own, from `GET /foods/history`: ranked for each meal by how often and how lately it was logged there,
frequency and recency in one score (a day counts half as much for every 21 days it goes back, `worker/src/domain/history.ts`), with
the amount the person usually has. Two people, and two meals, never share a list. A meal the profile has nothing logged for shows a
short list of common foods for it instead (`src/data/commonFoods.ts`: names and amounts, never nutrient values) and only then. The same
list is a searchable dropdown; a food that is not found can be added as a **new food item** (it opens the food form and comes back to the
log screen with the food ready to log) or logged by name without values, as before. An older Worker without the route is fine: the
screen says it could not load the usual foods (with a Retry) and falls back to the common foods and the foods list.

**The food form** (`FoodEditorScreen`) has two ways in, and both fill the same fields, so a food is the same food either way.
*Enter manually* shows every nutrient at once, in groups (pack label, minerals, vitamins); **a field left empty is saved as 0**, not as
unknown (except that editing a food whose value was unknown leaves it unknown when the field stays empty; the app asks first about a food with nothing in it, or with no calories beside its macros). *Paste data* hands out a prompt for
any chat assistant, built from `GET /meta` so it asks for exactly the fields the app reads, and reads the answer back: one JSON object
with `name`, `per`, `form`, `source` and one field per nutrient named by its key and unit (`protein_g`, `sodium_mg`, `calories_kcal`, ...).
The reader forgives what assistants get wrong (trailing commas, comments, curly quotes, a sentence or a code fence around the data, a
number written with its unit such as "0.4 g") but refuses a field in the wrong unit, a form it does not know and anything that is not a
number, and lists every problem with its line (`src/utils/foodData.ts`, `src/utils/looseJson.ts`).
Because a field left empty is 0, the Worker's "a part cannot be larger than its whole" checks (sugar over carbohydrate, fibre over
carbohydrate, saturated fat over fat, added sugar over sugar) apply only when the whole is above zero; typed contradictions are still
refused.

**Appearance.** Settings has System (the default), Light and Dark. The choice is kept on the phone and handed to Android too, so
dialogs and pickers follow it (`src/theme/`).

### How the daily call works

- **Arming.** Android stores the schedule natively and arms an exact `AlarmManager.setAlarmClock`
  one-shot (when permitted). The native receiver starts `IncomingCallService` directly, with no JS
  delivery callback. It computes and arms tomorrow in the profile's time zone before ringing today.
  Native recovery restores the alarm after reboot, app update, clock changes and an exact-alarm grant.
  iOS stores an OS-managed repeating `UNCalendarNotificationTrigger` with an explicit time zone;
  the system plays the sound while the app is closed, and tapping opens the voice call.
- **Answer.** Opens the call screen, which runs `POST /calls/start`, then `vapi.start(assistant)`, then
  `POST /calls/:id/started`.
- **On the call, like a phone call.** The call opens on the earpiece (or a connected headset), not the loudspeaker: Daily,
  under Vapi, defaults to its loudspeaker "video" mode, so `openOnEarpiece` switches it to "voice" before it joins. The
  call screen has **Phone | Speaker** (plus **Bluetooth** or **Headphones** when connected) to switch at any time. While
  the earpiece is in use the screen turns off against the ear and touches are ignored. Android: the `CallAudio` native
  module (`android/.../callaudio/`) routes with `setCommunicationDevice` on Android 12+ (the speakerphone and Bluetooth
  SCO switches before that), holds a `PROXIMITY_SCREEN_OFF_WAKE_LOCK` (the system switches the screen and touch off,
  as dialers do), keeps the chosen route if something else moves it, and moves the call to a headset that connects
  mid-call. iOS: Daily routes, and `UIDevice` proximity monitoring blanks the screen. JS side:
  `src/services/calls/callAudio.ts` and `audioRoute.ts`.
- **No answer after 60 s.** A missed-call notification appears with **Log now** and **Snooze (10 min)**.
  A scheduled call also re-rings **once** 60 min later; the native side schedules this, so it works with
  the app killed. Snooze replaces that retry. A decline never retries.
- **Recovery.** Launch/resume synchronizes the cached schedule to native scheduling, migrates old
  Notifee heartbeat triggers, and consumes native answer/miss markers. Disabling calls/signing out
  cancels native daily alarms and retry/snooze alarms. **Send test call now** uses the same native
  delivery path. Reminder delivery has no service fees and does not call an AI provider until answered.

---

Saved personal details are loaded before the edit form is initialized. Saving or reloading health settings refreshes the target
views, daily summary and weekly reports through `HealthContext`; the Worker remains the source of effective targets. Custom targets
still override calculated recommendations, and historical reports keep using the target versions that were in force on each day.

For this update, hosted deployments must apply migration `0007_account_sessions.sql` before deploying the Worker, then install the
updated app. On-device databases apply the bundled migration automatically at launch. Existing account passwords and health rows
are unchanged; a signed-in installation with a missing credential uses **Log in again**.

After a hosted update, run `node worker/scripts/check-personal-settings.mjs` from the repository root to check the actual login,
setup, edit and target contract. It creates and deletes a disposable test account and prints no credentials. The app verifies that
login grants access to personal settings before accepting the account; an outdated server response stays on Login with an error
instead of returning to another login prompt.

## Deploy (Phase 5)

**You, in a browser (one time):**
1. Create a free account at `dash.cloudflare.com/sign-up` (no card needed).
2. Workers & Pages → choose your **workers.dev subdomain**.
3. Run `cd worker && npx wrangler login` and click **Allow** in the browser tab that opens.

**Then, from the CLI:**
```sh
cd worker
npx wrangler whoami
npx wrangler d1 create nutrition-zero --binding DB --update-config     # writes database_id into wrangler.jsonc
npx wrangler d1 migrations apply nutrition-zero --remote
openssl rand -base64 32 | tr -d '\n' | tee /dev/tty | npx wrangler secret put APP_TOKEN   # copy it into app/src/config/local.ts
npx wrangler deploy                                                      # prints https://nutrition-tracker-zero.<sub>.workers.dev
curl https://nutrition-tracker-zero.<sub>.workers.dev/health
```

Never upgrade a plan or enter payment details. The free tiers (Workers: 100k requests/day; D1: 5M row
reads and 100k row writes/day) are far above what this app uses.

---

## Onboarding a friend

1. Create a free account at vapi.ai and copy the **public** key from Dashboard → API Keys.
   (The free $5 credit lasts roughly 2–3 weeks of daily ~3 min calls; after that Vapi asks them for a card.)
2. Install the APK. **Create an account** (a username and a password of 8+ characters; there is no password reset, so pick one they will remember), set a call time, and allow notifications, exact alarms and full-screen calls.
3. Settings (tap your initials, top right) → paste the Vapi key → **Send test call now**.
4. Optional: **Make your targets personal** (Report tab). Save the details to apply the calculated targets throughout the app.
   Log in with the same account to reopen saved details. In on-device mode the database stays on that phone; login does not move it
   to another phone. Use Vapi's Zero Data Retention setting on their account if they want calls not stored.

---

## Migrating the old app's history (Phase 6)

```sh
cd scripts/migrate-from-mongo
npm install
npm test && npm run test:e2e                      # transform tests + apply sample SQL to a throwaway local D1
MONGODB_URI='…' npx tsx migrate.ts --dry-run      # counts, date styles, sample rows; writes nothing
MONGODB_URI='…' npx tsx migrate.ts                # writes out/import.sql (git-ignored)
cd ../../worker && npx wrangler d1 execute nutrition-zero --remote --file ../scripts/migrate-from-mongo/out/import.sql
curl -X POST https://<worker>/maintenance/resolve-pending -H "authorization: Bearer <APP_TOKEN>"
```

What carries over:
- Users with their call time and time zone; email and password are dropped.
- Every food entry, as a pending `import` item.
- Custom nutrient targets.

What doesn't: the old nutrition values. They all came from Spoonacular, Groq or USDA, and the new app
uses only values people enter. The imported history fills the **Pending** tab (the app's view of `/uncached`) with your real foods, most-logged
first. Re-running the import is safe.

---

## Notes and known limits

- **Not yet verified against a live Vapi call.** The Phase 3 spike needs a Vapi public key. It checks
  that webhooks fire for web calls and records real payloads as fixtures. The assistant's
  model/voice/transcriber in `worker/src/vapi/assistant.ts` are defaults until the old dashboard
  assistant's values are copied in.
- **The webhook token is part of the URL.** Request logs (wrangler's console, Workers Logs) therefore show
  it, and only the account owner can read those. The Worker's own log lines record ids and statuses only.
- **The shared `APP_TOKEN` ships inside the APK.** Anyone holding it can read and write the food log and the
  call transcripts of any profile (the transcripts are emptied after 30 days), unless `REQUIRE_SECRET` is on. Body measurements, targets
  and the weekly report are different: they need the profile's own secret as well (see *Personal targets, the weekly report and privacy*).
  Rotate the token with the steps in [docs/BREACH_RUNBOOK.md](docs/BREACH_RUNBOOK.md).
- **Accounts are deliberately basic.** Log in and Create account (a username, which is the profile's name, and a password) keep the
  screens honest and the data apart, nothing more. The password is stored as PBKDF2-SHA256 with a per-password salt, but at 20,000
  iterations (1,000 inside the app, `ON_DEVICE`), far below the 600,000 OWASP now asks for: Cloudflare's free plan allows 10 ms of CPU
  per request and 100,000 iterations already take about 8 ms on a fast laptop. The count is stored in each hash (`worker/src/auth.ts`), so
  raising it later leaves existing passwords working. What is **not** there: a password reset or change (nothing can send an email, so a
  forgotten password cannot be recovered), rate limiting or lockout of wrong guesses, and automatic session expiry. A login returns a securely stored credential and the profile's id,
  which the app keeps and sends as `X-User-Id`, exactly as before, so the shared `APP_TOKEN` plus a profile's id still reach that profile's
  food log. `GET/POST /profiles` are still open to the shared token (the app no longer calls them): `GET` lists every username, and `POST`
  makes a profile with no password. A profile made before accounts has no password and cannot log in once logged out. Health data uses the credential granted automatically by password login; no separate code is required.
- **The weekly report is an estimate of what was logged.** Logged intake usually runs low, so the report says "at least" where a value
  is missing, leaves out days that look incomplete, and (where the score is switched on) withholds the Nutrient mix on thin data. It is not
  medical advice. On the India set the Nutrient mix still measures sodium and the moderation parts against the Healthy Eating Index-2020
  (its own standards), while the bars use ICMR-NIN's limit.
- **Day marks travel with the food log.** "Complete", "looks incomplete" and "leave out" are read and written with the shared token like
  the log itself (they say how a day counts, nothing about why); they are exported and erased with the health data.
- **`POST /calls` hands back the profile's Vapi public key** to whoever holds the shared token, as before this work. Only
  `REQUIRE_SECRET` closes that.
- **Plain HTTP only to this machine.** Release builds allow cleartext only to `localhost`, `127.0.0.1` and `10.0.2.2`
  (`android/app/src/main/res/xml/network_security_config.xml`), and the app refuses a non-HTTPS server address outside a debug build;
  debug builds still allow it anywhere, for Metro on the LAN.
- **`react-native-keychain` is a new native dependency** (the per-profile secret lives in the Keychain / Keystore): rebuild the app
  (`cd app/android && ./gradlew app:installDebug`, or `pod install` on iOS) before running this version.
- **Device alarms are the weak point** (Doze, OEM battery killers). The Reminder health screen shows what to fix.
- **One deviation from PLAN.md §7:** the singularizer strips a trailing "s" after "is" too, so
  idlis→idli and chapatis→chapati work as the plan's examples require.


The Reports tab supports daily, weekly, monthly, yearly, and custom date ranges. Calendar periods in progress include logs through today. Nutrient intake starts with calories and macronutrients; **View all nutrients** expands vitamins, minerals, fiber, sugars, sodium, and saturated fat. Switch between totals and averages per logged day. Partial logs count toward recorded intake, skipped days are excluded, and missing values appear as unknown or lower bounds rather than zero. Weekly target assessments remain available below the intake summary.
