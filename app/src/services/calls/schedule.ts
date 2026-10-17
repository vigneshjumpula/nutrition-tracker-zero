import type { Settings } from '@/api/types';
import { cancelCallback } from './callback';
import { reconcile } from './reconcile';
import { loadCachedSchedule, saveCachedSchedule } from './scheduleStore';

/**
 * Caches the server's call schedule for offline arming and re-arms the daily ring. Turning the daily call OFF also takes back a call
 * the person asked for during a call: "off" is their latest word. It is the change that does it, not the state, so a call back asked for
 * in a manual call while daily calls were already off is kept.
 */
export async function applySchedule(settings: Pick<Settings, 'callTime' | 'callEnabled' | 'timezone'>): Promise<void> {
  const before = await loadCachedSchedule();
  if (before?.callEnabled && !settings.callEnabled) await cancelCallback();
  await saveCachedSchedule({ callTime: settings.callTime, callEnabled: settings.callEnabled, timezone: settings.timezone });
  await reconcile('save', { signedIn: true });
}
