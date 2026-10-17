/**
 * "Can you call me again in 20 minutes?" said during a call: the one-shot the phone arms, what is kept of it, how it is put back, taken back and
 * dropped. The native scheduler and the permissions are stood in for; what is checked is what the app asks of them and what it remembers.
 */
import notifee from '@notifee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { cancelCallback, describeCallback, scheduleCallback, syncCallback } from '@/services/calls/callback';
import { loadPendingCallback, savePendingCallback } from '@/services/calls/callbackStore';
import { cancelNativeScheduledCall, readNativeReminderDiagnostics, scheduleNativeCall } from '@/services/calls/native';
import { readRingPayload, nativePayloadJson } from '@/services/calls/payload';
import { reconcile } from '@/services/calls/reconcile';
import { applySchedule } from '@/services/calls/schedule';
import { loadCachedSchedule, saveCachedSchedule } from '@/services/calls/scheduleStore';

jest.mock('@/services/calls/native', () => ({
  scheduleNativeCall: jest.fn(async (options: { fireAt: number }) => options.fireAt),
  cancelNativeScheduledCall: jest.fn(async () => {}),
  drainRingResults: jest.fn(async () => []),
  readNativeReminderDiagnostics: jest.fn(async () => null),
}));

const n = notifee as jest.Mocked<typeof notifee>;
const schedule = scheduleNativeCall as jest.Mock;
const cancelNative = cancelNativeScheduledCall as jest.Mock;
const diagnostics = readNativeReminderDiagnostics as jest.Mock;
const originalOS = Platform.OS;

const NOW = Date.parse('2026-10-17T10:50:00Z'); // 4:20 pm in Asia/Kolkata
const ZONE = 'Asia/Kolkata';

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  n.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1, android: { alarm: 1 }, ios: {} } as any);
  diagnostics.mockResolvedValue(null);
});
afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS });
});

