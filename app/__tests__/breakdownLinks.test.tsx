/**
 * Where the breakdown opens from: a figure on Today (for the day shown, not always today), a row of the report's Nutrient intake card (for
 * the period shown), and a nutrient's own detail screen (for its week, or for the four weeks a vitamin is judged over).
 */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';

jest.mock('@react-navigation/native', () => {
  const nav = { navigate: jest.fn(), goBack: jest.fn(), canGoBack: jest.fn(() => true), addListener: jest.fn(() => () => {}) };
  return { useNavigation: () => nav, useIsFocused: () => true, useRoute: jest.fn(() => ({ params: {} })), useFocusEffect: jest.fn(), __nav: nav };
});
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@react-native-community/datetimepicker', () => 'DatePicker');
jest.mock('@/hooks/useToday', () => ({ useToday: () => '2026-10-17', useProfileTimeZone: () => 'Asia/Kolkata' }));
jest.mock('@/hooks/useHealthCard', () => ({ useHealthCard: () => ({ visible: false, dismiss: jest.fn() }) }));
jest.mock('@/hooks/useWeightPrompt', () => ({ useWeightPrompt: () => ({ visible: false, dismiss: jest.fn() }) }));
jest.mock('@/hooks/useRangeReport', () => ({ useRangeReport: jest.fn() }));
jest.mock('@/hooks/useWeeklyReport', () => ({ useWeeklyReport: jest.fn() }));
jest.mock('@/state/HealthContext', () => ({ useHealth: jest.fn() }));
jest.mock('@/state/MetaContext', () => ({ useMeta: jest.fn() }));
jest.mock('@/state/ProfileContext', () => ({ useProfile: () => ({ profile: { id: 'u', name: 'Zoe' } }) }));
jest.mock('@/services/calls/schedule', () => ({ applySchedule: jest.fn(() => Promise.resolve()) }));
jest.mock('@/api/client', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  api: { getSettings: jest.fn(), getDay: jest.fn(), updateSettings: jest.fn(), deleteItem: jest.fn(), updateItem: jest.fn() },
}));

import { api } from '@/api/client';
import type { Day, Meta, RangeReport, WeeklyReport } from '@/api/types';
import { NutrientDetail } from '@/components/report/NutrientDetail';
import NutrientScreen from '@/screens/NutrientScreen';
import ReportScreen from '@/screens/ReportScreen';
import TodayScreen from '@/screens/TodayScreen';
import { useRangeReport } from '@/hooks/useRangeReport';
import { useWeeklyReport } from '@/hooks/useWeeklyReport';
import { useHealth } from '@/state/HealthContext';
import { useMeta } from '@/state/MetaContext';
import { ThemeProvider } from '@/theme';
import metaJson from './fixtures/meta.json';
import reportsJson from './fixtures/reports.json';

const META = { units: [], meals: ['breakfast', 'lunch', 'snack', 'dinner'], baseUnits: [], ...(metaJson as object) } as unknown as Meta;
const rn = jest.requireMock('@react-navigation/native') as { __nav: Record<string, jest.Mock>; useRoute: jest.Mock };
const nav = rn.__nav;
const api_ = api as unknown as Record<string, jest.Mock>;
const R = reportsJson as unknown as Record<string, WeeklyReport>;

const byId = (tree: TestRenderer.ReactTestRenderer, id: string) => tree.root.findAll((n: ReactTestInstance) => n.props.testID === id);
const press = async (tree: TestRenderer.ReactTestRenderer, id: string) => {
  const node = tree.root.findAll((n: ReactTestInstance) => n.props.testID === id && typeof n.props.onPress === 'function')[0];
  if (!node) throw new Error(`nothing pressable with testID ${id}`);
  await act(async () => {
    await node.props.onPress();
  });
};
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

