import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { Alert } from 'react-native';
import { errorMessage } from '@/api/client';
import { cancelCallback, describeCallback, type PendingCallback } from '@/services/calls/callback';
import { loadPendingCallback } from '@/services/calls/callbackStore';

/**
 * The call back the person asked for during a call, while it is still ahead: read when the screen is shown and kept fresh as the minutes
 * pass, so "In 18 minutes" counts down and the note goes away when the call comes. `cancel` takes it back.
 */
export function usePendingCallback(timeZone: string) {
  const [record, setRecord] = useState<PendingCallback | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    setRecord(await loadPendingCallback());
    setNow(Date.now());
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  // A minute is the grain the words have ("In 18 minutes"); the second tick after it is over is when it disappears.
  useEffect(() => {
    if (!record) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [record]);

  const cancel = useCallback(async () => {
    try {
      await cancelCallback();
      setRecord(null);
    } catch (e) {
      Alert.alert('Could not cancel call back', errorMessage(e));
    }
  }, []);

  return { callback: describeCallback(record, timeZone, now) ? record : null, described: describeCallback(record, timeZone, now), cancel, refresh };
}