describe('scheduleCallback', () => {
  it('arms a one-shot call for that many minutes from now, through the native scheduler, and remembers it', async () => {
    const result = await scheduleCallback({ minutes: 20 }, { timeZone: ZONE, profileId: 'u1', now: NOW });
    expect(result).toEqual({
      ok: true,
      fireAt: NOW + 20 * 60_000,
      minutes: 20,
      reply: 'Done. I will call them again in 20 minutes, at 4:40 pm. Tell them that, then say goodbye and end the call.',
    });
    expect(schedule).toHaveBeenCalledTimes(1);
    const options = schedule.mock.calls[0][0];
    expect(options).toMatchObject({ id: 'call-later', fireAt: NOW + 20 * 60_000, repeatDaily: false });
    expect(options.callTime).toBeUndefined();
    expect(options.payload).toMatchObject({ callKind: 'retry', notificationId: 'call-later', intendedFireAt: NOW + 20 * 60_000, reason: 'callback' });
    expect(options.notification).toEqual({ title: 'Food check-in', body: 'Calling you back, as you asked. Tap to continue your food log.' });
    expect(await loadPendingCallback()).toEqual({ fireAt: NOW + 20 * 60_000, requestedAt: NOW, minutes: 20, profileId: 'u1' });
  });

  it.each([
    ['call me in 10 minutes', 10],
    ['remind me after 30 minutes', 30],
    ["I'll eat later, call me again in an hour", 60],
    ['in an hour and a half', 90],
    ['in two hours', 120],
  ])('sets the call back the model asked for when someone says "%s": %s minutes', async (_said, minutes) => {
    // the model turns the words into minutes; the arguments may arrive as an object, a JSON string, or with the number quoted
    for (const args of [{ minutes }, JSON.stringify({ minutes }), { minutes: String(minutes) }]) {
      schedule.mockClear();
      const result = await scheduleCallback(args, { timeZone: ZONE, now: NOW });
      expect(result).toMatchObject({ ok: true, minutes, fireAt: NOW + minutes * 60_000 });
      expect(schedule.mock.calls[0][0].fireAt).toBe(NOW + minutes * 60_000);
    }
  });

  it.each([[{ minutes: 0 }], [{ minutes: -5 }], [{ minutes: 721 }], [{ minutes: 'soon' }], [{}], [null]])('arms nothing and tells the model why for %j', async args => {
    const result = await scheduleCallback(args, { timeZone: ZONE, now: NOW });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error.length).toBeGreaterThan(20);
    expect(schedule).not.toHaveBeenCalled();
    expect(await loadPendingCallback()).toBeNull();
  });

  it('does not promise a call it could not see or hear: with notifications off it says so, and arms nothing', async () => {
    n.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0, android: { alarm: 1 }, ios: {} } as any);
    const result = await scheduleCallback({ minutes: 20 }, { timeZone: ZONE, now: NOW });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('Notifications are turned off') });
    expect(schedule).not.toHaveBeenCalled();
    expect(await loadPendingCallback()).toBeNull();
  });

  it('still arms with exact alarms denied (the OS may be late) and with notifications provisional', async () => {
    n.getNotificationSettings.mockResolvedValue({ authorizationStatus: 2, android: { alarm: 0 }, ios: {} } as any);
    expect((await scheduleCallback({ minutes: 5 }, { timeZone: ZONE, now: NOW })).ok).toBe(true);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it('does not promise a call when notification permissions cannot be checked', async () => {
    n.getNotificationSettings.mockRejectedValueOnce(new Error('Permission bridge unavailable'));
    const result = await scheduleCallback({ minutes: 20 }, { timeZone: ZONE, now: NOW });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('could not check notification permissions') });
    expect(schedule).not.toHaveBeenCalled();
    expect(await loadPendingCallback()).toBeNull();
  });

  it('reports a failure to arm without remembering a call that will not come', async () => {
    schedule.mockRejectedValueOnce(new Error('Could not schedule the food reminder'));
    const result = await scheduleCallback({ minutes: 20 }, { timeZone: ZONE, now: NOW });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('could not set a reminder') });
    expect(await loadPendingCallback()).toBeNull();
  });

  it('keeps one: asking again replaces the first', async () => {
    await scheduleCallback({ minutes: 20 }, { timeZone: ZONE, now: NOW });
    await scheduleCallback({ minutes: 45 }, { timeZone: ZONE, now: NOW + 60_000 });
    expect(schedule.mock.calls.map(c => [c[0].id, c[0].fireAt])).toEqual([['call-later', NOW + 20 * 60_000], ['call-later', NOW + 60_000 + 45 * 60_000]]);
    expect((await loadPendingCallback())!.minutes).toBe(45);
  });

  it('never touches the daily call', async () => {
    await scheduleCallback({ minutes: 20 }, { timeZone: ZONE, now: NOW });
    expect(schedule.mock.calls.every(c => c[0].id === 'call-later')).toBe(true);
    expect(cancelNative).not.toHaveBeenCalledWith('call-daily');
  });

  it('works the same on iOS: the same native call, with the words of the notification', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios' });
    const result = await scheduleCallback({ minutes: 15 }, { timeZone: ZONE, now: NOW });
    expect(result.ok).toBe(true);
    expect(schedule.mock.calls[0][0].notification.body).toContain('Tap to continue');
  });
});

describe('cancelCallback', () => {
  it('keeps the record and allows retry if the native alarm could not be cancelled', async () => {
    await scheduleCallback({ minutes: 20 }, { timeZone: ZONE, now: NOW });
    cancelNative.mockRejectedValueOnce(new Error('Native cancellation failed'));
    await expect(cancelCallback()).rejects.toThrow('Native cancellation failed');
    expect(await loadPendingCallback()).not.toBeNull();
    await cancelCallback();
    expect(await loadPendingCallback()).toBeNull();
  });

  it('takes back the alarm and the record, and is safe when there is none', async () => {
    await scheduleCallback({ minutes: 20 }, { timeZone: ZONE, now: NOW });
    await cancelCallback();
    expect(cancelNative).toHaveBeenCalledWith('call-later');
    expect(await loadPendingCallback()).toBeNull();
    await expect(cancelCallback()).resolves.toBeUndefined();
  });
});