const day = (date: string): Day => ({
  date,
  status: null,
  items: [],
  totals: { protein: { value: 56, missingItems: 0 }, calories: { value: 1500, missingItems: 0 } },
  goals: { calories: 2000, protein: 50 },
  customGoals: [],
  pendingCount: 0,
  calls: [],
});

beforeEach(() => {
  jest.clearAllMocks();
  (useMeta as jest.Mock).mockReturnValue(META);
  (useHealth as jest.Mock).mockReturnValue({ mode: 'personalised', numbersHidden: false, status: 'ready', revision: 0, refresh: jest.fn() });
  api_.getSettings.mockResolvedValue({ id: 'u', name: 'Zoe', timezone: 'Asia/Kolkata', callTime: null, callEnabled: false, vapi: { configured: false }, lastCall: null });
});

describe('Today', () => {
  it('opens the breakdown of the day shown from a figure, and again for another day after stepping back', async () => {
    rn.useRoute.mockReturnValue({ params: {} });
    api_.getDay.mockImplementation((date: string) => Promise.resolve(day(date)));
    const tree = await render(<TodayScreen />);
    await press(tree, 'summary-metric-protein');
    expect(nav.navigate).toHaveBeenLastCalledWith('NutrientBreakdown', { nutrient: 'protein', from: '2026-10-17', to: '2026-10-17', origin: 'today' });
    await press(tree, 'summary-metric-calories');
    expect(nav.navigate).toHaveBeenLastCalledWith('NutrientBreakdown', { nutrient: 'calories', from: '2026-10-17', to: '2026-10-17', origin: 'today' });
    // the previous day: the breakdown follows the day on screen, not today
    const back = tree.root.findAll((n: ReactTestInstance) => n.props.accessibilityLabel === 'Previous day' && typeof n.props.onPress === 'function')[0]!;
    await act(async () => {
      back.props.onPress();
    });
    await press(tree, 'summary-metric-protein');
    expect(nav.navigate).toHaveBeenLastCalledWith('NutrientBreakdown', { nutrient: 'protein', from: '2026-10-16', to: '2026-10-16', origin: 'today' });
  });

  it('opens a vitamin or mineral from "All nutrients"', async () => {
    rn.useRoute.mockReturnValue({ params: {} });
    api_.getDay.mockResolvedValue(day('2026-10-17'));
    const tree = await render(<TodayScreen />);
    await press(tree, 'summary-all-nutrients');
    await press(tree, 'summary-metric-vitaminD');
    expect(nav.navigate).toHaveBeenLastCalledWith('NutrientBreakdown', { nutrient: 'vitaminD', from: '2026-10-17', to: '2026-10-17', origin: 'today' });
    await press(tree, 'summary-metric-zinc');
    expect(nav.navigate).toHaveBeenLastCalledWith('NutrientBreakdown', { nutrient: 'zinc', from: '2026-10-17', to: '2026-10-17', origin: 'today' });
  });
});

