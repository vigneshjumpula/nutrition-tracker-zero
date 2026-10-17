# Daily reminder delivery

Reminder scheduling and delivery are local, with no additional service charges. The existing voice
providers are unchanged and are contacted only after the person answers.

## Root cause

The old path was a silent Notifee trigger → `DELIVERED` JS event → `presentIncomingCall`.
Android had to cold-start the React Native bundle inside a background delivery window before it
could start the ring service. In addition, repeating notification data kept the first day's
`intendedFireAt`, so the five-minute freshness check could suppress later days as stale until the
app reopened and replaced the trigger. On iOS, Notifee does not emit `DELIVERED` for background
trigger notifications; a local notification cannot run CallKit code in a terminated app.
Notifee's repeating iOS timestamp conversion also used the device calendar rather than an explicit
profile time zone, so repeat times could drift when the device and profile zones differed.

The connected Cloudflare account has the `nutrition-tracker-zero` Worker with the single cron
`17 3 * * *`. That scheduled handler purges old transcripts; it does not dispatch reminders.
No Cloudflare changes or new remote resources are needed for this fix.

## New delivery

**Android:** the native bridge saves `callTime`, IANA `timezone`, payload and next epoch in
SharedPreferences. An exact `setAlarmClock` one-shot targets `ScheduledCallReceiver`, which checks
the stored epoch (ignoring canceled/obsolete deliveries), stamps that occurrence on the payload,
arms the next day from wall-clock time, then starts the existing ring service. It neither loads
JS nor contacts the backend. Native receivers restore future alarms after reboot, app update,
clock/time-zone changes, and an exact-alarm permission grant. Disabled daily calls also cancel
native retry/snooze alarms. Without exact-alarm permission there is an inexact fallback, clearly
identified in Reminder health; it cannot guarantee punctual delivery.

**iOS:** per the requested free sound reminder/tap behavior, a native repeating
`UNCalendarNotificationTrigger` uses hour/minute/second **and the profile time zone**, without a
rolling queue or a background JS task. The notification plays the default sound. Its native
delegate is installed before React Native and persists an answer before signaling JS. The actual
notification delivery date identifies each occurrence; day one's epoch is never reused. Unchanged
daily requests are preserved on resume so a cold-launch tap cannot invalidate its own reminder.
This works on iOS 26+ and keeps compatibility with earlier supported versions.

AlarmKit was considered: its relative repeats follow the **device** time zone, while this app
allows a separately selected profile time zone. Calendar notifications preserve that existing
contract and implement the sound-notification behavior selected for this fix. Notification sound,
Focus, silent mode, and Scheduled Summary remain controlled by the person and iOS. A second-perfect
audible alarm under every device state is not guaranteed by this notification path.

## Install and configure

1. Rebuild/install the native Android and iOS binaries; a JS-only update is insufficient.
2. Open the updated app once while signed in. The saved schedule is migrated and armed natively.
3. Android: allow notifications and **Alarms & reminders**. Allow full-screen intents for the lock
   screen call UI. Check Reminder health for manufacturer battery/autostart restrictions.
4. iOS: allow notifications and sounds; select immediate delivery and allow the app through Focus
   if the reminder must be audible. Free personal signing expires after seven days; renew the
   installed app as needed. Local reminders require no push credentials or paid entitlement.
5. Use **Send test call now**, then background/swipe away the app before the five-second reminder.

Android **Force stop**, uninstalling, disabling notifications, a powered-off device, and some OEM
app-killing policies can prevent delivery. Force stop differs from swiping out of Recents; open the
app again to restore alarms after a force stop. No server scheduler can bypass these OS controls.

## Requested call backs (`call-later`)

`call-daily` is the repeating daily reminder, `call-test` is the five-second diagnostic, and `call-later` is the one-shot explicitly
requested during a voice call. `call-later` carries `callKind: retry` and `reason: callback`. Asking twice replaces the existing
one-shot without modifying the daily schedule. The app retains its profile, requested time and due time for the Today card and
reconciliation. Sign-out removes it; switching daily calls from on to off removes it as well. An explicit request made while
daily calls were already off remains valid. Cancellation failures keep the card and allow retry.

On Android the alarm and payload survive process death in SharedPreferences and are restored by native boot/update receivers.
On iOS the `native-call-later` notification uses an absolute UTC calendar date, a default sound and callback-specific text.
Reconciliation preserves an unchanged pending notification's revision so opening the app does not invalidate a subsequent tap.
The notification delegate passes an accepted tap to the durable incoming-call bootstrap before JavaScript starts.

Build the isolated `.remindertest` APKs using the commands below. Start each scenario from a clean test schedule (`scenario cancel`),
then run `later`, `later-habit`, `later-replace` and `later-cancel` in separate runs. The first three report `scheduledAt` about ten
seconds ahead; kill the process with `am kill` before that epoch, then verify the native service receives `call-later` once with
kind `retry`. `later-replace` must leave only the replacement alarm; `later-cancel` must leave none and never ring. The habit
scenario tests generic native payload forwarding; it does not add habit UI to this app. Also schedule a callback and reboot
before its due time, checking one delivery and no daily repeat. Never use the normal app's profile or preferences for these tests.

iOS device/simulator checklist after a signed Debug rebuild:

