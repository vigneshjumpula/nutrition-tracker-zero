/**
 * What the person sees of a call back they asked for during a call: a card on Today while it is waiting (with a way to cancel it), and a
 * note on the call screen once the call is over.
 */
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

jest.mock('@react-navigation/native', () => {
  const React = require('react');
  const nav = { navigate: jest.fn(), goBack: jest.fn(), canGoBack: jest.fn(() => true), addListener: jest.fn(() => () => {}) };
  return {
    useNavigation: () => nav,
    useIsFocused: () => true,
    useRoute: jest.fn(() => ({ params: {} })),
    // the screen is on show when it mounts
    useFocusEffect: (effect: () => void) => React.useEffect(effect, [effect]),
    __nav: nav,
  };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@/hooks/useToday', () => ({ useToday: () => '2026-10-17', useProfileTimeZone: () => 'Asia/Kolkata' }));
jest.mock('@/hooks/useHealthCard', () => ({ useHealthCard: () => ({ visible: false, dismiss: jest.fn() }) }));
jest.mock('@/state/HealthContext', () => ({ useHealth: jest.fn() }));
jest.mock('@/state/MetaContext', () => ({ useMeta: jest.fn() }));
jest.mock('@/state/ProfileContext', () => ({ useProfile: () => ({ profile: { id: 'u1', name: 'Zoe' } }) }));
jest.mock('@/services/calls/schedule', () => ({ applySchedule: jest.fn(() => Promise.resolve()) }));
jest.mock('@/hooks/useVoiceCall', () => ({ useVoiceCall: jest.fn() }));
jest.mock('@/api/client', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  api: { getSettings: jest.fn(), getDay: jest.fn(), updateSettings: jest.fn(), deleteItem: jest.fn(), updateItem: jest.fn() },
}));

import { api } from '@/api/client';
import type { Day, Meta } from '@/api/types';
import { useVoiceCall } from '@/hooks/useVoiceCall';
import TodayScreen from '@/screens/TodayScreen';
import VoiceCallScreen from '@/screens/VoiceCallScreen';
import { savePendingCallback, loadPendingCallback } from '@/services/calls/callbackStore';
import { cancelNativeScheduledCall } from '@/services/calls/native';
import { useHealth } from '@/state/HealthContext';
import { useMeta } from '@/state/MetaContext';
import { ThemeProvider } from '@/theme';
import metaJson from './fixtures/meta.json';

const META = { units: [], meals: ['breakfast', 'lunch', 'snack', 'dinner'], baseUnits: [], ...(metaJson as object) } as unknown as Meta;
const rn = jest.requireMock('@react-navigation/native') as { __nav: Record<string, jest.Mock>; useRoute: jest.Mock };
const api_ = api as unknown as Record<string, jest.Mock>;

const textOf = (n: ReactTestInstance) => [n.props.children].flat(Infinity).filter(c => typeof c === 'string' || typeof c === 'number').join('');
const all = (tree: TestRenderer.ReactTestRenderer) => tree.root.findAll((n: ReactTestInstance) => (n.type as unknown) === 'Text').map(textOf).join('\n');
const byId = (tree: TestRenderer.ReactTestRenderer, id: string) => tree.root.findAll((n: ReactTestInstance) => n.props.testID === id);
const trees: TestRenderer.ReactTestRenderer[] = [];
async function render(ui: React.ReactElement) {
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(<ThemeProvider>{ui}</ThemeProvider>);
  });
  trees.push(tree);
  return tree;
}
afterEach(async () => {
  await act(async () => {
    for (const t of trees.splice(0)) t.unmount();
  });
});

const day = (): Day => ({ date: '2026-10-17', status: null, items: [], totals: {}, goals: { calories: 2000 }, customGoals: [], pendingCount: 0, calls: [] });

