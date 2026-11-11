import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/useTheme';
import { useHaptics } from './useHaptics';

export function Btn({
  title,
  onPress,
  variant = 'primary',
  size = 'm',
  disabled,
  loading,
  accessibilityLabel,
}: {
  title: string;
  onPress?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 's' | 'm';
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const haptics = useHaptics();
  const bg = variant === 'primary' ? theme.accent : variant === 'danger' ? theme.danger : 'transparent';
  const fg = variant === 'primary' || variant === 'danger' ? theme.onAccent : theme.textPrimary;
  const border = variant === 'ghost' ? 1 : 0;
  const height = size === 's' ? 36 : 44;
  return (
    <Pressable
      onPress={() => {
        // Не вибрируем на заблокированной/загружающейся кнопке.
        if (disabled || loading) return;
        haptics.tap();
        onPress?.();
      }}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      style={({ pressed }) => [
        styles.btn,
        {
          height,
          backgroundColor: bg,
          borderColor: border ? theme.line : 'transparent',
          borderWidth: border,
          opacity: disabled ? 0.5 : pressed ? 0.9 : 1,
        },
      ]}
    >
      <View>
        <Text style={{ color: fg, fontWeight: '600', fontSize: 14 }}>
          {loading ? 'Подождите…' : title}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center', minHeight: 36 },
});
