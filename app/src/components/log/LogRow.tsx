import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronDown, Minus, Plus, X } from 'lucide-react-native';
import type { Meal } from '@/api/types';
import { Badge, Icon, IconButton, Text } from '@/components/kit';
import { usePressed } from '@/components/kit/usePressed';
import { KeyboardInput } from '@/components/kit/KeyboardInput';
import { fill } from '@/i18n/fill';
import { strings } from '@/i18n/strings';
import { createStyles, fontFor, radius, space, useTheme } from '@/theme';
import { stepFor, stepQuantity } from '@/utils/amounts';
import { readNumber } from '@/utils/foodData';

/** One food on its way into the log: what it is, how much, and in what. */
export interface LogRowData {
  /** Local to the screen; stays the same while the amount is edited. */
  id: string;
  /** The choice it came from, so a chip knows it is already here. */
  choiceKey: string;
  /** The meal it was added under, and is saved for: switching the meal afterwards does not move it. */
  meal: Meal | null;
  name: string;
  /** The food it counts as, or null while nobody has entered values for it. */
  foodId: string | null;
  /** As typed; checked when the list is saved. */
  quantity: string;
  unit: string;
  /** Units that already count for the food (empty when that is not known). */
  units: string[];
}

const useStyles = createStyles(({ colors }) => ({
  row: { padding: space.lg, gap: space.md },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  name: { flex: 1, minWidth: 0, gap: space.xs, paddingTop: space.xs },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stepper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceMuted,
  },
  input: {
    flex: 1,
    minWidth: 40,
    padding: 0,
    textAlign: 'center',
    color: colors.text,
    fontSize: 17,
    includeFontPadding: false,
    ...fontFor('semibold'),
  },
  unit: {
    minWidth: 118,
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
  },
}));

/**
 * A food in the list to add: its name and a way to remove it, an amount with - and + (a tap moves it by what is natural for the
 * unit: a piece, half a katori, ten grams), and the unit, which opens a list. The amount can also be typed.
 */
export function LogRow({
  row,
  error,
  counted,
  unitSetUp,
  onQuantity,
  onPickUnit,
  onRemove,
}: {
  row: LogRowData;
  error?: string;
  /** False when the food has no values yet, so the amount is saved but not counted. */
  counted: boolean;
  /** False when the food has values but no way yet to turn this unit into its own, so the amount is saved but not counted. */
  unitSetUp: boolean;
  onQuantity: (text: string) => void;
  onPickUnit: () => void;
  onRemove: () => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [focused, setFocused] = useState(false);
  const unitPress = usePressed();
  const current = readNumber(row.quantity);
  const atLeast = current !== null && current > 0 && current <= stepFor(row.unit);
  const outline = error ? colors.danger : focused ? colors.primary : 'transparent';

  return (
    <View style={styles.row} testID={`row-${row.id}`}>
      <View style={styles.top}>
        <View style={styles.name}>
          <Text variant="bodyStrong" numberOfLines={2}>
            {row.name}
          </Text>
          {counted ? null : <Badge label={strings.log.noValues} tone="warning" />}
          {counted && !unitSetUp ? <Badge label={strings.log.unitNotSetUp} tone="warning" /> : null}
        </View>
        <IconButton
          testID={`remove-${row.id}`}
          icon={X}
          size={36}
          tone="muted"
          accessibilityLabel={fill(strings.log.remove, { name: row.name })}
          onPress={onRemove}
        />
      </View>

      <View style={styles.controls}>
        <View style={[styles.stepper, { borderWidth: error || focused ? 1.5 : 0, borderColor: outline }]}>
          <IconButton
            testID={`less-${row.id}`}
            icon={Minus}
            size={44}
            accessibilityLabel={fill(strings.log.decrease, { name: row.name })}
            disabled={atLeast}
            onPress={() => onQuantity(stepQuantity(row.quantity, row.unit, -1))}
          />
          <KeyboardInput
            testID={`qty-${row.id}`}
            value={row.quantity}
            onChangeText={onQuantity}
            keyboardType="decimal-pad"
            selectTextOnFocus
            selectionColor={colors.primary}
            cursorColor={colors.primary}
            style={styles.input}
            accessibilityLabel={`${strings.log.quantity}, ${row.name}`}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
          <IconButton
            testID={`more-${row.id}`}
            icon={Plus}
            size={44}
            accessibilityLabel={fill(strings.log.increase, { name: row.name })}
            onPress={() => onQuantity(stepQuantity(row.quantity, row.unit, 1))}
          />
        </View>
        <Pressable
          testID={`unit-${row.id}`}
          accessibilityRole="button"
          accessibilityLabel={fill(strings.log.unitOf, { name: row.name, unit: row.unit })}
          onPress={onPickUnit}
          {...unitPress.handlers}
          style={[styles.unit, { backgroundColor: unitPress.pressed ? colors.surfaceMuted : colors.surface, borderColor: colors.borderStrong }]}
        >
          <Text variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>
            {row.unit}
          </Text>
          <Icon as={ChevronDown} size="md" tone="muted" />
        </Pressable>
      </View>
      {error ? (
        <Text variant="small" tone="danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
