import React, { useId } from 'react';
import { InputAccessoryView, Keyboard, Platform, Pressable, TextInput, View, type TextInputProps } from 'react-native';
import { space, useTheme } from '@/theme';
import { Text } from './Text';

/** iOS number keyboards have no return key. Keep a dismissal control above every numeric input. */
export function KeyboardInput(props: TextInputProps) {
  const accessoryId = useId();
  const { colors } = useTheme();
  const numeric = Platform.OS === 'ios' && ['decimal-pad', 'number-pad', 'numeric'].includes(props.keyboardType ?? '');
  return (
    <>
      <TextInput {...props} inputAccessoryViewID={numeric ? accessoryId : props.inputAccessoryViewID} />
      {numeric ? (
        <InputAccessoryView nativeID={accessoryId} backgroundColor={colors.surface}>
          <View style={{ alignItems: 'flex-end' }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Done editing number"
              onPress={Keyboard.dismiss}
              style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space.lg }}
            >
              <Text variant="bodyStrong" tone="primary">Done</Text>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </>
  );
}
