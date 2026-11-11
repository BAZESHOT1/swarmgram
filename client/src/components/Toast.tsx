import React from 'react';
import { Animated, PanResponder, Platform, Pressable, Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore, type Toast } from '../state/useStore';
import { useTheme } from '../theme/useTheme';
import { useReducedMotion } from './useReducedMotion';

/** Длительности по умолчанию: ошибки читаются дольше. */
const DURATION_INFO = 1400;
const DURATION_ERROR = 2200;

/** Порог свайпа вверх для закрытия (px). */
const SWIPE_CLOSE_DY = -28;

/**
 * Отступ сверху от safe-area. Глобальный баннер модуля занимает
 * roughly 64–70px от insets.top + 8, поэтому тосты начинаются ниже него
 * и не перекрывают ни шапку, ни баннер подключения.
 */
const TOP_OFFSET = 84;

/** Одновременно на экране не больше четырёх тостов. */
const MAX_VISIBLE = 4;

interface KindMeta {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
}

function metaFor(kind: Toast['kind']): KindMeta {
  if (kind === 'success') return { icon: 'checkmark-circle', title: 'Готово' };
  if (kind === 'error') return { icon: 'alert-circle', title: 'Ошибка' };
  return { icon: 'information-circle', title: 'Уведомление' };
}

interface CardProps {
  toast: Toast;
  reduced: boolean;
}

