# Voice providers

Deepgram is the default voice provider. The active call screen uses `useVoiceCall` and a registered adapter. Vapi remains available through the same interface. Its original hook, SDK dependency, audio helpers, assistant builder, webhook routes, embedded bridge, replay fixtures and tests are unchanged. Existing Vapi public-key controls and settings remain available.

## Architecture and files

| Layer | Files | Responsibility |
| --- | --- | --- |
| Shared contract | `shared/voice.ts` | Session configuration, transcript lines, function calls and end reasons |
| Application lifecycle | `app/src/hooks/useVoiceCall.ts` | Microphone permission, start cancellation, status, transcripts, ordered meal saves, native hang-up, retry cancellation and outcome reports |
| Frontend adapters | `app/src/services/voice/{types,registry,api}.ts`, `providers/{deepgram,vapi}.ts` | Common `VoiceProvider`/`VoiceSession` interface; lazy SDK initialization; provider selection from the backend response |
| Native PCM audio | `app/src/services/voice/pcm.ts`, Android `voicepcm/`, iOS `VoicePcmModule.swift` and `VoicePcmBridge.m` | Full-duplex microphone and playback, echo processing, mute, interrupted-speech flushing and playback drain |
| Backend adapters | `worker/src/voice/{provider,registry,conversation}.ts`, `providers/{deepgram,vapi}.ts` | Provider configuration, transient credentials and the existing time-aware meal conversation rules |
| Backend lifecycle | `worker/src/voice/{routes,save,proxy}.ts` | Authenticated voice API, validated and atomic meal saves, concurrent redelivery protection, transcript/duration reports and secure audio relay |
| Persistence | `worker/migrations/0006_voice_providers.sql`, `worker/src/db/queries.ts`, `worker/src/routes/days.ts`, generated embedded migrations | Additive provider/ID fields; existing Vapi IDs and food records stay intact; manual additions can reference either provider |
| Screens | `VoiceCallScreen.tsx`, `VoiceSessionScreen.tsx`, `SettingsScreen.tsx`, `i18n/strings.ts` | Shared hook, provider-neutral outcome lookup, active-provider status and retained Vapi key controls |
| Configuration | `.env.example`, `worker/wrangler.jsonc`, `app/src/config/voice.ts`, `local.example.ts`, `worker/src/voice/env.d.ts`, generated `worker/worker-configuration.d.ts` | Server configuration and embedded provider selection; no Deepgram secret in the app |
| Verification | `worker/test/integration/voice.test.ts`, `app/__tests__/voice/`, `worker/scripts/check-deepgram.mjs` | Persistence, security, provider switching, streaming events, interruptions and cancellation; optional live dry run |

The new `/voice/*` endpoints coexist with all original `/calls/*` and `/vapi/webhook/*` endpoints. `vapiCallId` remains in API responses for older clients; new clients use `providerCallId` with that legacy fallback. No existing rows are converted or deleted.

## Backend configuration