- Schedule a callback 60–90 seconds ahead, terminate the app, verify the sound notification, tap and confirm the `retry` call screen.
- Ask twice and verify only the replacement fires. Cancel on Today and verify no notification. Relaunch and verify the pending card.
- Reboot with a future callback; check the OS retains the pending notification. Disable daily calls, then separately sign out,
  and verify cancellation. Request one while daily calls were already off and verify it remains scheduled.
- On a physical phone check lock screen, Focus/silent-mode behavior and microphone/audio routing; simulator results do not cover them.

These are release checks, not claims of execution. See [the current remaining-work status](../REMAINING_WORK_2026-10-17.md).

## Verification

Verified during this change: all 892 app tests, TypeScript, ESLint, four native Android time/DST
unit tests, Android builds, and the full iOS simulator build passed. The isolated Android device
checks confirmed the process was absent before both test and daily deliveries. The native receiver
started a foreground ring service and persisted tomorrow's exact one-shot before ringing today.
Cold process startup took about 1.4–2.4 seconds after the requested epoch on this emulator: exact
alarm eligibility does not guarantee zero processing latency. Physical Android/iOS device checks
are still needed for manufacturer battery restrictions and notification sound settings.

App regression checks:

```sh
cd app
npm run typecheck
npm test -- --runInBand
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
```

Device checks below use an arm64 emulator (use `x86_64` for an x86 emulator). They use an isolated
package, never the normal install's profile data. They arm the actual
native scheduler without starting React Native or the voice provider:

```sh
cd app/android
./gradlew :app:assembleDebug :app:assembleDebugAndroidTest -PreminderTestApp -PreactNativeArchitectures=arm64-v8a
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell pm grant com.nutritiontrackerzero.remindertest android.permission.POST_NOTIFICATIONS
adb shell appops set com.nutritiontrackerzero.remindertest SCHEDULE_EXACT_ALARM allow
adb shell am instrument -w -e scenario test com.nutritiontrackerzero.remindertest.test/com.nutritiontrackerzero.incomingcall.ScheduledCallInstrumentation
adb shell am kill com.nutritiontrackerzero.remindertest
adb shell pidof com.nutritiontrackerzero.remindertest
```

The runner prints `scheduledAt` (about ten seconds ahead). Confirm the process is gone before that
epoch, then check `adb logcat -s NativeCallScheduler IncomingCallService` and the native ring screen.
Repeat with `-e scenario daily` to test the next minute. After delivery, inspect only the test
preferences and verify tomorrow is already armed with a new epoch:

```sh
adb shell run-as com.nutritiontrackerzero.remindertest cat shared_prefs/native_call_schedule_v1.xml
adb shell dumpsys alarm
adb uninstall com.nutritiontrackerzero.remindertest.test
adb uninstall com.nutritiontrackerzero.remindertest
```

Also check schedule edits, disabling/sign-out, reboot recovery, denied exact permission, locked
screen/Doze, and iOS notification taps from a cold launch on physical phones. Emulator/simulator
results do not establish reliability on every manufacturer's battery policy.

Sources: [Notifee background events](https://notifee.app/react-native/docs/events/),
[Android alarm scheduling](https://developer.android.com/develop/background-work/services/alarms),
[Android force-stop behavior](https://developer.android.com/about/versions/15/behavior-changes-all#stopped-state),
[Apple local notifications](https://developer.apple.com/documentation/usernotifications/scheduling-a-notification-locally-from-your-app),
[AlarmKit relative time zone](https://developer.apple.com/documentation/alarmkit/alarm/schedule-swift.enum/relative).

## Android follow-up: POCO / HyperOS

Android 1.0.1 adds a separate audible notification channel when the OS blocks the ringing foreground
service. The previous fallback used the silent service channel even though no service was playing
sound. The notification expires after 60 seconds and retains Answer/Decline actions. Native delivery
stages now persist across process death and can be shared from Reminder health, without meal data,
profile secrets or provider credentials. Exact-alarm eligibility is read from the same native
AlarmManager that arms the alarm. The test-call action refuses to claim an exact five-second delivery
when notifications or exact-alarm permission are denied. Schedule saves await native arming.

An unchanged daily schedule now preserves a pending occurrence at the current minute. Previously,
resume/save could advance that occurrence to tomorrow before the alarm receiver processed it.

For POCO / HyperOS, check app-specific Background autostart, Battery → No restrictions, notifications
and lock-screen/background pop-up permissions. The app cannot grant or reliably query HyperOS
Autostart itself; these settings need to be checked on the phone. Reminder health includes the
installed app/scheduler version, saved daily alarm and the most recent delivery event (which is not
hidden by a later schedule refresh). A USB-connected phone or shared delivery diagnostics are still
required to determine the actual cause of a particular POCO failure. An emulator is not HyperOS.

Validation: 897 app tests, TypeScript, ESLint, native Kotlin/unit checks and a signed release build.
On an isolated Android 16 emulator install, denying START_FOREGROUND reproduced the rejected-service
path after process death; it recorded `service_start_blocked` followed by `audible_fallback_posted`,
and the posted channel had a ringtone sound and vibration. The `race` instrumentation scenario
confirmed that a due daily occurrence is retained and delivered, with tomorrow subsequently armed.
The actual POCO X8 Pro Max has not been connected or verified yet.

Xiaomi references: [Background autostart](https://www.mi.com/global/support/faq/details/KA-497677/),
[battery restrictions](https://www.mi.com/ph/support/faq/details/KA-538010/),
[other app permissions](https://www.mi.com/global/support/faq/details/KA-497760/).
