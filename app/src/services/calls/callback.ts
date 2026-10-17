/**
 * "Can you call me again in 20 minutes?" said during a call. The voice model turns the words into whole minutes and calls
 * `schedule_callback`; this arms a one-shot call for that moment through the same native path as the daily call (an exact alarm that
 * rings a full-screen call on Android, a sound notification on iOS), so it comes with the app closed, suspended or the phone restarted.
 * The one-shot is the operating system's; the record kept here (callbackStore) is how the app shows it, puts it back if the OS lost it,
 * and lets the person cancel it. There is one at a time: asking again replaces it.
 */
import { callbackClock, callbackDelayWords, callbackReply, resolveCallback } from '../../../../worker/src/domain/callback';
import { loadPendingCallback, savePendingCallback, type PendingCallback } from './callbackStore';
import { reminderLog } from './logger';
import { readNativeReminderDiagnostics } from './native';
import { canScheduleExact, readPermissionSnapshot } from './permissions';
import { DEFAULT_STALENESS_THRESHOLD_MS } from './staleness';
import { armRing, cancelRing, CALLBACK_TRIGGER_ID } from './triggers';

export { CALLBACK_TOOL } from '../../../../worker/src/domain/callback';
export type { PendingCallback } from './callbackStore';

/** What the iOS reminder says for a call back (Android shows its own ring screen, whose subtitle says the same). */
const NOTIFICATION = { title: 'Food check-in', body: 'Calling you back, as you asked. Tap to continue your food log.' };

export type ScheduleResult =
  | { ok: true; fireAt: number; minutes: number; /** What the voice model is told: the time to say back, and to say goodbye. */ reply: string }
  | { ok: false; /** What the voice model is told, in words it can pass on. */ error: string };

/**
 * Sets the reminder for what the model asked (`args` is the tool's arguments, an object or a JSON string). Nothing is armed for a bad
 * number, and nothing is promised the phone cannot do: with notifications off the call could not be seen or heard, so the model is told to
 * say so instead of "I'll call you back".
 */
export async function scheduleCallback(
  args: unknown,
  opts: { timeZone: string; profileId?: string; now?: number },
): Promise<ScheduleResult> {
  const now = opts.now ?? Date.now();
  const asked = resolveCallback(args, now, opts.timeZone);
  if ('error' in asked) return { ok: false, error: asked.error };
  let snapshot;
  try {
    snapshot = await readPermissionSnapshot();
  } catch (e) {
    reminderLog.warn('callback.permission_check_failed', String(e));
    return { ok: false, error: 'I could not check notification permissions on this phone. Tell them the call back was not set and to try again. The regular daily call is unchanged.' };
  }
  if (snapshot && !snapshot.notificationsAuthorized) {
    reminderLog.warn('callback.notifications_off', 'A call back was asked for with notifications off');
    return { ok: false, error: 'Notifications are turned off for this app, so I cannot call back. Tell them to turn notifications on in Settings, and say you will leave the regular daily call as it is.' };
  }
  // A delay rings that long from now; a time of day rings at the start of that minute, which resolveCallback worked out in the person's zone.
  const fireAt = asked.at;
  try {
    await armRing({
      id: CALLBACK_TRIGGER_ID,
      callKind: 'retry',
      fireAt,
      repeatDaily: false,
      exact: snapshot ? canScheduleExact(snapshot) : true,
      reason: 'callback',
      notification: NOTIFICATION,
    });
  } catch (e) {
    reminderLog.error('callback.arm_failed', String(e));
    return { ok: false, error: 'I could not set a reminder on this phone just now. Tell them you could not set it, and that the regular daily call is unchanged.' };
  }
  const record: PendingCallback = { fireAt, requestedAt: now, minutes: asked.minutes, ...(opts.profileId ? { profileId: opts.profileId } : {}) };
  // The operating system has it; a failure to remember it only costs the on-screen note and the way to cancel.
  await savePendingCallback(record).catch(e => reminderLog.warn('callback.save_failed', String(e)));
  reminderLog.info('callback.armed', 'Armed a call back', { fireAt, minutes: asked.minutes });
  return { ok: true, fireAt, minutes: asked.minutes, reply: callbackReply(asked.minutes, fireAt, opts.timeZone) };
}

/** Drops the call back: the alarm and the record. Safe when there is none. */
export async function cancelCallback(): Promise<void> {
  // Keep the record if native cancellation fails: otherwise the alarm still rings with no way to cancel it.
  await cancelRing(CALLBACK_TRIGGER_ID);
  await savePendingCallback(null);
}

/**
 * Keeps the OS in step with the record, on start-up, on resume and after a save (reconcile.ts). A call back that is still ahead is put
 * back if the OS no longer has it; one that is over is forgotten; one for another account, or after signing out, is dropped. Returns the
 * call back that is pending, or null.
 */
export async function syncCallback(opts: { signedIn: boolean; profileId?: string; now?: number }): Promise<PendingCallback | null> {
  const record = await loadPendingCallback();
  if (!record) return null;
  const now = opts.now ?? Date.now();
  if (!opts.signedIn || (record.profileId && opts.profileId && record.profileId !== opts.profileId)) {
    await cancelCallback();
    return null;
  }
  // A moment past its time it is being delivered; much later it was (or never will be): either way there is nothing to put back.
  if (record.fireAt <= now) {
    if (now - record.fireAt > DEFAULT_STALENESS_THRESHOLD_MS) await savePendingCallback(null).catch(() => {});
    return record.fireAt > now - DEFAULT_STALENESS_THRESHOLD_MS ? record : null;
  }
  try {
    // Android can say what it holds; iOS cannot, and re-asking is harmless (an unchanged request is kept as it is).
    const native = await readNativeReminderDiagnostics();
    const held = native?.schedules.some(s => s.id === CALLBACK_TRIGGER_ID && s.fireAt === record.fireAt);
    if (!held) {
      await armRing({ id: CALLBACK_TRIGGER_ID, callKind: 'retry', fireAt: record.fireAt, repeatDaily: false, exact: true, reason: 'callback', notification: NOTIFICATION });
      reminderLog.info('callback.restored', 'Put a call back in place again', { fireAt: record.fireAt });
    }
  } catch (e) {
    reminderLog.warn('callback.restore_failed', String(e));
  }
  return record;
}

/** The pending call back as the screens say it: "4:20 pm", and how long from now. Null once it is over. */
export function describeCallback(record: PendingCallback | null, timeZone: string, now = Date.now()): { clock: string; minutesLeft: number; inWords: string } | null {
  if (!record || record.fireAt <= now) return null;
  const minutesLeft = Math.max(1, Math.ceil((record.fireAt - now) / 60_000));
  return { clock: callbackClock(record.fireAt, timeZone), minutesLeft, inWords: callbackDelayWords(minutesLeft) };
}
