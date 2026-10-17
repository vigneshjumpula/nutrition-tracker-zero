# Nutrition Tracker Zero — rebuild plan

Status: **implemented through Phase 4 + Phase 6 tooling** (2026-10-04). **Update 2026-10-12:** personal targets, the weekly report v2, per-profile secrets and the health privacy model were added on top of this design; they are specified in [WEEKLY_BREAKDOWN_PLAN.md](WEEKLY_BREAKDOWN_PLAN.md) and described in the README. Where this file says the data is non-sensitive, goals are hard-coded or only one token protects a profile, read the notes marked *(superseded)* below. Waiting on: the Phase 3 live Vapi spike (needs a Vapi public key), Phase 5 deploy (needs `wrangler login`), and the Phase 6 import run (needs OK to read `MONGODB_URI`). See README.md.
Old repo (read-only reference, never modified): `/Users/ajay_1/Downloads/project/Nutrition Tracker` (branch `mongo-deployment`, read including uncommitted changes).
New repo: `/Users/ajay_1/Downloads/project/nutrition-tracker-zero`. `[NEW_REPO_NAME]` was left blank, so this name is a placeholder. Rename the folder before Phase 1 if you want something else.

---

## 1. Decision that shapes everything: in-app call, not a phone call

The spec asked for cron-triggered **outbound phone calls** placed from each user's Vapi phone number. Vapi's docs rule that out at Rs 0:

