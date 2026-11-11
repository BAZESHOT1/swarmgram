import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { GlassCard } from '../profile/Glass';

export interface InfoActionItem {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  onPress: () => void;
  danger?: boolean;
  loading?: boolean;
  disabled?: boolean;
}

/** Нижний блок действий чата: выход, удаление, блокировка, подписка. */
export function InfoActions({ actions }: { actions: InfoActionItem[] }) {
  const theme = useTheme();
  return (
    <GlassCard padding={8}>
      <View style={{ gap: 2 }}>
        {actions.map((action) => {
          const color = action.disabled ? theme.textDisabled : action.danger ? theme.danger : theme.textPrimary;
          const iconColor = action.disabled ? theme.textDisabled : action.danger ? theme.danger : theme.textSecondary;
          return (
            <Pressable
              key={action.key}
              onPress={action.onPress}
              disabled={action.disabled || action.loading}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? theme.surfacePressed : 'transparent',
                  opacity: action.disabled ? 0.5 : action.loading ? 0.65 : 1,
                },
              ]}
            >
              <View
                style={[
                  styles.iconBox,
                  { backgroundColor: action.danger ? theme.dangerSoft : action.disabled ? theme.surfacePressed : theme.surfacePressed },
                ]}
              >
                <Ionicons name={action.loading ? 'hourglass-outline' : action.icon} size={17} color={iconColor} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                  {action.loading ? 'Подождите…' : action.label}
                </Text>
                {action.hint ? (
                  <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={2}>
                    {action.hint}
                  </Text>
                ) : null}
              </View>
              {!action.disabled ? <Ionicons name="chevron-forward" size={15} color={theme.textDisabled} /> : null}
            </Pressable>
          );
        })}
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 9, borderRadius: 11, minHeight: 54 },
  iconBox: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
