import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { glassStyle } from './Glass';
import { PressableScale } from './PressableScale';

export interface ProfileAction {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Опасное действие — красный иконка/текст. */
  danger?: boolean;
  loading?: boolean;
}

/** Сетка быстрых действий профиля (2×2), каждая — стеклянная плитка. */
export function ProfileActions({ actions }: { actions: ProfileAction[] }) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  return (
    <View style={styles.grid}>
      {actions.map((a, index) => {
        const color = a.danger ? theme.danger : a.disabled ? theme.textDisabled : theme.accent;
        return (
          <MotiView
            key={a.key}
            from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 12, scale: 0.98 }}
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
              disabled={a.disabled || a.loading}
              accessibilityRole="button"
              accessibilityLabel={a.label}
              style={[
                glassStyle(theme.dark, 16),
                styles.tile,
                { opacity: a.disabled ? 0.5 : 1 },
              ]}
            >
              <View style={[styles.iconBox, { backgroundColor: a.danger ? theme.dangerSoft : theme.accentSoft }]}>
                <Ionicons name={a.loading ? 'hourglass-outline' : a.icon} size={18} color={color} />
              </View>
              <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '600', flex: 1 }} numberOfLines={2}>
                {a.loading ? 'Подождите…' : a.label}
              </Text>
              {!a.disabled && !a.loading ? <Ionicons name="chevron-forward" size={14} color={theme.textDisabled} /> : null}
            </PressableScale>
          </MotiView>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: '48.7%', minWidth: 150, flexGrow: 1 },
  tile: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 10, paddingVertical: 10, minHeight: 58 },
  iconBox: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
