import React from 'react';
import { Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '../../theme/useTheme';

/**
 * Стеклянная поверхность: полупрозрачный фон, тонкая светлая рамка и
 * backdrop-blur на web. На нативных платформах остаётся лёгкая полупрозрачность.
 */
export function glassStyle(dark: boolean, radius = 20): any {
  return {
    backgroundColor: dark ? 'rgba(24,32,46,0.55)' : 'rgba(255,255,255,0.62)',
    borderColor: dark ? 'rgba(255,255,255,0.09)' : 'rgba(16,24,40,0.08)',
    borderWidth: 1,
    borderRadius: radius,
    ...(Platform.OS === 'web'
      ? {
          backdropFilter: 'blur(18px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.4)',
        }
      : {}),
  };
}

export function GlassCard({
  children,
  style,
  padding = 16,
  radius = 20,
  glow,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padding?: number;
  radius?: number;
  /** Акцентное свечение вокруг карточки (для hero/активных блоков). */
  glow?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        glassStyle(theme.dark, radius),
        { padding },
        glow && Platform.OS === 'web'
          ? ({ boxShadow: `0 12px 48px rgba(245,166,35,0.12)` } as any)
          : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Заголовок секции внутри стеклянных карточек. */
export function GlassSectionTitle({ title, right }: { title: string; right?: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.sectionHead}>
      <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase' }}>
        {title}
      </Text>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
});
