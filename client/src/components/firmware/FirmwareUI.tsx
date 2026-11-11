/**
 * Стеклянные примитивы визарда прошивки: заголовок шага, карточки выбора,
 * пилюли, предупреждения и индикатор прогресса.
 */
import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { GlassCard } from '../settings/SettingsUI';
import type { BadgeTone } from '../settings/SettingsWidgets';

const toneColors = (
  theme: ReturnType<typeof useTheme>,
  tone: BadgeTone,
): { bg: string; fg: string } => {
  switch (tone) {
    case 'accent':
      return { bg: theme.accentSoft, fg: theme.accent };
    case 'success':
      return { bg: theme.successSoft, fg: theme.success };
    case 'warning':
      return { bg: theme.warningSoft, fg: theme.warning };
    case 'danger':
      return { bg: theme.dangerSoft, fg: theme.danger };
    default:
      return { bg: theme.surfacePressed, fg: theme.textSecondary };
  }
};

/** Заголовок шага: номер, название и короткое пояснение. */
export function StepHeader({
  index,
  title,
  description,
}: {
  index: number;
  title: string;
  description: string;
}) {
  const theme = useTheme();
  return (
    <View style={{ marginBottom: 14, paddingHorizontal: 2 }}>
      <Text style={{ color: theme.accent, fontSize: 11.5, fontWeight: '800', letterSpacing: 0.7 }}>
        ШАГ {index} ИЗ 8
      </Text>
      <Text style={{ color: theme.textPrimary, fontSize: 20, fontWeight: '800', marginTop: 3 }}>{title}</Text>
      <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 5 }}>{description}</Text>
    </View>
  );
}

/** Крупная карточка выбора с иконкой, описанием и состоянием. */
export function ChoiceCard({
  icon,
  title,
  subtitle,
  description,
  selected,
  onPress,
  accessibilityLabel,
  delay = 0,
  right,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  delay?: number;
  right?: React.ReactNode;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  return (
    <MotiView
      from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay }}
      style={{ marginBottom: 8 }}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? title}
        accessibilityState={{ selected }}
        style={({ pressed }) => ({
          borderRadius: 18,
          borderWidth: 1,
          borderColor: selected ? theme.accent : theme.glassBorder,
          backgroundColor: selected ? theme.accentSoft : theme.glass,
          padding: 13,
          opacity: pressed ? 0.86 : 1,
          ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(18px) saturate(1.4)' } as object) : null),
        })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: selected ? theme.accentSoft : theme.surfacePressed,
            }}
          >
            <Ionicons name={icon} size={20} color={selected ? theme.accent : theme.textSecondary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>
                {title}
              </Text>
              {selected ? <Ionicons name="checkmark-circle" size={16} color={theme.accent} /> : null}
            </View>
            {subtitle ? (
              <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 2 }} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
            {description ? (
              <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 5 }}>{description}</Text>
            ) : null}
            {right ? <View style={{ marginTop: 8 }}>{right}</View> : null}
          </View>
        </View>
      </Pressable>
    </MotiView>
  );
}

/** Компактные пилюли для выбора одного значения из набора. */
export function PillGroup<T extends string | number>({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label?: string;
}) {
  const theme = useTheme();
  return (
    <View style={{ marginBottom: 12 }}>
      {label ? (
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 7, paddingHorizontal: 2 }}>
          {label}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={String(option.value)}
              onPress={() => onChange(option.value)}
              accessibilityRole="button"
              accessibilityLabel={`${label ?? ''} ${option.label}`.trim()}
              accessibilityState={{ selected: active }}
              style={({ pressed }) => ({
                minHeight: 34,
                paddingHorizontal: 12,
                borderRadius: 999,
                borderWidth: 1,
                alignItems: 'center',
                justifyContent: 'center',
                borderColor: active ? theme.accent : theme.line,
                backgroundColor: active ? theme.accentSoft : 'transparent',
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Text style={{ color: active ? theme.accent : theme.textSecondary, fontSize: 12.5, fontWeight: active ? '700' : '600' }}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Плашка-предупреждение или подсказка. */
export function Note({
  icon = 'information-circle-outline',
  tone = 'accent',
  children,
}: {
  icon?: keyof typeof Ionicons.glyphMap;
  tone?: BadgeTone;
  children: React.ReactNode;
}) {
  const theme = useTheme();
  const palette = toneColors(theme, tone);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        padding: 11,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.glassBorder,
        backgroundColor: palette.bg,
        marginBottom: 12,
      }}
    >
      <Ionicons name={icon} size={16} color={palette.fg} style={{ marginTop: 1 }} />
      <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17.5, flex: 1 }}>{children}</Text>
    </View>
  );
}

/** Индикатор 1…8: активный шаг шире, пройденные с галочкой. */
export function WizardProgress({ step, onStepPress }: { step: number; onStepPress?: (step: number) => void }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 16, paddingHorizontal: 2 }}>
      {Array.from({ length: 8 }).map((_, index) => {
        const number = index + 1;
        const done = number < step;
        const active = number === step;
        const color = done ? theme.success : active ? theme.accent : theme.line;
        const content = (
          <MotiView
            animate={{ flex: active ? 2.4 : 1, opacity: done || active ? 1 : 0.55 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.quick}
            style={{ height: 6, borderRadius: 999, backgroundColor: color }}
          />
        );
        if (!onStepPress) {
          return (
            <View key={number} style={{ flex: active ? 2.4 : 1 }}>
              {content}
            </View>
          );
        }
        return (
          <Pressable
            key={number}
            onPress={() => onStepPress(number)}
            accessibilityRole="button"
            accessibilityLabel={`Шаг ${number}`}
            style={{ flex: active ? 2.4 : 1, minHeight: 22, justifyContent: 'center' }}
          >
            {content}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Строка сводки: подпись, значение и шеврон для перехода к шагу. */
export function SummaryRow({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        minHeight: 44,
      }}
    >
      <Text style={{ color: theme.textSecondary, fontSize: 12, width: 108 }}>{label}</Text>
      <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '600', flex: 1 }} numberOfLines={2}>
        {value}
      </Text>
      {onPress ? <Ionicons name="chevron-forward" size={15} color={theme.textDisabled} /> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Изменить: ${label}`}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      {body}
    </Pressable>
  );
}

/** Стеклянная карточка с внутренним отступом. */
export function StepCard({ children, style }: { children: React.ReactNode; style?: object }) {
  return (
    <GlassCard style={style}>
      <View style={{ padding: 13 }}>{children}</View>
    </GlassCard>
  );
}

/** Текст ошибки шага. */
export function ErrorText({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <Text accessibilityRole="alert" style={{ color: theme.danger, fontSize: 12, lineHeight: 17, marginBottom: 10 }}>
      {children}
    </Text>
  );
}

/** Моноширинный лог сборки/прошивки с автоскроллом. */
export function MonoLog({ text, height = 180 }: { text: string; height?: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        height,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.line,
        backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(16,24,40,0.05)',
        padding: 9,
        overflow: 'hidden',
      }}
    >
      <Text
        selectable
        style={{
          color: theme.textSecondary,
          fontSize: 10.5,
          lineHeight: 15,
          fontFamily: Platform.select({ web: 'ui-monospace, SFMono-Regular, Menlo, monospace', default: 'monospace' }),
        }}
      >
        {text || 'Лог пока пуст.'}
      </Text>
    </View>
  );
}
