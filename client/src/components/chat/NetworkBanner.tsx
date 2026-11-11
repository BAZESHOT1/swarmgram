import React from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';

/**
 * Баннер «нет сети» над композером: плавное появление/исчезновение,
 * анимированные волны из точек и счётчик попыток переподключения.
 * При reduced motion анимации отключаются, текст остаётся.
 */
export function NetworkBanner({ visible, attempts }: { visible: boolean; attempts: number }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const [mounted, setMounted] = React.useState(visible);
  const dots = React.useRef([0, 1, 2].map(() => new Animated.Value(0))).current;

  React.useEffect(() => {
    if (visible) {
      setMounted(true);
      return undefined;
    }
    const t = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(t);
  }, [visible]);

  React.useEffect(() => {
    if (!visible || reduced) {
      dots.forEach((v) => v.setValue(0));
      return undefined;
    }
    const loops = dots.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 140),
          Animated.timing(value, { toValue: 1, duration: 420, useNativeDriver: true }),
          Animated.timing(value, { toValue: 0, duration: 420, useNativeDriver: true }),
          Animated.delay((2 - index) * 140),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [visible, reduced, dots]);

  if (!mounted) return null;

  return (
    <MotiView
      from={reduced ? { opacity: 1 } : { opacity: 0, translateY: -8, scale: 0.97 }}
      animate={{ opacity: visible ? 1 : 0, translateY: visible ? 0 : -4, scale: visible ? 1 : 0.98 }}
      transition={{ type: 'timing', duration: 220 }}
      style={[styles.banner, { backgroundColor: theme.warningSoft, borderColor: theme.warning }]}
      accessibilityLiveRegion="polite"
    >
      <Ionicons name="cloud-offline-outline" size={16} color={theme.warning} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[styles.title, { color: theme.warning }]} numberOfLines={1}>
          Нет сети — ждём подключения
        </Text>
        <Text style={[styles.sub, { color: theme.textSecondary }]} numberOfLines={1}>
          {attempts > 0 ? `Попыток переподключения: ${attempts}` : 'Проверяем каналы связи…'}
        </Text>
      </View>
      <View style={styles.dots}>
        {dots.map((value, index) => (
          <Animated.View
            key={index}
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: theme.warning,
              opacity: visible
                ? value.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] })
                : 0.25,
              transform: [
                {
                  translateY: reduced
                    ? 0
                    : value.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }),
                },
              ],
            }}
          />
        ))}
      </View>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: { fontSize: 12.5, fontWeight: '700' },
  sub: { fontSize: 11, marginTop: 1 },
  dots: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, paddingBottom: 4 },
});
