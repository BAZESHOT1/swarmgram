/**
 * Стеклянная поверхность Kinto.
 *
 * Единый слой «матового стекла» для поиска, кнопки создания чата и навбара:
 *  - iOS — нативный BlurView;
 *  - Android — BlurView с экспериментальным методом размытия;
 *  - Web — CSS backdrop-filter.
 *
 * Размытие всегда обрезается по радиусу контейнера (`overflow: 'hidden'`),
 * поэтому под скруглённой капсулой не появляется квадратная подложка.
 */
import React from 'react';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';
import { BlurView } from 'expo-blur';
import { useTheme } from '../theme/useTheme';

export const GLASS_BORDER = 'rgba(255, 255, 255, 0.10)';
/** Заливка кнопок шапки: 12% белого. */
export const GLASS_FILL_BUTTON = 'rgba(255, 255, 255, 0.12)';
/** Заливка навбара: 8% белого поверх размытия. */
export const GLASS_FILL_DOCK = 'rgba(255, 255, 255, 0.08)';
/** Фон закреплённых чатов: 7% белого. */
export const PINNED_SURFACE = 'rgba(255, 255, 255, 0.07)';

type GlassProps = ViewProps & {
  /** Заливка поверх размытия (процент белого). */
  fill?: string;
  /** Радиус скругления: по нему же обрезается размытие. */
  radius?: number;
  /** Цвет тонкой обводки. */
  borderColor?: string;
  /** Толщина обводки. */
  borderWidth?: number;
  /** Интенсивность размытия (1–100). */
  intensity?: number;
  /** Тон материала iOS. */
  tint?: 'light' | 'dark' | 'default';
};

export function Glass({
  children,
  style,
  fill = GLASS_FILL_DOCK,
  radius = 20,
  borderColor = GLASS_BORDER,
  borderWidth = 1,
  intensity = 48,
  tint,
  ...rest
}: GlassProps) {
  const web = Platform.OS === 'web';
  const theme = useTheme();
  const light = !theme.dark;
  // Светлая тема: светлое стекло (белая заливка, светлое размытие, тёмная тонкая обводка).
  // Белые полупрозрачные заливки тёмной темы переводим в их светлый аналог.
  const lightFill = (value: string) => {
    const m = /^rgba\(255,\s*255,\s*255,\s*([0-9.]+)\)$/.exec(value.replace(/\s+/g, ' ').trim());
    if (!m) return value;
    return `rgba(255,255,255,${Math.min(0.78, 0.5 + Number(m[1]) * 2)})`;
  };
  const effFill = light ? lightFill(fill) : fill;
  const effBorder = light && borderColor === GLASS_BORDER ? 'rgba(0,0,0,0.08)' : borderColor;
  const effTint = tint ?? (light ? 'light' : 'dark');

  return (
    <View
      {...rest}
      style={[
        styles.base,
        {
          borderRadius: radius,
          borderWidth,
          borderColor: effBorder,
          // На web лёгкая тёмная подложка нужна, чтобы стекло читалось на чёрном.
          backgroundColor: web ? (light ? 'rgba(255, 255, 255, 0.45)' : 'rgba(22, 22, 24, 0.34)') : 'transparent',
          ...(web
            ? ({
                backdropFilter: 'blur(20px) saturate(1.5)',
                WebkitBackdropFilter: 'blur(20px) saturate(1.5)',
              } as object)
            : null),
        },
        style,
      ]}
    >
      {!web ? (
        <BlurView
          intensity={intensity}
          tint={effTint}
          experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : null}
      {/* Заливка поверх стекла: задаёт точный процент белого. */}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: effFill }]} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // overflow: hidden — ключ к скруглённому стеклу без квадратных углов.
  base: { overflow: 'hidden' },
});
