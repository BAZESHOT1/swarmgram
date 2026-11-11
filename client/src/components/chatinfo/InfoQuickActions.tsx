import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { PressableScale } from '../profile/PressableScale';
import { glassStyle } from '../profile/Glass';

export interface QuickAction {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
}

/** Три быстрых действия в шапке информации о чате. */
export function InfoQuickActions({ actions }: { actions: QuickAction[] }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  return (
    <View style={styles.row}>
      {actions.map((a, index) => {
        const color = a.disabled ? theme.textDisabled : a.active ? theme.accent : theme.textPrimary;
        return (
          <MotiView
            key={a.key}
            from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.98 }}
            animate={{ opacity: 1, translateY: 0, scale: 1 }}
            transition={
              reduced
                ? { type: 'timing', duration: 0 }
                : { ...motion.spring, delay: Math.min(index, 4) * motion.staggerStepMs }
            }
            style={styles.cell}
          >
            <PressableScale
              onPress={a.onPress}
              disabled={a.disabled}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              accessibilityState={{ disabled: a.disabled, selected: a.active }}
              style={[
                glassStyle(theme.dark, 16),
                styles.tile,
                {
                  opacity: a.disabled ? 0.45 : 1,
                  borderColor: a.active ? theme.accent : (glassStyle(theme.dark, 16) as any).borderColor,
                },
              ]}
            >
              <View style={[styles.iconBox, { backgroundColor: a.active ? theme.accentSoft : theme.surfacePressed }]}>
                <Ionicons name={a.icon} size={19} color={a.active ? theme.accent : color} />
              </View>
              <Text style={{ color, fontSize: 12.5, fontWeight: '600', textAlign: 'center' }} numberOfLines={2}>
                {a.label}
              </Text>
              {a.hint ? (
                <Text style={{ color: a.active ? theme.accent : theme.textSecondary, fontSize: 10.5, textAlign: 'center' }} numberOfLines={1}>
                  {a.hint}
                </Text>
              ) : null}
            </PressableScale>
          </MotiView>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  cell: { flex: 1 },
  tile: { alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 11, paddingHorizontal: 6, minHeight: 78 },
  iconBox: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
});
