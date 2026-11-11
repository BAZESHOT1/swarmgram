import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { PressableScale } from './PressableScale';
import { glassStyle } from './Glass';

export interface ProfileTab {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}

/** Сегментированные вкладки профиля: «Обзор» / «Безопасность». */
export function ProfileTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: ProfileTab[];
  value: string;
  onChange: (key: string) => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  return (
    <View style={[styles.wrap, glassStyle(theme.dark, 14)]}>
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <PressableScale
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}
            style={[styles.tab, active && { backgroundColor: theme.accentSoft }]}
          >
            {active ? (
              <MotiView
                from={reduced ? undefined : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={reduced ? { type: 'timing', duration: 0 } : motion.quick}
                style={[StyleSheet.absoluteFill, { borderRadius: 11, borderWidth: 1, borderColor: theme.accent }]}
              />
            ) : null}
            <Ionicons name={tab.icon} size={15} color={active ? theme.accent : theme.textSecondary} />
            <Text style={{ color: active ? theme.accent : theme.textSecondary, fontSize: 13, fontWeight: active ? '700' : '600' }}>
              {tab.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', padding: 4, gap: 4 },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 38,
    borderRadius: 11,
    overflow: 'hidden',
  },
});
