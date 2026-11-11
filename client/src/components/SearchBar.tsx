import React from 'react';
import { Text, TextInput, View, StyleSheet } from 'react-native';
import { useTheme } from '../theme/useTheme';

export function SearchBar({
  value,
  onChange,
  placeholder = 'Поиск',
  accessibilityLabel,
}: {
  value: string;
  onChange: (t: string) => void;
  placeholder?: string;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.wrap, { borderColor: theme.line, backgroundColor: theme.surface }]}>
      <Text style={{ color: theme.textDisabled, fontSize: 15 }}>⌕</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.textDisabled}
        accessibilityLabel={accessibilityLabel ?? 'Строка поиска'}
        style={[styles.input, { color: theme.textPrimary }]}
      />
      {value ? (
        <Text onPress={() => onChange('')} accessibilityRole="button" accessibilityLabel="Очистить поиск" style={{ color: theme.textSecondary, paddingHorizontal: 6 }}>
          ✕
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, minHeight: 44, gap: 8 },
  input: { flex: 1, paddingVertical: 10, fontSize: 15 },
});
