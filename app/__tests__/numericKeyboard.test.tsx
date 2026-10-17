import React from 'react';
import { InputAccessoryView, Keyboard, Platform, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { Field, InlineField } from '@/components/kit';
import { ThemeProvider } from '@/theme';

jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

const originalOS = Platform.OS;
let tree: TestRenderer.ReactTestRenderer;
afterEach(async () => {
  if (tree) await act(async () => tree.unmount());
  Object.defineProperty(Platform, 'OS', { value: originalOS });
  jest.restoreAllMocks();
});

it('offers a Done control for each iOS number field without saving or changing its value', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'ios' });
  const dismiss = jest.spyOn(Keyboard, 'dismiss');
  const change = jest.fn();
  await act(async () => {
    tree = TestRenderer.create(<ThemeProvider>
      <Field label="Quantity" value="1.5" onChangeText={change} keyboardType="decimal-pad" />
      <InlineField label="Protein" value="20" onChangeText={change} />
      <Field label="Birth year" value="1990" onChangeText={change} keyboardType="number-pad" />
      <Field label="Username" value="Zoe" onChangeText={change} />
    </ThemeProvider>);
  });
  const inputs = tree.root.findAllByType(TextInput);
  const ids = inputs.slice(0, 3).map(n => n.props.inputAccessoryViewID);
  expect(new Set(ids).size).toBe(3);
  expect(ids.every(Boolean)).toBe(true);
  expect(inputs[3].props.inputAccessoryViewID).toBeUndefined();
  expect(tree.root.findAllByType(InputAccessoryView).map(n => n.props.nativeID)).toEqual(ids);
  const done = tree.root.findAll(n => n.props.accessibilityLabel === 'Done editing number' && typeof n.props.onPress === 'function')[0];
  await act(async () => done.props.onPress());
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
});

it('uses the normal Android numeric keyboard without an iOS accessory', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android' });
  await act(async () => {
    tree = TestRenderer.create(<ThemeProvider><Field value="1" onChangeText={jest.fn()} keyboardType="decimal-pad" /></ThemeProvider>);
  });
  expect(tree.root.findAllByType(InputAccessoryView)).toHaveLength(0);
  expect(tree.root.findByType(TextInput).props.keyboardType).toBe('decimal-pad');
});