/** Одна карточка уведомления: анимация входа, пауза таймера, свайп вверх. */
function ToastCard({ toast, reduced }: CardProps) {
  const theme = useTheme();
  const dismiss = useStore((s) => s.dismissToast);

  const isError = toast.kind === 'error';
  const isSuccess = toast.kind === 'success';
  const color = isError ? theme.danger : isSuccess ? theme.success : theme.accent;
  const soft = isError ? theme.dangerSoft : isSuccess ? theme.successSoft : theme.accentSoft;
  // Рамка как у глобального баннера: цвет статуса, у info — нейтральная.
  const borderColor = isError ? theme.danger : isSuccess ? theme.success : theme.glassBorder;
  const meta = metaFor(toast.kind);

  const [closing, setClosing] = React.useState(false);
  const closingRef = React.useRef(false);
  const dragY = React.useRef(new Animated.Value(0)).current;

  // ---- таймер с паузой (hover / удержание) ----
  const total = toast.durationMs !== undefined && toast.durationMs > 0
    ? toast.durationMs
    : toast.durationMs !== undefined
      ? 0 // durationMs <= 0 — не закрывать автоматически
      : isError
        ? DURATION_ERROR
        : DURATION_INFO;

  const remainingRef = React.useRef(total);
  const startedAtRef = React.useRef(0);
  const pausedRef = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const close = React.useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearTimer();
    if (reduced) {
      dismiss(toast.id);
      return;
    }
    setClosing(true);
    // Даём анимации досыграть уход, затем убираем из store.
    closeTimerRef.current = setTimeout(() => dismiss(toast.id), 170);
  }, [clearTimer, dismiss, reduced, toast.id]);

  const schedule = React.useCallback(() => {
    clearTimer();
    if (closingRef.current || total <= 0) return;
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      close();
    }, Math.max(0, remainingRef.current));
  }, [clearTimer, close, total]);

  const pause = React.useCallback(() => {
    if (pausedRef.current || closingRef.current || total <= 0) return;
    pausedRef.current = true;
    clearTimer();
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
  }, [clearTimer, total]);

  const resume = React.useCallback(() => {
    if (!pausedRef.current || closingRef.current) return;
    pausedRef.current = false;
    schedule();
  }, [schedule]);

  React.useEffect(() => {
    schedule();
    return () => {
      clearTimer();
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [schedule, clearTimer]);

  // ---- свайп вверх ----
  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => g.dy < -6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_e, g) => {
          dragY.setValue(Math.min(0, g.dy));
        },
        onPanResponderRelease: (_e, g) => {
          if (g.dy < SWIPE_CLOSE_DY) {
            close();
            return;
          }
          Animated.spring(dragY, { toValue: 0, useNativeDriver: true, damping: 20, stiffness: 260 }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(dragY, { toValue: 0, useNativeDriver: true, damping: 20, stiffness: 260 }).start();
        },
      }),
    [close, dragY],
  );

  // web: пауза при наведении. native: пауза, пока палец на карточке.
  const hoverProps = Platform.OS === 'web'
    ? ({ onMouseEnter: pause, onMouseLeave: resume } as any)
    : null;

  return (
    <Animated.View
      {...pan.panHandlers}
      {...(hoverProps ?? {})}
      onTouchStart={pause}
      onTouchEnd={resume}
      onTouchCancel={resume}
      style={[styles.cardWrap, { transform: [{ translateY: dragY }] }]}
    >
      <MotiView
        from={reduced ? { opacity: 0 } : { opacity: 0, translateY: -14, scale: 0.98 }}
        animate={
          closing
            ? reduced
              ? { opacity: 0 }
              : { opacity: 0, translateY: -10, scale: 0.98 }
            : { opacity: 1, translateY: 0, scale: 1 }
        }
        transition={
          reduced
            ? { type: 'timing', duration: 0 }
            : { type: 'timing', duration: 180 }
        }
        style={{ width: '100%' }}
      >
        <Pressable
          accessibilityLiveRegion="polite"
          accessibilityRole={isError ? 'alert' : 'text'}
          accessibilityLabel={`${meta.title}: ${toast.message}`}
          style={[
            styles.card,
            theme.shadow,
            { backgroundColor: theme.surfaceElevated, borderColor },
          ]}
        >
          <View style={styles.row}>
            <View style={[styles.iconWrap, { backgroundColor: soft }]}>
              <Ionicons name={meta.icon} size={21} color={color} />
            </View>

            <View style={styles.textCol}>
              <Text style={[styles.title, { color: theme.textPrimary }]} numberOfLines={1}>
                {meta.title}
              </Text>
              <Text style={[styles.message, { color: theme.textSecondary }]} numberOfLines={3}>
                {toast.message}
              </Text>
            </View>

            <Pressable
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Закрыть уведомление"
              hitSlop={8}
              style={({ pressed }) => [styles.close, { opacity: pressed ? 0.55 : 1 }]}
            >
              <Ionicons name="close" size={16} color={theme.textDisabled} />
            </Pressable>
          </View>

          {toast.action ? (
            <Pressable
              onPress={toast.action}
              accessibilityRole="button"
              accessibilityLabel={toast.actionLabel ?? 'Действие'}
              hitSlop={4}
              style={({ pressed }) => [
                styles.action,
                { backgroundColor: soft, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={[styles.actionText, { color }]} numberOfLines={1}>
                {toast.actionLabel ?? 'Повторить'}
              </Text>
            </Pressable>
          ) : null}
        </Pressable>
      </MotiView>
    </Animated.View>
  );
}

/**
 * Плавающие toast-уведомления в стиле глобального окна модуля:
 * карточка surfaceElevated, рамка статуса, иконка в мягком квадрате.
 * Сверху по центру (web — справа), ниже safe-area и баннера модуля.
 */
export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.host,
        { top: insets.top + TOP_OFFSET },
        Platform.OS === 'web' && styles.hostWeb,
      ]}
    >
      {toasts.slice(0, MAX_VISIBLE).map((t) => (
        <ToastCard key={t.id} toast={t} reduced={reduced} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    // Ниже баннера модуля (zIndex 300), чтобы не перекрывать его.
    zIndex: 290,
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  hostWeb: {
    right: 16,
    left: undefined,
    alignItems: 'flex-end',
    paddingHorizontal: 0,
  },
  cardWrap: {
    width: '100%',
    maxWidth: 400,
    marginBottom: 8,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 14,
    fontWeight: '800',
  },
  message: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 1,
  },
  close: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 2,
  },
  action: {
    alignSelf: 'flex-start',
    marginLeft: 48,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  actionText: {
    fontSize: 12,
    fontWeight: '700',
  },
});