describe('the Report', () => {
  const range: RangeReport = {
    range: { from: '2026-10-12', to: '2026-10-18', through: '2026-10-17' },
    display: { numbersHidden: false },
    coverage: { calendarDays: 6, loggedDays: 3, skippedDays: 0, itemCount: 9, pendingItems: 0 },
    nutrients: META.nutrients.map(n => ({ nutrient: n.key, total: 10, meanPerLoggedDay: 3, knownItems: 9, missingItems: 0, isLowerBound: false })),
  };
  beforeEach(() => {
    (useRangeReport as jest.Mock).mockReturnValue({ report: range, hidden: false, locked: false, loading: false, error: null, reload: jest.fn() });
    (useWeeklyReport as jest.Mock).mockReturnValue({ report: R.crash_diet ?? Object.values(R)[0], locked: false, loading: false, refreshing: false, error: null, reload: jest.fn() });
  });

  it('opens the breakdown of the period shown from a nutrient of the intake card', async () => {
    const tree = await render(<ReportScreen />);
    await press(tree, 'range-nutrient-protein');
    expect(nav.navigate).toHaveBeenLastCalledWith('NutrientBreakdown', { nutrient: 'protein', from: '2026-10-12', to: '2026-10-18', origin: 'report' });
    await press(tree, 'report-view-more');
    await press(tree, 'range-nutrient-vitaminC');
    expect(nav.navigate).toHaveBeenLastCalledWith('NutrientBreakdown', { nutrient: 'vitaminC', from: '2026-10-12', to: '2026-10-18', origin: 'report' });
  });

  it.each([
    ['day', '2026-10-17', '2026-10-17'],
    ['week', '2026-10-12', '2026-10-18'],
    ['month', '2026-10-01', '2026-10-31'],
    ['year', '2026-01-01', '2026-12-31'],
    ['custom', '2026-10-12', '2026-10-17'],
  ])('opens the selected %s period, including its full calendar bounds', async (period, from, to) => {
    (useRangeReport as jest.Mock).mockImplementation((start: string, end: string) => ({
      report: { ...range, range: { from: start, to: end, through: end > '2026-10-17' ? '2026-10-17' : end } },
      hidden: false, locked: false, loading: false, error: null, reload: jest.fn(),
    }));
    const tree = await render(<ReportScreen />);
    await press(tree, `report-period-${period}`);
    expect(useRangeReport).toHaveBeenLastCalledWith(from, to);
    await press(tree, 'range-nutrient-protein');
    expect(nav.navigate).toHaveBeenLastCalledWith('NutrientBreakdown', { nutrient: 'protein', from, to, origin: 'report' });
  });

  it('does not expose a nutrient row or breakdown link when numbers are hidden', async () => {
    (useHealth as jest.Mock).mockReturnValue({ mode: 'personalised', numbersHidden: true, status: 'ready', revision: 0 });
    (useRangeReport as jest.Mock).mockReturnValue({ report: { ...range, display: { numbersHidden: true }, nutrients: [] }, hidden: true, locked: false, loading: false, error: null, reload: jest.fn() });
    const tree = await render(<ReportScreen />);
    expect(byId(tree, 'range-nutrient-protein')).toHaveLength(0);
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});

describe('a nutrient\'s detail screen', () => {
  it('links to the foods behind it: its week, or for a vitamin the four weeks that end with the week', async () => {
    const report = R.crash_diet ?? Object.values(R)[0]!;
    (useWeeklyReport as jest.Mock).mockReturnValue({ report, locked: false, loading: false, refreshing: false, error: null, reload: jest.fn() });
    rn.useRoute.mockReturnValue({ params: { key: 'protein', start: '2026-10-05', window: 'week' } });
    const week = await render(<NutrientScreen />);
    await press(week, 'detail-breakdown');
    expect(nav.navigate).toHaveBeenLastCalledWith('NutrientBreakdown', { nutrient: 'protein', from: '2026-10-05', to: '2026-10-11', origin: 'report' });
    const vitamin = report.fourWeek[0]!.nutrient;
    rn.useRoute.mockReturnValue({ params: { key: vitamin, start: '2026-10-05', window: 'four_weeks' } });
    const four = await render(<NutrientScreen />);
    await press(four, 'detail-breakdown');
    // 28 days ending Sunday 11 October: 14 September to 11 October
    expect(nav.navigate).toHaveBeenLastCalledWith('NutrientBreakdown', { nutrient: vitamin, from: '2026-09-14', to: '2026-10-11', origin: 'report' });
  });

  it('shows no link when the screen is not given one', async () => {
    const report = R.crash_diet ?? Object.values(R)[0]!;
    const tree = await render(
      <NutrientDetail report={report.nutrients[1]!} name="Protein" unit="g" mode="personalised" window="week" onBack={jest.fn()} onSetGoal={jest.fn()} onHowWeCalculate={jest.fn()} />,
    );
    expect(byId(tree, 'detail-breakdown')).toHaveLength(0);
  });
});
