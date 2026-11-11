/**
 * «Внешний вид»: тема (системная/тёмная/светлая), акцентный цвет и язык.
 * Акцент меняется мгновенно через store; выбор анимируется spring-эффектом.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useRouter } from 'expo-router';
import { useTheme } from '../../../src/theme/useTheme';
import { motion } from '../../../src/theme/motion';
import { ACCENTS, type AccentName } from '../../../src/theme/theme';
import {
  GlassCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../../../src/components/settings/SettingsUI';
import { PressableScale } from '../../../src/components/profile/PressableScale';
import { useReducedMotion } from '../../../src/components/useReducedMotion';
import { useStore, type ThemeName } from '../../../src/state/useStore';

/** Варианты темы в порядке отображения. */
const THEME_OPTIONS: Array<{
  value: ThemeName;
  label: string;
  hint: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  { value: 'system', label: 'Системная', hint: 'Как в операционной системе', icon: 'phone-portrait-outline' },
  { value: 'dark', label: 'Тёмная', hint: 'Тёмный фон, мягкие акценты', icon: 'moon-outline' },
  { value: 'light', label: 'Светлая', hint: 'Светлый фон для дневного света', icon: 'sunny-outline' },
];

/** Порядок акцентов в палитре. */
const ACCENT_ORDER: AccentName[] = ['orange', 'blue', 'green', 'purple', 'pink'];

export default function AppearanceScreen() {
  const theme = useTheme();
  const router = useRouter();
  const reduced = useReducedMotion();
  const themeName = useStore((s) => s.themeName);
  const setThemeName = useStore((s) => s.setThemeName);
  const accentName = useStore((s) => s.accentName);
  const setAccent = useStore((s) => s.setAccent);

  return (
    <SettingsPage title="Внешний вид" subtitle="Тема, акцентный цвет и язык интерфейса">
      {/* -------------------------------------------------------- тема ---- */}
      <SettingsSection title="Тема" delay={0}>
        <GlassCard>
          {THEME_OPTIONS.map((option, index) => {
            const selected = themeName === option.value;
            return (
              <SettingsRow
                key={option.value}
                icon={option.icon}
                title={option.label}
                subtitle={option.hint}
                delay={index * motion.staggerStepMs}
                onPress={() => setThemeName(option.value)}
                right={
                  selected ? (
                    <Ionicons name="checkmark-circle" size={21} color={theme.accent} />
                  ) : (
                    <View style={[styles.radio, { borderColor: theme.line }]} />
                  )
                }
              />
            );
          })}
        </GlassCard>
        <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 8, paddingHorizontal: 4 }}>
          Системная тема автоматически следует настройке устройства. Переключение применяется сразу.
        </Text>
      </SettingsSection>

      {/* ------------------------------------------------------ акцент ---- */}
      <SettingsSection title="Акцентный цвет" delay={60}>
        <GlassCard>
          <View style={styles.accentGrid}>
            {ACCENT_ORDER.map((name) => {
              const accent = ACCENTS[name];
              const selected = accentName === name;
              return (
                <PressableScale
                  key={name}
                  onPress={() => setAccent(name)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`Акцент: ${accent.label}`}
                  scaleTo={0.94}
                  style={styles.accentCell}
                >
                  <MotiView
                    animate={
                      reduced
                        ? { scale: 1 }
                        : { scale: selected ? 1.06 : 1, translateY: selected ? -1 : 0 }
                    }
                    transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
                    style={[
                      styles.swatch,
                      {
                        backgroundColor: accent.color,
                        borderColor: selected ? theme.textPrimary : 'transparent',
                      },
                    ]}
                  >
                    {selected ? <Ionicons name="checkmark" size={20} color={accent.on} /> : null}
                  </MotiView>
                  <Text
                    style={{
                      color: selected ? theme.textPrimary : theme.textSecondary,
                      fontSize: 11.5,
                      fontWeight: selected ? '700' : '500',
                      marginTop: 6,
                      textAlign: 'center',
                    }}
                    numberOfLines={1}
                  >
                    {accent.label}
                  </Text>
                </PressableScale>
              );
            })}
          </View>
        </GlassCard>
        <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 8, paddingHorizontal: 4 }}>
          Акцент используется для кнопок, ссылок и активных элементов интерфейса.
        </Text>
      </SettingsSection>

      {/* -------------------------------------------------------- язык ---- */}
      <SettingsSection title="Язык" delay={120}>
        <GlassCard>
          <SettingsRow
            icon="language-outline"
            title="Язык интерфейса"
            subtitle="Русский"
            onPress={() => router.push('/language' as never)}
          />
        </GlassCard>
      </SettingsSection>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  radio: { width: 19, height: 19, borderRadius: 10, borderWidth: 1.5 },
  accentGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 12,
    gap: 10,
  },
  accentCell: { alignItems: 'center', width: 58, paddingVertical: 2 },
  swatch: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
