/**
 * Тонкий верхний прогресс-бар (2px) для сетевой активности.
 *
 * Подписан на глобальный счётчик запросов src/data/loading.ts:
 *  - при count > 0 плавно появляется (с задержкой 150 мс, чтобы не мигать);
 *  - пока запросы идут, медленно «дотягивается» вправо;
 *  - при завершении доходит до 100% и растворяется.
 * Полоса не перехватывает нажатия и уважает reduced motion.
 */
import React from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/useTheme';
import { useReducedMotion } from './useReducedMotion';
import { subscribeLoading } from '../data/loading';

export function LoadingBar({ forceVisible = false }: { forceVisible?: boolean }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const [count, setCount] = React.useState(0);
  const [visible, setVisible] = React.useState(false);
  const visibleRef = React.useRef(false);
  const progress = React.useRef(new Animated.Value(0)).current;
  const opacity = React.useRef(new Animated.Value(1)).current;
  const showTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  visibleRef.current = visible;

  // Счётчик активных запросов.
  React.useEffect(() => subscribeLoading((n) => setCount(n)), []);

  const clearTimers = React.useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    showTimer.current = null;
    hideTimer.current = null;
  }, []);

  React.useEffect(() => {
    const active = count > 0 || forceVisible;

    const finish = () => {
      if (reduced) {
        setVisible(false);
        progress.setValue(0);
        opacity.setValue(1);
        return;
      }
      Animated.timing(progress, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start(() => {
        Animated.timing(opacity, {
          toValue: 0,
          duration: 140,
          useNativeDriver: false,
        }).start(() => {
          setVisible(false);
          progress.setValue(0);
          opacity.setValue(1);
        });
      });
    };

    if (!active) {
      if (showTimer.current) {
        clearTimeout(showTimer.current);
        showTimer.current = null;
      }
      if (!visibleRef.current) return;
      finish();
      return;
    }

    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }

    if (visibleRef.current) return;

    // Небольшая задержка появления: короткие запросы не успевают мигнуть.
    showTimer.current = setTimeout(() => {
      showTimer.current = null;
      setVisible(true);
      opacity.setValue(1);
      progress.setValue(reduced ? 0.65 : 0.08);
      if (reduced) return;
      Animated.timing(progress, {
        toValue: 0.82,
        duration: 2600,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start();
    }, 150);

    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, forceVisible, reduced]);

  React.useEffect(() => () => clearTimers(), [clearTimers]);

  if (!visible) return null;

  const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  return (
    <View pointerEvents="none" style={styles.host} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View
        style={[
          styles.track,
          { opacity, backgroundColor: theme.accentSoft },
        ]}
      >
        <Animated.View
          style={[
            styles.fill,
            {
              width,
              backgroundColor: theme.accent,
              ...(Platform.OS === 'web'
                ? ({ backgroundImage: `linear-gradient(90deg, ${theme.accent}, #FFD27A)` } as object)
                : null),
            },
          ]}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    zIndex: 999,
    elevation: 999,
  },
  track: { flex: 1, overflow: 'hidden' },
  fill: { height: 2, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
});
