import React from 'react';
import { View } from 'react-native';
import { PhoneForwarded } from 'lucide-react-native';
import { Button, Card, Icon, Text } from '@/components/kit';
import { fill } from '@/i18n/fill';
import { strings } from '@/i18n/strings';
import { createStyles, radius, space } from '@/theme';

const t = strings.callback;

const useStyles = createStyles(({ colors }) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md + 2, paddingLeft: space.lg, paddingRight: space.md },
  tile: { width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 2 },
}));

/**
 * The call the person asked for during a call ("call me again in 20 minutes"), while it is waiting: when it comes, and a way to take it
 * back. Not drawn at all when there is none.
 */
export function CallbackCard({ clock, inWords, onCancel }: { clock: string; inWords: string; onCancel: () => void }) {
  const styles = useStyles();
  return (
    <Card padding="none" testID="callback-card">
      <View style={styles.row}>
        <View style={styles.tile}>
          <Icon as={PhoneForwarded} size="md" tone="primary" />
        </View>
        <View style={styles.body} accessible accessibilityLabel={`${fill(t.title, { clock })}. ${fill(t.subtitle, { inWords })}`}>
          <Text variant="bodyStrong">{fill(t.title, { clock: clock.toUpperCase() })}</Text>
          <Text variant="small" tone="muted" numberOfLines={2}>
            {fill(t.subtitle, { inWords })}
          </Text>
        </View>
        <Button testID="callback-cancel" label="Cancel" variant="ghost" size="sm" accessibilityLabel={t.cancel} onPress={onCancel} />
      </View>
    </Card>
  );
}
