/**
 * Малые стеклянные элементы экрана управления: карточки-секции,
 * переключатели, выбор варианта, чипы подразделов и пустые состояния.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { GlassCard } from '../profile/Glass';

export function ManageSection({
  icon,
  title,
  subtitle,
  right,
  children,
  delay = 0,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  delay?: number;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  return (
    <MotiView
      from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay: reduced ? 0 : delay }}
      style={{ marginBottom: 10 }}
    >
      <GlassCard padding={12}>
        <View style={styles.head}>
          {icon ? (
            <View style={[styles.headIcon, { backgroundColor: theme.accentSoft }]}>
              <Ionicons name={icon} size={15} color={theme.accent} />
            </View>
          ) : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1, lineHeight: 15 }} numberOfLines={3}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {right}
        </View>
        <View style={{ marginTop: 10 }}>{children}</View>
      </GlassCard>
    </MotiView>
  );
}

export function ManageToggle({
  label,
  hint,
  value,
  onValueChange,
  disabled,
  icon,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={disabled ? undefined : () => onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      accessibilityLabel={`${label}: ${value ? 'включено' : 'выключено'}`}
      style={({ pressed }) => [
        styles.toggleRow,
        { backgroundColor: pressed && !disabled ? theme.surfacePressed : 'transparent', opacity: disabled ? 0.45 : 1 },
      ]}
    >
      {icon ? <Ionicons name={icon} size={15} color={theme.textSecondary} /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
          {label}
        </Text>
        {hint ? (
          <Text style={{ color: theme.textSecondary, fontSize: 11, marginTop: 1 }} numberOfLines={2}>
            {hint}
          </Text>
        ) : null}
      </View>
      <View
        style={[
          styles.switch,
          { backgroundColor: value ? theme.accent : theme.surfacePressed, borderColor: value ? theme.accent : theme.line },
        ]}
      >
        <View
          style={[
            styles.knob,
            { backgroundColor: value ? theme.onAccent : theme.textSecondary, alignSelf: value ? 'flex-end' : 'flex-start' },
          ]}
        />
      </View>
    </Pressable>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  icon?: keyof typeof Ionicons.glyphMap;
}

/** Карточки-варианты (видимость, срок, роль). */
export function ManageChoice<T extends string>({
  options,
  value,
  onChange,
  disabled,
  compact,
}: {
  options: ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: 6 }}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={disabled ? undefined : () => onChange(option.value)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, disabled: Boolean(disabled) }}
            accessibilityLabel={`${option.label}${option.hint ? `: ${option.hint}` : ''}`}
            style={({ pressed }) => [
              styles.choice,
              {
                borderColor: active ? theme.accent : theme.line,
                backgroundColor: active ? theme.accentSoft : pressed ? theme.surfacePressed : 'transparent',
                opacity: disabled ? 0.5 : 1,
                paddingVertical: compact ? 7 : 9,
              },
            ]}
          >
            {option.icon ? (
              <Ionicons name={option.icon} size={16} color={active ? theme.accent : theme.textSecondary} />
            ) : (
              <View
                style={[
                  styles.radio,
                  { borderColor: active ? theme.accent : theme.textDisabled },
                ]}
              >
                {active ? <View style={[styles.radioDot, { backgroundColor: theme.accent }]} /> : null}
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: active ? theme.accent : theme.textPrimary, fontSize: 13, fontWeight: '600' }}>
                {option.label}
              </Text>
              {option.hint ? (
                <Text style={{ color: theme.textSecondary, fontSize: 10.5, marginTop: 1 }} numberOfLines={2}>
                  {option.hint}
                </Text>
              ) : null}
            </View>
            {active ? <Ionicons name="checkmark-circle" size={16} color={theme.accent} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Горизонтальные чипы подразделов управления. */
export function ManageChips({
  items,
  value,
  onChange,
}: {
  items: { key: string; label: string; badge?: number }[];
  value: string;
  onChange: (key: string) => void;
}) {
  const theme = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 2 }}>
      {items.map((item) => {
        const active = item.key === value;
        return (
          <Pressable
            key={item.key}
            onPress={() => onChange(item.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={item.label}
            style={({ pressed }) => [
              styles.chip,
              {
                backgroundColor: active ? theme.accent : theme.glass,
                borderColor: active ? theme.accent : theme.glassBorder,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text style={{ color: active ? theme.onAccent : theme.textSecondary, fontSize: 12, fontWeight: '700' }}>
              {item.label}
            </Text>
            {typeof item.badge === 'number' && item.badge > 0 ? (
              <View style={[styles.chipBadge, { backgroundColor: active ? theme.onAccent : theme.warning }]}>
                <Text style={{ color: active ? theme.accent : theme.onAccent, fontSize: 9.5, fontWeight: '800' }}>
                  {item.badge}
                </Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function ManageEmpty({ icon = 'sparkles-outline', text }: { icon?: keyof typeof Ionicons.glyphMap; text: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.empty, { borderColor: theme.line, backgroundColor: theme.surface }]}>
      <Ionicons name={icon} size={19} color={theme.textDisabled} />
      <Text style={{ color: theme.textSecondary, fontSize: 12.5, textAlign: 'center', flex: 1 }}>{text}</Text>
    </View>
  );
}

export function ManageBadge({
  text,
  tone = 'neutral',
}: {
  text: string;
  tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'success';
}) {
  const theme = useTheme();
  const bg =
    tone === 'accent'
      ? theme.accentSoft
      : tone === 'warning'
        ? theme.warningSoft
        : tone === 'danger'
          ? theme.dangerSoft
          : tone === 'success'
            ? theme.successSoft
            : theme.surfacePressed;
  const color =
    tone === 'accent'
      ? theme.accent
      : tone === 'warning'
        ? theme.warning
        : tone === 'danger'
          ? theme.danger
          : tone === 'success'
            ? theme.success
            : theme.textSecondary;
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 }}>
      <Text style={{ color, fontSize: 10, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  headIcon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: 10,
    minHeight: 44,
  },
  switch: { width: 38, height: 22, borderRadius: 999, borderWidth: 1, padding: 2, justifyContent: 'center' },
  knob: { width: 16, height: 16, borderRadius: 9 },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
  },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 8, height: 8, borderRadius: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 6,
    minHeight: 30,
  },
  chipBadge: { minWidth: 15, height: 15, borderRadius: 8, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  empty: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderRadius: 12, padding: 12 },
});
