/**
 * Общие стеклянные компоненты для страниц настроек и их подстраниц.
 * Единый стиль: заголовок, секции, карточки, строки с иконками и шевронами.
 */
import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { PressableScale } from '../profile/PressableScale';
import type { Theme } from '../../theme/theme';

export function GlassCard({ children, style }: { children: React.ReactNode; style?: object }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.glass, borderColor: theme.glassBorder },
        Platform.OS === 'web' ? ({ backdropFilter: 'blur(18px) saturate(1.4)' } as object) : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SettingsSection({
  title,
  right,
  children,
  delay = 0,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  /** Задержка появления секции для мягкого stagger-эффекта. */
  delay?: number;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  return (
    <MotiView
      from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.995 }}
      animate={{ opacity: 1, translateY: 0, scale: 1 }}
      transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay }}
    >
      <View style={{ marginBottom: 18 }}>
        <View style={styles.sectionHead}>
          <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>{title.toUpperCase()}</Text>
          {right}
        </View>
        {children}
      </View>
    </MotiView>
  );
}

export function SettingsRow({
  icon,
  title,
  subtitle,
  right,
  onPress,
  danger,
  disabled,
  accessibilityLabel,
  delay = 0,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  danger?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** Задержка появления строки (stagger внутри карточки). */
  delay?: number;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const color = danger ? theme.danger : theme.textPrimary;
  const content = (
    <>
      {icon ? (
        <View style={[styles.rowIcon, { backgroundColor: danger ? theme.dangerSoft : theme.accentSoft }]}>
          <Ionicons name={icon} size={17} color={danger ? theme.danger : theme.accent} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color, fontSize: 14.5, fontWeight: '600' }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 1.5 }} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={16} color={theme.textDisabled} /> : null)}
    </>
  );

  return (
    <MotiView
      from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 6 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay }}
    >
      {onPress ? (
        <PressableScale
          onPress={disabled ? undefined : onPress}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? title}
          style={[styles.row, disabled ? { opacity: 0.5 } : null]}
        >
          {content}
        </PressableScale>
      ) : (
        <View style={[styles.row, disabled && { opacity: 0.5 }]}>{content}</View>
      )}
    </MotiView>
  );
}

export function SettingsToggle({
  icon,
  title,
  subtitle,
  value,
  onValueChange,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <SettingsRow
      icon={icon}
      title={title}
      subtitle={subtitle}
      onPress={() => onValueChange(!value)}
      accessibilityLabel={`${title}: ${value ? 'включено' : 'выключено'}`}
      right={
        <View style={[styles.switch, { backgroundColor: value ? theme.accent : theme.surfacePressed, borderColor: value ? theme.accent : theme.line }]}>
          <View style={[styles.knob, { backgroundColor: value ? theme.onAccent : theme.textSecondary, alignSelf: value ? 'flex-end' : 'flex-start' }]} />
        </View>
      }
    />
  );
}

export function SettingsPage({
  title,
  subtitle,
  children,
  right,
  scroll = true,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  scroll?: boolean;
}) {
  const theme = useTheme();
  const body = <View style={{ paddingHorizontal: 16, paddingBottom: 120 }}>{children}</View>;
  return (
    <View style={{ flex: 1 }}>
      <View style={[styles.pageHead, { borderBottomColor: theme.line }]}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Назад"
          hitSlop={8}
          style={({ pressed }) => [styles.backBtn, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Ionicons name="chevron-back" size={22} color={theme.textSecondary} />
        </Pressable>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.textPrimary, fontSize: 21, fontWeight: '800' }} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right}
      </View>
      {scroll ? (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: 14 }}>
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </View>
  );
}

export function SettingsBadge({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'accent' | 'danger' }) {
  const theme = useTheme();
  const bg = tone === 'accent' ? theme.accentSoft : tone === 'danger' ? theme.dangerSoft : theme.surfacePressed;
  const color = tone === 'accent' ? theme.accent : tone === 'danger' ? theme.danger : theme.textSecondary;
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
      <Text style={{ color, fontSize: 10.5, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

export function useSettingsTheme(): Theme {
  return useTheme();
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
    padding: 4,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, paddingHorizontal: 4 },
  sectionTitle: { fontSize: 11.5, fontWeight: '700', letterSpacing: 0.6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 14,
    minHeight: 48,
  },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  switch: { width: 42, height: 24, borderRadius: 999, borderWidth: 1, padding: 2, justifyContent: 'center' },
  knob: { width: 18, height: 18, borderRadius: 999 },
  pageHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backBtn: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
});
