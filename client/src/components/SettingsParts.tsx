import React from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../theme/useTheme';

/** Строки квот/ёмкости: узлы, модули, квота хранилища. */
export function ProgressRow({
  title,
  icon,
  used,
  total,
  tone = 'accent',
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  used: number;
  total: number;
  tone?: 'accent' | 'success' | 'warning';
}) {
  const theme = useTheme();
  const pct = Math.min(100, (used / Math.max(1, total)) * 100);
  const color = tone === 'success' ? theme.success : tone === 'warning' ? theme.warning : theme.accent;
  return (
    <MotiView
      from={{ opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: 'timing', duration: 200 }}
      style={[styles.row, { backgroundColor: theme.surfaceElevated, borderColor: theme.line }]}
    >
      <View style={[styles.iconBox, { backgroundColor: theme.surfacePressed }]}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.textPrimary, fontWeight: '600', fontSize: 14 }}>{title}</Text>
        <View style={[styles.track, { backgroundColor: theme.surfacePressed }]}>
          <MotiView
            from={{ width: '0%' as `${number}%` }}
            animate={{ width: `${pct}%` as `${number}%` }}
            transition={{ type: 'timing', duration: 240 }}
            style={[styles.fill, { backgroundColor: color }]}
          />
        </View>
      </View>
      <Text style={{ color: theme.textSecondary, fontSize: 13, fontVariant: ['tabular-nums'] as never }}>
        {used} / {total}
      </Text>
    </MotiView>
  );
}

export function SectionTitle({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text style={{ color: theme.textSecondary, fontSize: 12, paddingHorizontal: 4, marginTop: 14, marginBottom: 6, fontWeight: '600' }}>
      {children}
    </Text>
  );
}

/** Пункт меню перехода с иконкой и шевроном. */
export function MenuRow({
  icon,
  title,
  subtitle,
  onPress,
  danger,
  badge,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  onPress: () => void;
  danger?: boolean;
  badge?: string;
}) {
  const theme = useTheme();
  return (
    <MotiView
      from={{ opacity: 0, translateY: 6 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: 'timing', duration: 200 }}
      style={{ backgroundColor: theme.surfaceElevated, borderRadius: 14, marginBottom: 8, overflow: 'hidden', borderWidth: 1, borderColor: theme.line }}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={title}
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.surfacePressed : 'transparent', minHeight: 56 }]}
      >
        <View style={[styles.iconBox, { backgroundColor: danger ? theme.dangerSoft : theme.accentSoft }]}>
          <Ionicons name={icon} size={18} color={danger ? theme.danger : theme.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: danger ? theme.danger : theme.textPrimary, fontWeight: '600', fontSize: 15 }}>{title}</Text>
          {subtitle ? <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}>{subtitle}</Text> : null}
        </View>
        {badge ? (
          <View style={{ backgroundColor: theme.accentSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
            <Text style={{ color: theme.accent, fontSize: 12 }}>{badge}</Text>
          </View>
        ) : null}
        <Ionicons name="chevron-forward" size={16} color={theme.textDisabled} />
      </Pressable>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  iconBox: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  track: { height: 6, borderRadius: 999, overflow: 'hidden', marginTop: 6 },
  fill: { height: '100%', borderRadius: 999 },
});