describe('Today: the call back that is waiting', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    jest.useRealTimers();
    (useMeta as jest.Mock).mockReturnValue(META);
    (useHealth as jest.Mock).mockReturnValue({ mode: 'personalised', numbersHidden: false, status: 'ready', refresh: jest.fn() });
    api_.getSettings.mockResolvedValue({ id: 'u1', name: 'Zoe', timezone: 'Asia/Kolkata', callTime: '20:00', callEnabled: true, vapi: { configured: false }, lastCall: null });
    api_.getDay.mockResolvedValue(day());
  });

  it('shows when it will ring and how long that is, above the daily call', async () => {
    const at = Date.now() + 20 * 60_000;
    await savePendingCallback({ fireAt: at, requestedAt: Date.now(), minutes: 20, profileId: 'u1' });
    const tree = await render(<TodayScreen />);
    const text = all(tree);
    expect(byId(tree, 'callback-card').length).toBeGreaterThan(0);
    expect(text).toMatch(/Call back at \d{1,2}:\d{2} (AM|PM)/);
    expect(text).toContain('In 20 minutes, as you asked.');
    expect(text.indexOf('Call back at')).toBeLessThan(text.indexOf('Daily check-in call'));
    // VoiceOver must be able to reach Cancel separately from the time announcement.
    const announcement = tree.root.findAll(n => n.props.accessible && n.props.accessibilityLabel?.startsWith('Call back at'))[0];
    expect(announcement).toBeDefined();
    expect(announcement.findAll(n => n.props.testID === 'callback-cancel')).toHaveLength(0);
  });

  it('is not there when no call back was asked for, or it is already over', async () => {
    expect(byId(await render(<TodayScreen />), 'callback-card')).toHaveLength(0);
    await savePendingCallback({ fireAt: Date.now() - 60_000, requestedAt: Date.now() - 20 * 60_000, minutes: 20 });
    expect(byId(await render(<TodayScreen />), 'callback-card')).toHaveLength(0);
  });

  it('takes the call back away when cancelled: the card goes and nothing is remembered', async () => {
    await savePendingCallback({ fireAt: Date.now() + 20 * 60_000, requestedAt: Date.now(), minutes: 20, profileId: 'u1' });
    const tree = await render(<TodayScreen />);
    const cancel = byId(tree, 'callback-cancel').find(n => typeof n.props.onPress === 'function')!;
    await act(async () => {
      await cancel.props.onPress();
    });
    expect(byId(tree, 'callback-card')).toHaveLength(0);
    expect(await loadPendingCallback()).toBeNull();
  });

  it('keeps the card and explains a failed cancellation, then allows another attempt', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const cancelNative = jest.spyOn(require('@/services/calls/native'), 'cancelNativeScheduledCall');
    cancelNative.mockRejectedValueOnce(new Error('Alarm bridge unavailable'));
    await savePendingCallback({ fireAt: Date.now() + 20 * 60_000, requestedAt: Date.now(), minutes: 20, profileId: 'u1' });
    const tree = await render(<TodayScreen />);
    const cancel = byId(tree, 'callback-cancel').find(n => typeof n.props.onPress === 'function')!;
    await act(async () => { await cancel.props.onPress(); });
    expect(alert).toHaveBeenCalledWith('Could not cancel call back', 'Alarm bridge unavailable');
    expect(byId(tree, 'callback-card').length).toBeGreaterThan(0);
    expect(await loadPendingCallback()).not.toBeNull();
    await act(async () => { await cancel.props.onPress(); });
    expect(byId(tree, 'callback-card')).toHaveLength(0);
    expect(cancelNativeScheduledCall).toHaveBeenCalled();
    cancelNative.mockRestore();
    alert.mockRestore();
  });

  it('tells the person, where they set the daily call, that a call back can be asked for during a call', async () => {
    const tree = await render(<TodayScreen />);
    const open = tree.root.findAll(
      (n: ReactTestInstance) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Daily check-in call.') && typeof n.props.onPress === 'function',
    )[0]!;
    await act(async () => {
      open.props.onPress();
    });
    expect(all(tree)).toContain('During a call you can say "call me again in 20 minutes".');
  });
});

describe('the call screen after a call back was set', () => {
  const state = (over: Record<string, unknown> = {}) => ({
    status: 'ended',
    error: null,
    transcript: [],
    isSpeaking: false,
    session: { callId: 7, localDate: '2026-10-17', providerCallId: 'deepgram:7', provider: 'deepgram' },
    audio: null,
    callback: null,
    setAudioRoute: jest.fn(),
    setMuted: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    ...over,
  });
  beforeEach(() => {
    jest.clearAllMocks();
    rn.useRoute.mockReturnValue({ params: { kind: 'scheduled', autoStart: false } });
    (useMeta as jest.Mock).mockReturnValue(META);
  });
  const callRow = (status: string) => ({ id: 7, providerCallId: 'deepgram:7', vapiCallId: null, localDate: '2026-10-17', kind: 'scheduled', status, endedReason: 'assistant-ended-call', durationSeconds: 20, error: null, createdAt: '', updatedAt: '' });

  it('says when the call will ring, and does not call a deferred meal a failure', async () => {
    (useVoiceCall as jest.Mock).mockReturnValue(state({ callback: { fireAt: Date.parse('2026-10-17T10:50:00Z') + 20 * 60_000, minutes: 20 } }));
    api_.getDay.mockResolvedValue({ ...day(), calls: [callRow('no_list')] });
    const tree = await render(<VoiceCallScreen />);
    const text = all(tree);
    expect(byId(tree, 'call-callback-note').length).toBeGreaterThan(0);
    expect(text).toContain("We'll call you again at 4:40 PM");
    expect(text).toContain('In 20 minutes. It comes even if the app is closed.');
    expect(text).not.toContain('No food list was saved');
  });

  it('shows the saved items as well when foods were logged before asking to be called back', async () => {
    (useVoiceCall as jest.Mock).mockReturnValue(state({ callback: { fireAt: Date.now() + 60 * 60_000, minutes: 60 } }));
    api_.getDay.mockResolvedValue({
      ...day(),
      calls: [callRow('tool_saved')],
      items: [{ id: 'i1', localDate: '2026-10-17', meal: 'lunch', rawName: 'dal', normalizedName: 'dal', quantity: 1, unit: 'katori', foodId: 'f', foodName: 'Dal', baseUnit: 'katori', status: 'resolved', source: 'call', callId: 'deepgram:7', createdAt: '', nutrients: { calories: 150 }, weight: null, amountCheck: null }],
    });
    const text = all(await render(<VoiceCallScreen />));
    expect(text).toContain("We'll call you again at");
    expect(text).toContain('In 1 hour.');
    expect(text).toContain('Saved 1 item');
  });

  it('keeps saying a call with no list and no call back was not saved, as it always did', async () => {
    (useVoiceCall as jest.Mock).mockReturnValue(state());
    api_.getDay.mockResolvedValue({ ...day(), calls: [callRow('no_list')] });
    const tree = await render(<VoiceCallScreen />);
    expect(all(tree)).toContain('No food list was saved');
    expect(byId(tree, 'call-callback-note')).toHaveLength(0);
  });
});