describe('syncCallback: the OS and the record kept in step', () => {
  const record = { fireAt: NOW + 20 * 60_000, requestedAt: NOW, minutes: 20, profileId: 'u1' };

  it('has nothing to do when nothing was asked for', async () => {
    expect(await syncCallback({ signedIn: true, profileId: 'u1', now: NOW })).toBeNull();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('puts a call back that is still ahead in place again when the OS lost it (a force stop drops Android alarms)', async () => {
    await savePendingCallback(record);
    diagnostics.mockResolvedValue({ schedules: [] });
    expect(await syncCallback({ signedIn: true, profileId: 'u1', now: NOW + 5 * 60_000 })).toEqual(record);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0]).toMatchObject({ id: 'call-later', fireAt: record.fireAt, repeatDaily: false });
    expect(schedule.mock.calls[0][0].payload).toMatchObject({ reason: 'callback' });
  });

  it('leaves it alone when Android says it still holds that very alarm', async () => {
    await savePendingCallback(record);
    diagnostics.mockResolvedValue({ schedules: [{ id: 'call-later', fireAt: record.fireAt, repeatDaily: false }] });
    expect(await syncCallback({ signedIn: true, profileId: 'u1', now: NOW + 5 * 60_000 })).toEqual(record);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('asks iOS again every time, which it keeps unchanged (it cannot be asked what it holds)', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios' });
    await savePendingCallback(record);
    diagnostics.mockResolvedValue(null);
    await syncCallback({ signedIn: true, profileId: 'u1', now: NOW + 5 * 60_000 });
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule.mock.calls[0][0].fireAt).toBe(record.fireAt);
  });

  it('forgets a call back that is over, and does not put one back that is due this minute', async () => {
    await savePendingCallback(record);
    // due a minute ago: being delivered; kept, not re-armed (the time has passed)
    expect(await syncCallback({ signedIn: true, profileId: 'u1', now: record.fireAt + 60_000 })).toEqual(record);
    expect(schedule).not.toHaveBeenCalled();
    // long over: gone
    expect(await syncCallback({ signedIn: true, profileId: 'u1', now: record.fireAt + 30 * 60_000 })).toBeNull();
    expect(await loadPendingCallback()).toBeNull();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('drops it on sign-out, and for a different account', async () => {
    await savePendingCallback(record);
    expect(await syncCallback({ signedIn: true, profileId: 'someone-else', now: NOW })).toBeNull();
    expect(cancelNative).toHaveBeenCalledWith('call-later');
    expect(await loadPendingCallback()).toBeNull();
    await savePendingCallback(record);
    expect(await syncCallback({ signedIn: false, now: NOW })).toBeNull();
    expect(await loadPendingCallback()).toBeNull();
  });
});

describe('reconcile and the daily switch', () => {
  const record = { fireAt: NOW + 20 * 60_000, requestedAt: NOW, minutes: 20, profileId: 'u1' };

  it('retries cancellation when turning daily calls off failed the first time', async () => {
    await saveCachedSchedule({ callTime: '20:00', callEnabled: true, timezone: ZONE });
    await savePendingCallback(record);
    cancelNative.mockRejectedValueOnce(new Error('Native cancellation failed'));
    const settings = { callTime: '20:00', callEnabled: false, timezone: ZONE };
    await expect(applySchedule(settings)).rejects.toThrow('Native cancellation failed');
    expect((await loadCachedSchedule())?.callEnabled).toBe(true);
    expect(await loadPendingCallback()).toEqual(record);
    await applySchedule(settings);
    expect(await loadPendingCallback()).toBeNull();
    expect((await loadCachedSchedule())?.callEnabled).toBe(false);
  });

  it('is part of every start-up and resume pass, and the report says when it is due', async () => {
    await saveCachedSchedule({ callTime: '20:00', callEnabled: true, timezone: ZONE });
    await savePendingCallback(record);
    diagnostics.mockResolvedValue({ schedules: [{ id: 'call-later', fireAt: record.fireAt, repeatDaily: false }] });
    const report = await reconcile('resume', { signedIn: true, profileId: 'u1', now: NOW });
    expect(report.callbackAt).toBe(record.fireAt);
    expect(schedule.mock.calls.map(c => c[0].id)).toEqual(['call-daily']); // the daily alarm is armed as always; the call back is already held
  });

  it('survives the daily call being off: a call back asked for in a manual call stays', async () => {
    await saveCachedSchedule({ callTime: '20:00', callEnabled: false, timezone: ZONE });
    await savePendingCallback(record);
    diagnostics.mockResolvedValue({ schedules: [{ id: 'call-later', fireAt: record.fireAt, repeatDaily: false }] });
    expect((await reconcile('resume', { signedIn: true, profileId: 'u1', now: NOW })).callbackAt).toBe(record.fireAt);
    expect(await loadPendingCallback()).toEqual(record);
  });

  it('is dropped with the rest when the person signs out', async () => {
    await savePendingCallback(record);
    const report = await reconcile('signed-out', { signedIn: false, now: NOW });
    expect(report.callbackAt).toBeNull();
    expect(await loadPendingCallback()).toBeNull();
    expect(cancelNative).toHaveBeenCalledWith('call-later');
  });

  it('is taken back when the person turns the daily call off, but not when it was already off or stays on', async () => {
    await saveCachedSchedule({ callTime: '20:00', callEnabled: true, timezone: ZONE });
    await savePendingCallback(record);
    await applySchedule({ callTime: '20:00', callEnabled: true, timezone: ZONE });
    expect(await loadPendingCallback()).toEqual(record);
    await applySchedule({ callTime: '20:00', callEnabled: false, timezone: ZONE });
    expect(await loadPendingCallback()).toBeNull();
    // already off: a call back asked for in a manual call is the person's own, later word
    await savePendingCallback(record);
    await applySchedule({ callTime: '20:00', callEnabled: false, timezone: ZONE });
    expect(await loadPendingCallback()).toEqual(record);
  });
});

describe('how the screens say it', () => {
  it('words the time in the profile zone, and how long is left, down to a minute', () => {
    const record = { fireAt: NOW + 18 * 60_000, requestedAt: NOW, minutes: 18 };
    expect(describeCallback(record, ZONE, NOW)).toEqual({ clock: '4:38 pm', minutesLeft: 18, inWords: '18 minutes' });
    expect(describeCallback(record, ZONE, NOW + 17 * 60_000 + 30_000)).toEqual({ clock: '4:38 pm', minutesLeft: 1, inWords: '1 minute' });
    expect(describeCallback({ ...record, fireAt: NOW + 95 * 60_000 }, ZONE, NOW)).toMatchObject({ clock: '5:55 pm', inWords: '1 hour 35 minutes' });
  });

  it('says nothing once it is over, or when there is none', () => {
    expect(describeCallback(null, ZONE, NOW)).toBeNull();
    expect(describeCallback({ fireAt: NOW - 1, requestedAt: NOW - 600_000, minutes: 10 }, ZONE, NOW)).toBeNull();
  });
});

describe('the call that rings', () => {
  it('carries its reason through the native layer and says so on the ring screen', () => {
    const json = JSON.parse(nativePayloadJson({ callKind: 'retry', notificationId: 'call-later', intendedFireAt: NOW, reason: 'callback' }));
    expect(json).toMatchObject({ callKind: 'retry', reason: 'callback', subtitle: 'Calling back as you asked', type: 'meal', kind: 'meal-call' });
    expect(JSON.parse(nativePayloadJson({ callKind: 'scheduled' })).subtitle).toBe('Daily voice log');
    expect(readRingPayload(json)).toMatchObject({ callKind: 'retry', reason: 'callback' });
    expect(readRingPayload({ callKind: 'retry' })).not.toHaveProperty('reason');
  });
});
