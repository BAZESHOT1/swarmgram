import React from 'react';
import { ScrollView, View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/useTheme';
import { useBodyBackground } from '../theme/useBodyBackground';
import { useReducedMotion } from './useReducedMotion';

/**
 * Glass-карточка авторизации: мягкий градиентный фон, анимированный логотип,
 * контент — stagger-всплытие. Адаптирована под смартфоны: компактные отступы,
 * карточка на всю ширину, учёт safe-area и клавиатуры.
 */
export function AuthShell({ children, maxWidth = 460 }: { children: React.ReactNode; maxWidth?: number }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const compact = width < 480;
  useBodyBackground();

  return (
    <ScrollView
      contentContainerStyle={[
        styles.scroll,
        {
          paddingTop: compact ? Math.max(insets.top, 8) + 24 : 64,
          paddingBottom: Math.max(insets.bottom, 8) + 24,
          paddingHorizontal: compact ? 14 : 20,
        },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      {/* Фоновые цветные пятна (при reduced-motion — статичные) */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <MotiView
          from={reduced ? { opacity: 0.35 } : { opacity: 0, scale: 0.9 }}
          animate={reduced ? { opacity: 0.35 } : { opacity: 0.5, scale: 1, translateY: -10 }}
          transition={{ type: 'timing', duration: reduced ? 200 : 1400, repeat: reduced ? 0 : Infinity, repeatReverse: true }}
          style={[styles.blob, styles.blob1, { backgroundColor: 'rgba(245,166,35,0.16)' }]}
        />
        <MotiView
          from={reduced ? { opacity: 0.25 } : { opacity: 0, scale: 0.85 }}
          animate={reduced ? { opacity: 0.3 } : { opacity: 0.42, scale: 1.05, translateY: 12 }}
          transition={{ type: 'timing', duration: reduced ? 200 : 1800, repeat: reduced ? 0 : Infinity, repeatReverse: true }}
          style={[styles.blob, styles.blob2, { backgroundColor: 'rgba(232,130,12,0.14)' }]}
        />
        <MotiView
          from={reduced ? { opacity: 0.2 } : { opacity: 0, scale: 1.05 }}
          animate={reduced ? { opacity: 0.28 } : { opacity: 0.34, scale: 0.95 }}
          transition={{ type: 'timing', duration: reduced ? 200 : 2200, repeat: reduced ? 0 : Infinity, repeatReverse: true }}
          style={[styles.blob, styles.blob3, { backgroundColor: 'rgba(46,168,232,0.12)' }]}
        />
      </View>

      <View style={[styles.center, { maxWidth }]}>
        {/* Логотип */}
        <MotiView from={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', damping: 16, stiffness: 200 }}>
          <View style={[styles.logoRing, compact && styles.logoRingCompact, { borderColor: theme.accentSoft }]}>
            <MotiView
              animate={reduced ? { scale: 1 } : { scale: [1, 1.06, 1] }}
              transition={{ type: 'timing', duration: 1600, repeat: reduced ? 0 : Infinity, repeatReverse: true }}
              style={[styles.logo, compact && styles.logoCompact, theme.shadow, { backgroundColor: theme.accent }]}
            >
              <Ionicons name="git-network" size={compact ? 22 : 26} color={theme.onAccent} />
            </MotiView>
          </View>
        </MotiView>

        <MotiView
          from={{ opacity: 0, translateY: 14 }}
          animate={{ opacity: 1, translateY: 0 }}
          transition={{ type: 'timing', duration: 240, delay: 80 }}
          style={[
            styles.card,
            compact && styles.cardCompact,
            {
              backgroundColor: theme.dark ? 'rgba(16,23,34,0.78)' : 'rgba(255,255,255,0.82)',
              borderColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(16,24,40,0.06)',
              width: '100%',
              maxWidth,
            },
          ]}
        >
          {children}
        </MotiView>

        <Text style={{ color: theme.textDisabled, fontSize: 11, marginTop: 14, textAlign: 'center' }} numberOfLines={2}>
          E2E-SwarmGram · ключи остаются на устройстве
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1 },
  center: { flexGrow: 1, alignSelf: 'center', width: '100%', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: 18, padding: 18 },
  cardCompact: { borderRadius: 16, padding: 14 },
  logoRing: { width: 58, height: 58, borderRadius: 999, alignItems: 'center', justifyContent: 'center', borderWidth: 1, marginBottom: 12, alignSelf: 'flex-start' },
  logoRingCompact: { width: 50, height: 50, marginBottom: 10 },
  logo: { width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  logoCompact: { width: 40, height: 40, borderRadius: 13 },
  blob: { position: 'absolute', borderRadius: 999 },
  blob1: { width: 320, height: 320, left: -60, top: -40 },
  blob2: { width: 280, height: 280, right: -50, top: 80 },
  blob3: { width: 240, height: 240, left: 60, bottom: -60 },
});