- "Free Vapi numbers are inbound only… They cannot make international calls" ([free-telephony](https://docs.vapi.ai/free-telephony)).
- "You cannot make outbound or international calls with a free Vapi number" ([outbound-calling](https://docs.vapi.ai/calls/outbound-calling)).
- Calling +91 would need an imported Twilio/Vonage/Telnyx number or a SIP trunk. All of these are paid. Plivo with Indian numbers is blocked by TRAI rules.

**Decision (yours):** keep the old app's flow. At the user's call time the phone rings **inside the app** (a local alarm plus the native incoming-call UI). Answering starts a **Vapi web call** through `@vapi-ai/react-native`. No phone numbers are involved.

Consequences for the spec:

| Spec item | Now |
|---|---|
| Per-user Vapi private key + phone number ID + phone number | Per-user Vapi **public key** only. The SDK starts web calls with it. No private key, no phone fields. |
| Worker places calls from a 15-min cron | The **device** schedules the ring (as today). The Worker builds the inline assistant on request and receives the webhooks. **No cron in v1.** Stale calls are closed lazily when they are read (§7). |
| "No response ever returns the key" | Settings never returns it (only `configured: yes/no`). `POST /calls/start` returns the public key **to its owner only**, because the SDK needs it on the device. It is Vapi's client-side key by design. |
| Retry once ~60 min later if unanswered, max 2/day | Done on the device: if the ring times out, re-ring once 60 min later. Max 2 automatic rings per day. "Snooze" and "Log now" stay from the old app. |
| "Send test call now" | Rings the phone in ~5 s through the same alarm → answer → Vapi path, so it tests notifications, the full-screen UI, the mic and the webhooks end to end. |
| DoD "cron registered on deployed Worker" | Replaced by "the in-app ring fires at call time and the test call works end to end". |

**Unverified, so it gets checked first in Phase 3:** the Vapi docs never say outright that server tools and `end-of-call-report` webhooks fire for **web** calls. The URL-precedence rule doesn't depend on call type, and `webCall` is a valid call type, so it is likely. Phase 3 opens with a 30-minute spike: one real web call with a transient assistant pointed at the Worker. That spike also records real payloads as test fixtures.
One web-call gotcha *is* documented: a tool **without** `server.url` becomes client-side. So `save_foods` always carries its own `server.url`.

---

## 2. What the old repo is (findings)

| Area | Finding |
|---|---|
| Mobile | **Bare React Native 0.83.1 CLI** (no Expo), React 19.2, Hermes, New Arch, TypeScript strict. NativeWind 4 + Gluestack UI v3, React Navigation 7, Notifee 9, `@vapi-ai/react-native` 0.3 (Daily WebRTC), axios. Custom native modules: Android `IncomingCall` (full-screen intent, phoneCall foreground service, CallStyle notification, ringer, missed-call notification with Log now/Snooze), iOS CallKit bridge + PushKit. Jest with ~376 tests. |
| Backend | Spring Boot 3.4.2, Java 17, Spring Security + JWT, WebFlux client. Single EC2 instance in Mumbai on **plain HTTP :5000**. |
| DB | MongoDB Atlas: `users`, `food_logs`, `food_entries`, `nutrition_details`, `nutrition_cache`, `meal_schedules`, `user_nutrient_preferences`, `voice_meal_sessions`, `habits`, `habit_entries`, iOS VoIP tables. |
| Daily call | One schedule per user `{hour, minute, enabled, timezone}`. The **device** arms a daily Notifee alarm. The native ring times out after 60 s → missed notification (Log now / Snooze 10 min). On answer: `vapi.start(assistantId, {variableValues:{name}})` with the public key served by the backend. After the call, the app posts the transcript to the backend. A Groq LLM decides whether to log and then parses the foods. The backend's Vapi webhook path is effectively dead. |
| Assistant prompt / voice / model | **Not in the repo.** They live in the Vapi dashboard (two assistant IDs referenced from `backend/.env`). Needed before Phase 3, see §13. |
| Nutrition sourcing | Spoonacular `guessNutrition` first, then **Groq LLM** (`openai/gpt-oss-20b`) fallback, USDA optional. Results go into the global `nutrition_cache` (one row per normalized name, values per base unit). The scaler has real bugs, e.g. "1 cup" against a 100 g base gives ×0.01. |
| Nutrients | 17 in the catalog: calories (kcal); protein, carbs, fat, fiber, sugar (g); sodium (mg); vitamins A, D, K (mcg); C, E (mg); calcium, iron, potassium, magnesium, zinc (mg). Day totals/UI use the first 7. Goals are hard-coded in the app (2500 kcal, P180, C250, F70, sugar 40, fiber 30, Na 2300) plus per-nutrient custom targets in the weekly summary. *(Superseded 2026-10-12: the catalog has 21 nutrients, adding saturated fat, added sugars, vitamin B12 and folate; the hard-coded goals are gone, replaced by a general reference or personal targets with a source for every number.)* |
| Units | Manual picker: g, ml, oz, cup, tbsp, tsp, piece, bowl, serving + free text. Backend alias table maps katori→bowl, thali→plate, plus slice, glass, scoop, handful, packet, can, spoon, ladle, … |
| Data worth migrating | `food_entries` (+`food_logs` for user/date) = the real eating history. `meal_schedules` → call time/timezone. User names. Custom nutrient targets. **`nutrition_cache` values are not migratable** under the hard rules: every row came from Spoonacular, Groq or USDA. Its food *names* still arrive through the imported history (§10). |
| Paid / slow parts | Groq, Spoonacular, Mongo Atlas, EC2, Vapi minutes, Apple Developer Program (PushKit/APNs). |

**Mobile framework: keep bare RN 0.83 CLI.** The call flow depends on custom native modules (Android full-screen ring, iOS CallKit) plus Notifee and the Vapi RN SDK, which "is not compatible with Expo Go". Moving to Expo would mean rewriting those modules for no gain.

---

## 3. Verified platform facts (checked 2026-09-29 against official docs)

**Cloudflare** ([limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/), [D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/))
- Workers Free: 100k requests/day (resets 00:00 UTC), **10 ms CPU** per request (waiting on fetch/D1 doesn't count), 50 external subrequests per invocation, 128 MB memory, 5 cron triggers/account, 64 vars+secrets per Worker. The 3 MB bundle limit was **removed on 2026-09-04** (now 64 MiB uncompressed); not a concern either way.
- D1 Free: 10 DBs, 500 MB/DB, 5M rows read/day, 100k rows written/day, **50 queries per invocation** (plan for this), 100 bound params per statement, 100 KB per statement, 2 MB per row. `batch()` is a transaction. `json_each`/`->>` documented. Foreign keys enforced by default. No `BEGIN`/`COMMIT` in SQL files. `ON CONFLICT` / `RETURNING` are not mentioned in the D1 docs (SQLite supports them): Phase 1 proves them with a local test before relying on them.
- Wrangler v4 (4.143.0), `wrangler.jsonc` recommended. `wrangler d1 create <name> --binding DB --update-config` writes the id into the config. `d1 migrations apply <db> --local|--remote` (always pass the flag; docs disagree on the default). `wrangler secret put NAME` accepts piped stdin. `secrets.required` makes deploy fail when a secret is missing. Local secrets go in `.dev.vars`. `wrangler deploy` prints the workers.dev URL.
- A brand-new account must register a **workers.dev subdomain**; a non-interactive deploy fails without it, so that's a dashboard step for you.
- API-token route: the "Edit Cloudflare Workers" template has **no D1 permission** (add "D1 Edit"). Prefer `wrangler login`.
- Tests: Cloudflare's Vitest integration is now **`@cloudflare/vitest-plugin`** (`cloudflareTest()`, Vitest ≥ 4.1, `readD1Migrations`/`applyD1Migrations`).
- Runtime: `Intl` (IANA zones; Asia/Kolkata proven by a test in Phase 1), `crypto.randomUUID`, `crypto.getRandomValues`, `crypto.subtle.timingSafeEqual` (equal-length inputs only).

**Vapi** ([create call](https://docs.vapi.ai/api-reference/calls/create), [custom tools](https://docs.vapi.ai/tools/custom-tools), [troubleshooting](https://docs.vapi.ai/tools/custom-tools-troubleshooting), [server message](https://docs.vapi.ai/api-reference/webhooks/server-message), [ended reasons](https://docs.vapi.ai/calls/call-ended-reason), [pricing](https://vapi.ai/pricing))
- Web SDK: `vapi.start(assistant | assistantId, assistantOverrides)` accepts a full **inline (transient) assistant**. Public keys allow transient assistants by default.
- Inline function tool: `{type:"function", function:{name, description, parameters}, server:{url, timeoutSeconds}, messages, async:false}`. JSON Schema supports arrays of objects, `enum`, `required`.
- `endCallFunctionEnabled` is **removed**; add `{type:"endCall"}` as a tool. `silenceTimeoutSeconds` is not in the assistant schema; use `maxDurationSeconds` (plus the `customer.speech.timeout` hook if needed).
- `tool-calls`: `message.toolCallList[].{id, function:{name, arguments}}`. **`arguments` may be an object or a JSON string**, so parse both. Reply **HTTP 200** `{"results":[{"name":"save_foods","toolCallId":"…","result":"Saved 5 items"}]}`. `name` is required by the schema; the result must be a single-line string. Use `error` instead of `result` to report a failure. Any non-200 is ignored. Default timeout 20 s.
- `end-of-call-report`: `endedReason`, `artifact.transcript`, `artifact.messages`, `startedAt`, `endedAt`, `call.id`. **There is no duration field**, so duration = `endedAt − startedAt`.
- `metadata` exists **only on the assistant**, and the docs don't confirm where it is echoed. The Worker therefore correlates on `call.id` and treats metadata as a fallback.
- Server messages are **not retried by default**. `server.backoffPlan` turns retries on (used for the end-of-call-report).
- Recording is on by default → set `artifactPlan.recordingEnabled: false`.
- Free tier: **$5 credit**, $0.05/min Vapi fee plus pass-through STT/LLM/TTS (~$0.08–0.13/min, estimate). At ~3 min/call that's about **2–3 weeks of daily calls per user**. After that, each user needs a card on *their* Vapi account, and at $0 Vapi freezes the account. This is the one metered piece; it was already true of the old app.

---

## 4. Architecture

```
 ┌──────────── Android / iOS app (bare RN 0.83) ─────────────┐
 │ Notifee daily alarm ─► native ring UI ─► answer             │
 │        │                                     │              │
 │        │                       POST /calls/start ──────────┼──┐
 │        │                       ◄─ {publicKey, assistant}    │  │
 │        │                       vapi.start(assistant) ───────┼──┼──► Vapi (web call)
 │ Screens ◄── REST (Bearer APP_TOKEN, X-User-Id) ─────────────┼──┤        │
 └─────────────────────────────────────────────────────────────┘  │        │ tool-calls,
                                                                  ▼        │ end-of-call-report
                                      Cloudflare Worker (TypeScript) ◄─────┘ POST /vapi/webhook/:token
                                                │
                                         Cloudflare D1 (SQLite)
```

The Worker does two jobs: (a) the REST API for the app, which includes building the inline assistant for each call; (b) receiving Vapi's `tool-calls` and `end-of-call-report`.
- **Zero runtime dependencies.** A tiny hand-rolled router and validators; dev dependencies only.
- **No LLM calls** from the Worker. Nutrition comes only from the `foods` table.
- The Worker's public URL is taken from the incoming request's origin when it builds webhook URLs, so no `WORKER_URL` variable is needed.
- Logs record ids and statuses only, never keys, transcripts or payload bodies.

---

## 5. Repo layout

```
nutrition-tracker-zero/
  PLAN.md  README.md  .gitignore  .env.example        # .env.example documents every name, no values
  worker/
    wrangler.jsonc  package.json  tsconfig.json  vitest.config.ts  .dev.vars.example
    migrations/0001_init.sql
    src/  index.ts router.ts http.ts auth.ts
          domain/  normalize.ts units.ts nutrients.ts match.ts nutrition.ts suggest.ts resolve.ts
          vapi/    assistant.ts prompt.ts webhook.ts parse.ts
          routes/  profiles.ts settings.ts calls.ts days.ts items.ts foods.ts uncached.ts meta.ts
          db/      queries.ts
    test/  unit/  integration/  fixtures/vapi/*.json
    scripts/replay-vapi.mjs
  app/                       # bare RN 0.83.1, new applicationId so it installs beside the old app
    src/config/local.example.ts   # copied to git-ignored local.ts: API_BASE_URL, APP_TOKEN
  scripts/migrate-from-mongo/      # one-off, own package.json (mongodb driver), output git-ignored
```

The app's config goes in a git-ignored `src/config/local.ts` rather than `.env`. `react-native-dotenv` was installed in the old app but never wired up; a TS file has no Babel-cache surprises.

---

## 6. Data model (D1, migration `0001_init.sql`)

```sql
CREATE TABLE users (
  id             TEXT PRIMARY KEY,                    -- uuid
  name           TEXT NOT NULL COLLATE NOCASE UNIQUE, -- profile picker after reinstall
  timezone       TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  call_time      TEXT,                                -- 'HH:MM' local, NULL = not set
  call_enabled   INTEGER NOT NULL DEFAULT 1,
  vapi_public_key TEXT,                               -- never returned by settings endpoints
  webhook_token  TEXT NOT NULL UNIQUE,                -- 32 random bytes, base64url
  created_at     TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE calls (
  id            INTEGER PRIMARY KEY,                  -- exists before Vapi assigns an id
  vapi_call_id  TEXT UNIQUE,
  user_id       TEXT NOT NULL REFERENCES users(id),
  local_date    TEXT NOT NULL,                        -- 'YYYY-MM-DD' in the user's timezone
  kind          TEXT NOT NULL CHECK (kind IN ('scheduled','retry','test','manual','unknown')),
  status        TEXT NOT NULL CHECK (status IN ('queued','called','tool_saved','no_list','failed')),
  ended_reason  TEXT, transcript TEXT, duration_seconds REAL, error TEXT,
  processed_tool_call_ids TEXT NOT NULL DEFAULT '[]', -- JSON array, dedupe
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX calls_user_date ON calls(user_id, local_date);

CREATE TABLE foods (                                   -- SHARED cache, values entered by people only
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                           -- canonical normalized name
  display_name TEXT NOT NULL,
  base_unit TEXT NOT NULL,                             -- one of BASE_UNITS (§8)
  calories REAL NOT NULL,                              -- per ONE base serving
  protein_g REAL, carbs_g REAL, fat_g REAL, fiber_g REAL, sugar_g REAL, sodium_mg REAL,
  vitamin_a_mcg REAL, vitamin_c_mg REAL, vitamin_d_mcg REAL, vitamin_e_mg REAL, vitamin_k_mcg REAL,
  calcium_mg REAL, iron_mg REAL, potassium_mg REAL, magnesium_mg REAL, zinc_mg REAL,
  added_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE food_aliases (
  alias   TEXT PRIMARY KEY,                            -- normalized; one alias → one food
  food_id TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  added_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE food_units (                              -- 1 <unit> = servings × base serving
  food_id  TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
  unit     TEXT NOT NULL,
  servings REAL NOT NULL CHECK (servings > 0),
  added_by TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (food_id, unit)
);

CREATE TABLE log_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  local_date TEXT NOT NULL,
  meal TEXT CHECK (meal IN ('breakfast','lunch','snack','dinner')),
  raw_name TEXT NOT NULL, normalized_name TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0), unit TEXT NOT NULL,
  food_id TEXT REFERENCES foods(id),
  status TEXT NOT NULL CHECK (status IN ('resolved','pending_food','pending_unit')),
  call_id TEXT,                                        -- vapi_call_id, NULL for manual
  source TEXT NOT NULL CHECK (source IN ('call','manual','import')),
  created_at TEXT NOT NULL
);
CREATE INDEX log_items_user_date ON log_items(user_id, local_date);
CREATE INDEX log_items_pending   ON log_items(status, normalized_name) WHERE status <> 'resolved';
CREATE INDEX log_items_food      ON log_items(food_id);
CREATE INDEX log_items_call      ON log_items(call_id);

CREATE TABLE user_goals (                               -- ported from the old app (custom targets)
  user_id TEXT NOT NULL REFERENCES users(id), nutrient TEXT NOT NULL, target REAL NOT NULL,
  PRIMARY KEY (user_id, nutrient)
);
```

Differences from the spec's model, and why:
- Dropped `phone`, `vapi_api_key`, `vapi_phone_number_id` (in-app calls); added `vapi_public_key` and `call_enabled`.
- `calls` gets a surrogate `id`, because the row is recorded before Vapi returns a call id, plus a `kind` column.
- `log_items.source` adds `import` for migrated history.
- Nutrients are **all 17 columns the old app tracked**. Only calories is required; the other 16 are optional (collapsed "More nutrients" in the form). Totals report how many items were missing each nutrient, so a blank shows as "unknown", not 0.
- Nutrition is **never stored on log items**. It is computed at read time, so fixing a food corrects all past logs.
- The Uncached list is **derived** from pending `log_items`, not a separate table.

---

## 7. Core logic

**Normalize** (`domain/normalize.ts`). The same function is applied to food names, aliases and logged names, so it only has to be *consistent and idempotent*, not linguistically perfect:
1. NFKD + strip diacritics, lowercase, trim.
2. Punctuation → space; collapse whitespace.
3. Singularize the **last word** only:
   - small exception map first (cookies→cookie, brownies→brownie, smoothies→smoothie, …);
   - `ies`→`y` (len > 4);
   - `oes`→`o`;
   - `(ch|sh|x|ss|z)es`→strip `es`;
   - otherwise strip a trailing `s` unless the word ends in `ss`/`us`/`is` or is ≤ 3 chars.

   Examples: idlis→idli, chapatis→chapati, tomatoes→tomato, sandwiches→sandwich, berries→berry. Anything it gets wrong is fixed by adding an alias.

**Match** (in memory). One D1 batch loads `foods`, `food_aliases` and `food_units` (three SELECTs, one round trip) and builds a `Map<normalizedName, food>` from names and aliases. Then:
- **Exact match only** → link `food_id`.
- No exact match → `pending_food`. A fuzzy match is **never** auto-accepted.

**Unit status** — `factor(food, unit)`:
- `unit == food.base_unit` → 1.
- a `food_units` row → its `servings`.
- built-in metric rules only: `g`→`100 g` ×0.01, `kg`→`100 g` ×10, `ml`→`100 ml` ×0.01, `l`→`100 ml` ×10.
- otherwise → `pending_unit`.

**Nutrition at read time.** Per item: `food[n] × quantity × factor`. Day totals sum the resolved items; pending items contribute nothing and are flagged. The result is `{value, missingItems}` per nutrient.

**Resolution cascade (all users).** Saving a food, an alias or a conversion runs one D1 batch:
1. Read every `pending_food` item whose `normalized_name` now matches, plus every item linked to that food.
2. Compute each item's new status **in TypeScript** with the same `factor()` function, so there is one source of truth.
3. Apply it with a single `UPDATE … FROM json_each(?)` statement, whatever the item count.

Editing a food (e.g. changing its base unit) re-evaluates all its items the same way. Foods can be edited but not deleted in v1.

**Suggestions** (Uncached screen only):
- character-bigram Dice coefficient plus a token-set match against all names and aliases;
- top 3 with score ≥ 0.5, shown as "did you mean X?".

At realistic sizes (hundreds of foods, tens of pending names) this is well under 1 ms of CPU.

**Query budget.** Each handler is ≤ 6 D1 round trips, writes are batched, and multi-row inserts go through one `json_each(?)` statement, which avoids the 100-parameter limit.

---

## 8. Units and meals

One list in `worker/src/domain/units.ts`. It is served to the app by `GET /meta` and injected into the tool enum and the prompt, so the assistant, forms and foods table all use the same units.

- **Logged units (tool enum):** `piece, slice, katori, bowl, plate, cup, glass, tbsp, tsp, serving, g, kg, ml, l`
- **Base units for foods:** `piece, slice, katori, bowl, plate, cup, glass, tbsp, tsp, serving, 100 g, 100 ml`
- **Spoken-alias normalization** (from the old backend table, applied defensively to tool/manual input): grams/gm→g, katoris→katori, thali→plate, pieces/pcs→piece, tablespoon→tbsp, …. An unknown unit is stored raw as `pending_unit`, and the item's unit can be edited from Uncached.
- **Conversion UI:** "1 katori of rice = [1.5] × base (100 g)". For count bases it also offers a weight helper: "one piece weighs [40] g" → stores `g` = 1/40.
- **Meals:** `breakfast, lunch, snack, dinner` (optional on each item).

---

## 9. Vapi integration

### 9.1 Call lifecycle

1. **Ring.** The app arms a daily Notifee alarm at `call_time` in the user's timezone. This reuses the old app's scheduler, reconciliation and native ring code.
   - Unanswered after 60 s → missed notification (Log now / Snooze 10 min) **and** an automatic one-shot re-ring at +60 min, at most once (max 2 automatic rings/day).
   - Decline → no auto-retry.
2. **Start.** On answer (or Test call / Talk now), the app calls `POST /calls/start {kind}`.
   - The Worker inserts a `calls` row (`queued`, `local_date` in the user's timezone) **before** anything is sent to Vapi.
   - It returns `{callId, publicKey, assistant}`.
3. **Run.** The app calls `vapi.start(assistant)`.
   - On success: `POST /calls/:id/started {vapiCallId}` → `called`.
   - On SDK error (mic denied, credits exhausted, …): `POST /calls/:id/failed {reason}` → `failed`, shown as the last call result.
4. **During the call.** The assistant calls `save_foods` → Worker webhook → items saved → `tool_saved`.
5. **After the call.** `end-of-call-report` → transcript, ended reason, duration; `no_list` if no save arrived.
6. **Safety net.** On any read of a day or of calls:
   - `called` rows older than 2 h are closed as `no_list` with ended reason `no-end-of-call-report`;
   - `queued` rows older than 2 h become `failed`.

There is no cron.

A successful call earlier in the day does **not** cancel the evening ring. Instead, the prompt receives "already logged today" so the assistant only collects new items, and `save_foods` replaces only that call's items.

### 9.2 Inline assistant (built by `vapi/assistant.ts`)

```jsonc
{
  "name": "Daily food check-in",
  "firstMessage": "Good evening, Asha! Quick food check-in. Let's go meal by meal. What did you have for breakfast?", // Worker adapts it to the local time and what's already logged
  "firstMessageMode": "assistant-speaks-first",
  "model": {
    "provider": "<from old dashboard>", "model": "<from old dashboard>", "temperature": 0.3,
    "messages": [{ "role": "system", "content": "<prompt, §9.3>" }],
    "tools": [
      { "type": "function", "async": false,
        "function": { "name": "save_foods",
          "description": "Save the complete, user-confirmed list of everything eaten today. Call only after the user confirms the read-back.",
          "parameters": { "type": "object", "required": ["items"], "properties": { "items": {
            "type": "array", "items": { "type": "object", "required": ["name","quantity","unit"], "properties": {
              "name":     { "type": "string", "description": "Food as the user said it, singular" },
              "quantity": { "type": "number" },
              "unit":     { "type": "string", "enum": ["piece","slice","katori","bowl","plate","cup","glass","tbsp","tsp","serving","g","kg","ml","l"] },
              "meal":     { "type": "string", "enum": ["breakfast","lunch","snack","dinner"] } } } } } } },
        "server": { "url": "https://<worker>/vapi/webhook/<user webhook_token>", "timeoutSeconds": 20 },
        "messages": [{ "type": "request-start", "content": "Saving that now." }] },
      { "type": "endCall" }
    ]
  },
  "voice": "<from old dashboard>",
  "transcriber": "<from old dashboard; default deepgram nova-3, language multi or en-IN>",
  "server": { "url": "https://<worker>/vapi/webhook/<token>", "timeoutSeconds": 20,
              "backoffPlan": { "type": "exponential", "maxRetries": 3, "baseDelaySeconds": 2 } },
  "serverMessages": ["tool-calls", "end-of-call-report"],
  "maxDurationSeconds": 600,
  "artifactPlan": { "recordingEnabled": false },
  "analysisPlan": "<summary/success evaluation disabled to save the user's credits — exact shape verified in the Phase 3 spike>",
  "metadata": { "userId": "…", "localDate": "2026-10-04", "callRowId": 123 }
}
```

Item extraction happens **only** through this tool. `structuredDataPlan` is not used.

### 9.3 System prompt (draft; merged with the old dashboard prompt once we have it)

The call is **meal by meal and time-aware**. `/calls/start` reads the user's local clock (`localTimeIn(timezone)`), and `vapi/meals.ts` gives each meal a state:

| Meal | Not asked (`later`) | "Have you had it yet?" (`check`) | "What did you have?" (`ask`) |
|---|---|---|---|
| breakfast | — | before 10:00 | from 10:00 |
| lunch | before 12:00 | 12:00–14:30 | from 14:30 |
| snacks & drinks (one catch-all question) | before 10:30 | — | from 10:30 |
| dinner | before 18:30 | 18:30–22:00 | from 22:00 |

A main meal that already has items today is `logged` and skipped. Snacks are always asked once due, since another may have happened since. So at 10 am the call is only about breakfast and ends with "enjoy your lunch". At 8 pm it walks breakfast → lunch → snacks → "have you had dinner yet?". The first message opens on the first due meal with a time-of-day greeting, e.g. "Good afternoon, Asha! Quick food check-in. I already have your breakfast. Let's go meal by meal. Have you had lunch yet?".

> You are a friendly food-logging assistant on a short daily voice call with {{name}}. It is {{time}} on {{weekday}}, {{localDate}}, their local time.
> Already logged today (don't ask about these again): {{alreadyLogged | "nothing yet"}}.
> 1. Go meal by meal in this order, one meal per question, and finish each meal before moving on: {{due meals, each "ask what they had" or "first ask whether they've had it yet; if not, skip it"}}. Don't ask about: {{logged meals}} (already logged); {{later meals}} (still ahead today). If they bring one up anyway, record it.
> 2. Every item needs a quantity and a unit. If either is missing, ask ("How many idlis?", "How many katoris of rice?").
> 3. Use only these units: {{units}}. If they say something else, ask them to put it in one of these.
> 4. Record each food as they named it, in singular form ("idli", not "idlis"), with the meal they had it at. Never invent foods or amounts.
> 5. When they're done, read the whole list back with quantities and units, then ask "Is that right?" Apply corrections and read back what changed.
> 6. Only after they confirm, call save_foods once with the complete list. Then say a short goodbye and end the call. If they correct something after saving, call save_foods again with the full corrected list.
> 7. If they want to stop early, save whatever they've confirmed, say goodbye, and end the call.
> When you say goodbye, wish them a nice {{next meal still ahead}}.
> Never mention calories, macros, nutrition or health advice, even if asked. Say the app shows that. Keep every turn short.

### 9.4 Webhook `POST /vapi/webhook/:token`

- **Every message:**
  - token → user lookup (unknown → 401);
  - body cap 2 MB;
  - find the call by `message.call.id`, falling back to `metadata.callRowId` (must belong to the same user), and otherwise create a row (`kind 'unknown'`);
  - always answer 200 (except a bad token).
- **`tool-calls`**, for each `save_foods` entry in `toolCallList`:
  1. Parse `arguments` (object or JSON string) and validate:
     - 1–50 items;
     - name 1–80 chars;
     - quantity > 0 (numeric strings accepted);
     - unit normalized.
  2. If this `toolCallId` is already in `processed_tool_call_ids` → **redelivery**: change nothing and return the same `"Saved N items"`.
  3. Otherwise, one batch: `DELETE` this call's `source='call'` items; `INSERT` the new items via `json_each`; set `status='tool_saved'`; append the `toolCallId`. A second `save_foods` in the same call therefore **replaces** that call's items, and corrections never duplicate.
  4. Reply `{"results":[{"name":"save_foods","toolCallId":"<id>","result":"Saved N items"}]}`. On a validation error, send `error` with a one-line reason so the assistant can retry.
- **`end-of-call-report`:**
  - store `transcript` (truncated at 100 KB), `endedReason`, and `duration = endedAt − startedAt`;
  - `tool_saved` stays as it is;
  - start errors such as `call.start.error-*` or `customer-did-not-give-microphone-permission` → `failed`;
  - anything else without a save → **`no_list`**. The app shows "call ended without a food list", the transcript, and a manual add form.
  - Transcripts are never parsed by an LLM.
- **Other message types** → 200 `{}`.

---

## 10. Data migration (Phase 6)

`scripts/migrate-from-mongo/`: a Node script using the `mongodb` driver.
- `MONGODB_URI` comes from the environment and is never committed or printed.
- Output goes to a git-ignored `out/import.sql`, chunked under 100 KB per statement and without `BEGIN`/`COMMIT`.
- Applied with `wrangler d1 execute <db> --remote --file out/import.sql`.
- Deterministic ids (`mig_<ObjectId>`) + `INSERT OR IGNORE`, so re-runs are safe.
- `--dry-run` prints counts and a few sample rows.

| Old | New |
|---|---|
| `users` (name, timezone) + `meal_schedules` (hour:minute, enabled) | `users` with a fresh `webhook_token`. Email/password dropped. The Vapi public key is pasted fresh in Settings. |
| `food_logs` + `food_entries` | `log_items`, `source='import'`, `status='pending_food'`, unit normalized, meal kept. Duplicate `(userId, logDate)` logs are merged. Stored `LocalDate` BSON Dates are checked (UTC vs IST midnight) during the dry run. |
| `user_nutrient_preferences.customTarget` | `user_goals` |
| `nutrition_cache`, `nutrition_details` | **Not migrated.** All values come from Spoonacular/Groq/USDA, which the hard rule forbids. Imported history makes your real foods appear in Uncached, most-logged first; once someone enters values, all history resolves retroactively. |
| `voice_meal_sessions`, VoIP tables, habits | Not migrated (habits only if Phase 7 happens). |

---

## 11. Worker API

All routes need `Authorization: Bearer <APP_TOKEN>`, compared in constant time, except `/health` and the webhook. Routes marked † also need `X-User-Id`, which must be an existing user.

| Route | Purpose |
|---|---|
| `GET /health` | Liveness for smoke tests |
| `GET /meta` | Units, base units, meals, nutrient catalog (key, label, unit, default goal) |
| `GET /profiles` · `POST /profiles {name}` | List `{id,name}` / create (409 on duplicate name) |
| † `GET /me/settings` · `PUT /me/settings` | name, timezone, callTime, callEnabled, `vapi:{configured}`, lastCall. PUT accepts `vapiPublicKey`; **no response contains it** |
| † `GET /me/goals` · `PUT /me/goals` | Daily nutrient targets (defaults from the catalog) |
| † `POST /calls/start {kind}` | Records the call, returns `{callId, publicKey, assistant}` (the only response with the key) |
| † `POST /calls/:id/started {vapiCallId}` · `POST /calls/:id/failed {reason}` | Link the Vapi id / record a client-side failure |
| † `GET /calls/latest` | Last call result for Settings |
| † `GET /days/:date` | Items with per-item nutrients and status, totals `{value, missingItems}`, goals, pending count, the day's calls (no_list ones with transcript) |
| † `GET /days?from&to` | Per-day totals for the weekly report |
| † `POST /days/:date/items {items[], callId?}` | Manual add (`source='manual'`, optionally attached to a no_list call) |
| † `PATCH /items/:id` · `DELETE /items/:id` | Edit (re-matched) / delete |
| `GET /uncached` | `unknownFoods[]` (normalized name, raw examples, units seen, item/user counts, suggestions) + `missingUnits[]` (food, unit, count) |
| `GET /foods` · `POST /foods` · `PUT /foods/:id` | Browse / create / edit the shared cache; create and edit run the cascade and return `resolvedCount` |
| `POST /foods/:id/aliases {alias}` | "Same as existing food" + cascade (409 if the alias is taken) |
| `PUT /foods/:id/units/:unit {servings}` | Unit conversion + cascade |
| `POST /vapi/webhook/:token` | Vapi server messages (§9.4) |

---

## 12. App screens

Ported from the old app where it helps: theme tokens, Gluestack/NativeWind setup, `VoiceSessionScreen`, the food-log components, and the notification/ring machinery.

- **Profile picker / onboarding:** pick an existing profile or create one by name; then call time (default 20:00), timezone (default Asia/Kolkata), and the notification / exact-alarm / full-screen permissions.
- **Settings:** Vapi public key (masked field, shows "configured ✓"), call time, enable switch, timezone, **Send test call now**, last call result, reminder health (ported diagnostics: notifications, exact alarms, full-screen intent, battery optimization).
- **Today:**
  - date navigation;
  - calorie ring and macros card against the user's goals;
  - items grouped by meal, each with its nutrients;
  - pending items flagged with a link to Uncached;
  - no_list calls with the transcript and a manual add form;
  - Talk-now mic button; add / edit / delete items.
- **Uncached Foods:**
  - unknown foods with "did you mean X?" (→ alias), "same as existing food" picker, or "enter values" (base unit + nutrients);
  - missing unit conversions.
- **Foods:** browse, search and edit the shared cache, including aliases and conversions.
- **Weekly report (simplified):** totals and averages vs goals over the week, computed from D1. No AI insights or AI goals. Last item of Phase 4, can slip.

### Old features: keep / defer / skip

| Feature | Decision |
|---|---|
| In-app ring, missed-call Log now/Snooze, reminder health, Talk-now | **Keep** |
| Manual add/edit/delete, meal grouping, date navigation, goals, macros card | **Keep** (goals per user instead of hard-coded) |
| Weekly nutrition summary | **Keep, simplified** (no LLM) |
| Habits (list, create, toggle, push-type local reminders) | **Defer** to optional Phase 7. Free, but not in the spec's screens. |
| "Call me back in N minutes" said during a call | **Built**: shared `schedule_callback` tool for Deepgram/Vapi, local `call-later` one-shot, Today cancellation and native recovery. See `docs/REMINDER_DELIVERY.md`; device release checks remain listed in `REMAINING_WORK_2026-10-17.md`. |
| Email/password accounts + JWT | **Skip** (replaced by profiles, per spec) |
| Spoonacular / Groq / USDA nutrition, LLM transcript parsing and interpretation, AI RDI goals, AI insights | **Skip** (hard rules / out of scope) |
| Habit voice check-ins | **Skip** (needed Groq to interpret) |
| iOS PushKit VoIP pushes + APNs dispatcher | **Skip** (needs the paid Apple Developer Program) |
| Pinned nutrients / avoided foods | **Skip** (already dead code) |

**iOS caveat:** with a free Apple ID an app expires after 7 days, and installing on friends' iPhones (TestFlight / Ad Hoc) needs the paid Apple program. So: **Android-first**, with friends sideloading an APK signed by a *new* keystore kept outside git. iOS builds work for your own phone from Xcode.

---

## 13. Phases (commit after each; app stays runnable)

**2026-10-17 follow-up:** the previously deferred callback is implemented. The voice model supplies a delay or local clock time;
the phone validates it and arms the native one-shot before acknowledging success. No server scheduler, new paid service or D1
migration is needed. Rebuild both native apps and deploy the Worker to deliver the full change. The current release-validation
status is tracked in `REMAINING_WORK_2026-10-17.md`, separately from the original phases below.

**Inputs I'll need, none blocking Phase 1–2:**
1. Before Phase 3, the old assistant's prompt / first message / voice / model / transcriber from the Vapi dashboard. Either paste them, or OK me fetching them read-only with `GET https://api.vapi.ai/assistant/{id}` using the key in the old `backend/.env` (never printed). Otherwise the §9.3 draft and sensible defaults are used.
2. Before the Phase 3 spike, a Vapi public key for one real test call (a few cents of credit).
3. Before Phase 5, the Cloudflare browser steps (§14).
4. Before Phase 6, your OK to read `MONGODB_URI` from the old `backend/.env` (read-only connection), or export it yourself.

**Phase 1 — Scaffold**
- `git init`, `.gitignore` (`.dev.vars`, `local.ts`, `out/`, keystores), `.env.example`, README skeleton, this PLAN.md.
- Worker: `wrangler.jsonc` (D1 binding with placeholder id, `observability`, `secrets.required: ["APP_TOKEN"]`), router, auth, `/health`, stubs, `0001_init.sql`, Vitest plugin.
- Tests prove that D1 supports `ON CONFLICT` / `RETURNING` / `json_each` updates, and Intl with Asia/Kolkata.
- App: a fresh RN 0.83.1 project with the old app's build config (NativeWind, Gluestack, navigation, patches that still apply) and a new applicationId. A placeholder screen shows `/health` from `wrangler dev`.
- **Done when:** worker tests pass; `wrangler d1 migrations apply --local` works; curl `/health` works; the Android debug build shows "API ok" on the emulator.

**Phase 2 — Foods cache, matching, Uncached**
- Domain modules + **unit tests** for normalization, matching, unit conversion, nutrition totals, suggestions.
- Routes: profiles, meta, foods/aliases/units, days, items, uncached; resolution cascade.
- **Integration test:** an item pending for users A and B resolves for both when C enters the food, and changing a base unit re-pends unconvertible items.

**Phase 3 — Vapi**
- **Spike first:** one real web call with a transient assistant and the tool pointed at the Worker (through a `cloudflared` quick tunnel or an early workers.dev deploy). It confirms that webhooks fire for web calls, the `arguments` type, where metadata appears, and the `analysisPlan` shape. The real payloads become redacted fixtures.
- Then: settings, `calls/start` + assistant builder (prompt, units enum, already-logged context), started/failed, webhook (tool-calls with dedupe/replace, end-of-call-report with `no_list`), lazy stale sweep.
- `scripts/replay-vapi.mjs --base <url> --scenario save|duplicate|correction|no-list` replays sample `tool-calls` and `end-of-call-report` payloads against local or deployed URLs. The webhook token is read via `wrangler d1 execute … --json`, so no API exposes it.
- **Tests:**
  - a replay produces the correct items;
  - a duplicate delivery adds nothing;
  - a correction replaces the call's items;
  - an end-of-call-report without a save gives `no_list` with the transcript;
  - no response body ever contains a stored key (a test sets a key and scans every endpoint's JSON).

**Phase 4 — App screens**
- Port the ring/alarm/reconciliation code, trimmed to one daily call with the +60 min auto-retry.
- Wire the Vapi session to `POST /calls/start`.
- Build the screens in §12 against the API, with Jest tests for the API client and key hooks.

**Phase 5 — Deploy** (§14). Then smoke-test the live URL:
- health and 401s;
- two test profiles → pending → resolved for both;
- replay scenarios against the live webhook;
- no key leak;
- Workers Logs show webhook CPU time ≪ 10 ms.
- Clean up the test data, build the APK, and you run the test call on your phone with your key.

**Phase 6 — Migration + final README**
- Dry run, then import (§10).
- README: setup, local dev (`wrangler dev` + `adb reverse tcp:8787 tcp:8787`), deploy, pointing the app at the Worker URL, building/sideloading the APK.
- **Onboarding a friend:**
  1. Create a free Vapi account.
  2. Dashboard → API Keys → copy the **public** key.
  3. Install the APK, create a profile, paste the key, set the call time, tap Test call.

**Phase 7 (optional)** — Habits without voice.

---

## 14. Setup split and deploy runbook

**You, in a browser (I'll stop and tell you exactly when):**
1. Sign up at `dash.cloudflare.com/sign-up` (email + password, verify the email). No card.
2. Workers & Pages → set your **workers.dev subdomain** (required before the first non-interactive deploy).
3. When I run `npx wrangler login`, a browser tab opens → click **Allow**.
   - Alternative: My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template **+ Account › D1 › Edit**. Then export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the shell (never in git).

**Me, from the CLI:**
1. `npx wrangler whoami`
2. `npx wrangler d1 create nutrition-zero --binding DB --update-config` (the database id is not a secret, so it's committed)
3. `npx wrangler d1 migrations apply nutrition-zero --remote`
4. Generate `APP_TOKEN` (`openssl rand`) and pipe it straight into `npx wrangler secret put APP_TOKEN`. Never echoed into logs or files. **Printed once** for your git-ignored `app/src/config/local.ts`.
5. `npx wrangler deploy` → note the URL. Then the smoke tests in Phase 5.

**Never:** upgrade a plan, enter payment details, or commit secrets. If anything asks for payment, I stop and tell you.

---

## 15. Definition of done → how it's checked

| Criterion | Check |
|---|---|
| Free tiers only | Workers Free + D1 Free, no card. Vapi minutes run on each user's own $5 credit (the only metered piece, see §3). |
| Pending food resolves for every user once values are entered | Phase 2 integration test + Phase 5 live smoke with two profiles |
| Replayed tool-calls → correct items; duplicate → no duplicates; call without save_foods → `no_list` with transcript | Phase 3 tests + `replay-vapi.mjs` against the live URL |
| In-app ring at call time and test call work end to end | Phase 5 on your phone (replaces the cron criterion) |
| No secret committed; no response leaks a Vapi key | `.gitignore` + a secret-pattern scan before each commit + the Phase 3 leak test |

---

## 16. Risks and notes

- **Device alarms are the weak point** (Doze, OEM battery killers). The old repo's own runbook says its reliability checklist was never run on a device. The ported reminder-health screen and the missed-call fallback mitigate this, and Phase 5 includes a real-device check.
- **Webhooks for web calls are unverified in the docs.** The Phase 3 spike settles it before anything is built on it. Fallback if it fails: the app posts the SDK's `tool-calls` / `call-end` events to the Worker itself.
- **Vapi credits run out** after ~2–3 weeks of daily calls per user. The start failure shows up as the last call result.
- **Shared app token in the APK:** accepted for friends-only, non-sensitive data. Anyone holding it could act as any profile. *(Superseded 2026-10-12 for health data: body measurements, targets and the weekly report are stored behind a per-profile secret and are not "non-sensitive". The food log and transcripts are still reachable with the shared token unless the deployment sets `REQUIRE_SECRET`; see the README and WEEKLY_BREAKDOWN_PLAN.md 8.3.)*
- **Old repo security (no action taken; FYI):**
  - `backend/.env` and `application-local.properties` hold live keys (Groq, Gemini, Spoonacular, USDA, Vapi, Mongo URI, JWT secret);
  - `application.properties` was committed in past history;
  - the Android release keystore and its passwords are committed.
  - Rotate what matters, especially if the repo was ever pushed. None of this is copied into the new repo.