Set these on the hosted Cloudflare Worker; `.dev.vars` is for local development and is git-ignored.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VOICE_PROVIDER` | `deepgram` | Registered active provider; `vapi` selects the preserved alternative |
| `DEEPGRAM_API_KEY` | secret, required for Deepgram | Stored in Worker secrets, never an app setting, bundle or API response |
| `DEEPGRAM_AUTH_MODE` | `auto` | `auto` requests a 30-second JWT; inference-only keys that cannot mint JWTs use the backend WebSocket proxy. `proxy` forces the proxy |
| `DEEPGRAM_STT_MODEL` | `nova-3` | Deepgram transcription model |
| `DEEPGRAM_STT_LANGUAGE` | `multi` | Multilingual/code-switching transcription |
| `DEEPGRAM_TTS_MODEL` | `aura-2-thalia-en` | Spoken voice; this default speaks English |
| `DEEPGRAM_LLM_MODEL` | `gpt-4o-mini` | Deepgram-managed conversation model |

Keep the existing `APP_TOKEN`, profile-secret policy and `API_BASE_URL`. Deepgram-managed STT, LLM and TTS use the Deepgram account's allowance/billing. A separate OpenAI key is not required for this configuration. No automatic provider fallback occurs: changing providers is explicit configuration.

From `worker/`, configure the backend and apply the additive migration before deploying:

```sh
npx wrangler secret put DEEPGRAM_API_KEY
npm run db:migrate:remote
npm run deploy
```

For local development, put the key in `worker/.dev.vars`, run `npm run db:migrate:local` and `npm run dev`. Rebuild Android or iOS after pulling these changes because PCM capture/playback introduces native modules. A JavaScript-only refresh cannot register those modules.

In on-device mode, meals, nutrition and transcripts still use the embedded SQLite backend. Set `API_BASE_URL` to a hosted voice backend with the same `APP_TOKEN`; only authorization and, when needed, streamed audio go through that backend. The embedded backend never stores a Deepgram key. `ON_DEVICE_VOICE_PROVIDER` in `app/src/config/voice.ts` selects the embedded provider; rebuild after changing it. The hosted broker must have the corresponding provider configuration.

## Switching to Vapi and back

For a hosted app, set `VOICE_PROVIDER` to `vapi` in Worker configuration and deploy. Retain or enter the profile's existing Vapi **public** key in Settings. No screen, conversation or nutrition code needs to change. Switch the same variable back to `deepgram` and deploy to restore Deepgram.

For an embedded app, change the centralized `ON_DEVICE_VOICE_PROVIDER` to `vapi` or `deepgram` and rebuild. Vapi keeps its original client-side tool bridge in embedded mode and original webhook flow in hosted mode.

## Conversation and transport differences

- Vapi uses Daily WebRTC and its original voice selection. Deepgram uses binary PCM over a WebSocket with native voice processing. Android reuses the existing routing/proximity module; iOS uses AVAudioSession routes and proximity monitoring. Real phone, wired-headset and Bluetooth checks remain necessary after installation.
- Deepgram's `save_foods` call waits for a `FunctionCallResponse`. The adapter returns success only after the validated meal write, and returns retry feedback on failure. The original on-device Vapi asynchronous tool behavior remains intact.
- Deepgram has no Vapi end-of-call webhook or built-in `endCall` tool. The app supplies `end_call(message)`, speaks the final goodbye via `InjectAgentMessage`, drains queued playback, closes the socket and posts the transcript, duration and end reason. Asking the model to speak a separate goodbye and then invoke a tool did not reliably end a live conversation; the explicit goodbye tool was verified instead.
- Deepgram's deprecated `agent.language` conflicts with multilingual transcription. The adapter configures language on `agent.listen.provider` only. The default output voice is English; multilingual input does not imply multilingual speech output or preserve Vapi's Indian voice/accent.
- Meal read-back, confirmation, quantities, units, meal labels, already-logged meals, unusually-large-amount checks, correction replacement and the existing food/nutrition matching pipeline are retained. Neither provider is asked to invent nutrient values or expose health-profile information.
- A dropped connection ends the session and preserves saved meals. There is no automatic reconnection that could replay confirmed saves into a new session. Failed final reports are surfaced; the existing stale-call cleanup remains a last resort.

## Call-back requests

Both providers offer `schedule_callback` from `worker/src/domain/callback.ts`. Give exactly one argument:
`{"minutes":20}` for a delay of 1–720 whole minutes, or `{"time":"21:00"}` for a clock time in the profile's IANA time zone.
The shared resolver handles daylight-saving transitions and rejects invalid or out-of-window requests. The phone validates the
arguments and arms the native `call-later` one-shot before confirming success to the voice model. A failed permission check,
disabled notifications or failed native scheduling returns failure feedback rather than promising a call.

Deepgram routes the function through the common app hook and returns its result using `FunctionCallResponse`. Vapi observes the
SDK's tool messages; server-side webhook handling alone cannot arm a phone and must not promise delivery. Successful feedback
asks the model to confirm the time, say goodbye and end the current call. Meal saving remains a separate confirmed operation.

The callback is held locally in AsyncStorage and native scheduling, not in D1. Another request replaces it. Today shows its time
and a Cancel action; Reminder health lists it separately. App relaunch/resume restores a future callback if needed, and callbacks
for another profile are removed. Turning daily calls from on to off or signing out cancels it; a callback explicitly requested
while daily calls were already off remains scheduled. If native cancellation fails, the card stays visible and the app explains
the failure so cancellation can be retried.

Android rings through the exact-alarm/native service path; denied exact-alarm permission can delay delivery. iOS plays a local
sound notification, and tapping starts the call with kind `retry`. It cannot start a microphone call while terminated. Both
platforms require rebuilt native binaries. No migration or paid push service is required. See
[the callback device checklist](REMINDER_DELIVERY.md#requested-call-backs-call-later) for checks still requiring devices.

## Extending the registry

Implement the backend `VoiceProvider` contract (`id`, `configured`, `prepare`, optional `credentials` and `connect`), then register it in `worker/src/voice/registry.ts`. Implement the frontend `VoiceProvider.create`/`VoiceSession` contract (`start`, `stop`, `setMuted`, `setAudioRoute`, `dispose`) and register its lazy factory in `app/src/services/voice/registry.ts`. Translate provider events into `VoiceCallbacks`, including function results and call completion. Use `lifecycle: 'client'` for the shared persistence endpoints, or `'provider'` when an adapter owns the complete legacy lifecycle. Select its ID through configuration. The screens and nutrition business logic remain unchanged.

## Verification

Run `npm test`, `npm run typecheck` and app `npm run lint`; compile both native targets. The added tests cover provider selection, legacy Vapi availability, authentication, secret non-disclosure, duplicate and concurrent tool deliveries, corrections, cross-profile rejection, failure outcomes, PCM byte fidelity, microphone permissions, streamed events, interruptions, setup timeouts, rapid Start taps, stale callbacks and cancellation while requests are pending.

Verified on 2026-10-13: 876 app tests and 747 Worker tests passed; both TypeScript checks passed; app lint passed with only the two existing UI scaffold warnings; Android compiled and packaged; the iOS simulator build succeeded. A live test through the deployed Worker passed actual speech recognition, speech output, read-back confirmation, validated two-item tool arguments and spoken goodbye/hang-up. The live test used fictional meals and wrote no production food records. The additive migration and Worker secret are applied on the deployed backend. The supplied inference-only key uses the secure proxy path.

The signed ARM64 release APK is saved in Downloads as `NutritionTrackerZero-deepgram.apk`. It updated the connected emulator with the existing signing key, preserving app data, and the app launched without Android or React Native errors. The packaged APK was scanned and contains no Deepgram API key. Deployed Worker version: `3f583e99-0d89-4531-8c4f-31f189b92b58`.

From `worker/`, `node scripts/check-deepgram.mjs` runs an isolated live conversation with fictional meals and validates tool arguments without writing production records. `--audio /path/to/16k-mono-linear16.wav` also exercises actual speech recognition. `--backend http://localhost:8791` exercises the authenticated Worker proxy; provide `APP_TOKEN` for that backend. Credentials and transcripts are not printed by default.

Reference API contracts: [Voice Agent](https://developers.deepgram.com/reference/voice-agent/voice-agent), [temporary-token authentication](https://developers.deepgram.com/guides/fundamentals/token-based-authentication), [STT model/language settings](https://developers.deepgram.com/docs/voice-agent-stt-models).
