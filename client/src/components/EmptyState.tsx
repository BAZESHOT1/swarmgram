/**
 * Пустое состояние: центрированная стеклянная карточка с иконкой,
 * заголовком, подписью и CTA. Анимация упрощается при reduced motion.
 */
import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../theme/useTheme';
import { useReducedMotion } from './useReducedMotion';
import { Btn } from './Btn';

export function EmptyState({
  title,
  subtitle,
  actionLabel,
  onAction,
  icon = 'sparkles-outline',
}: {
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  return (
    <View style={styles.wrap} accessibilityLabel={title} accessibilityRole="text">
      <MotiView
        from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 14, scale: 0.97 }}
        animate={{ opacity: 1, translateY: 0, scale: 1 }}
        transition={{ type: 'timing', duration: reduced ? 0 : 220 }}
        style={[
          styles.card,
          theme.shadow,
          {
            backgroundColor: theme.glass,
            borderColor: theme.glassBorder,
            ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(16px) saturate(1.2)' } as object) : null),
          },
        ]}
      >
        <View style={[styles.iconCircle, { backgroundColor: theme.accentSoft }]}>
          <Ionicons name={icon} size={26} color={theme.accent} />
        </View>
        <Text style={[styles.title, { color: theme.textPrimary }]}>{title}</Text>
        {subtitle ? <Text style={[styles.sub, { color: theme.textSecondary }]}>{subtitle}</Text> : null}
        {actionLabel ? (
          <View style={styles.action}>
            <Btn title={actionLabel} size="s" onPress={onAction} />
          </View>
        ) : null}
      </MotiView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
    gap: 10,
    paddingVertical: 28,
    paddingHorizontal: 24,
    borderRadius: 20,
    borderWidth: 1,
  },
  iconCircle: { width: 56, height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  title: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  sub: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  action: { marginTop: 6 },
});
