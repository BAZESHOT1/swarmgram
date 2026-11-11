import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { glassStyle } from '../profile/Glass';

export interface InfoTabItem {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  badge?: number;
}

/** Стеклянная панель вкладок с анимированной активной таблеткой. */
export function InfoTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: InfoTabItem[];
  value: string;
  onChange: (key: string) => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  return (
    <View style={[glassStyle(theme.dark, 14), styles.bar]}>
      {tabs.map((tab) => {
        const active = tab.key === value;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}
            style={styles.tab}
          >
            {active ? (
              <MotiView
                from={reduced ? { opacity: 1 } : { opacity: 0.4, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
                style={[StyleSheet.absoluteFill, { backgroundColor: theme.accentSoft, borderRadius: 10 }]}
              />
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Ionicons name={tab.icon} size={14} color={active ? theme.accent : theme.textSecondary} />
              <Text style={{ color: active ? theme.accent : theme.textSecondary, fontSize: 12.5, fontWeight: active ? '700' : '500' }} numberOfLines={1}>
                {tab.label}
              </Text>
              {typeof tab.badge === 'number' && tab.badge > 0 ? (
                <View style={[styles.badge, { backgroundColor: active ? theme.accent : theme.surfacePressed }]}>
                  <Text style={{ color: active ? theme.onAccent : theme.textSecondary, fontSize: 9.5, fontWeight: '700' }}>{tab.badge}</Text>
                </View>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', gap: 4, padding: 4, marginBottom: 10 },
  tab: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingHorizontal: 4 },
  badge: { minWidth: 15, height: 15, borderRadius: 8, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
});
