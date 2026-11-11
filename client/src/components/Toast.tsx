import React from 'react';
import { Animated, PanResponder, Platform, Pressable, Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useStore, type Toast } from '../state/useStore';
import { useTheme } from '../theme/useTheme';
import { useReducedMotion } from './useReducedMotion';

/** Длительности по умолчанию: ошибки читаются дольше. */
const DURATION_INFO = 1400;
const DURATION_ERROR = 2200;

/** Порог свайпа вверх для закрытия (px). */
const SWIPE_CLOSE_DY = -28;

/** Стеклянный blur только на web (в RN-типах таких свойств нет). */
const WEB_GLASS = Platform.OS === 'web'
  ? ({
      backdropFilter: 'blur(18px) saturate(1.4)',
      WebkitBackdropFilter: 'blur(18px) saturate(1.4)',
    } as any)
  : null;

function iconFor(kind: Toast['kind']): React.ComponentProps<typeof Ionicons>['name'] {
  if (kind === 'error') return 'alert-circle';
  // Успех визуально — это инфо с зелёной галочкой, отдельного вида нет.
  if (kind === 'success') return 'checkmark-circle';
  return 'information-circle';
}

interface PillProps {
  toast: Toast;
  reduced: boolean;
}

/** Одна стеклянная пилюля: морфинг, пауза таймера, свайп вверх. */
function ToastPill({ toast, reduced }: PillProps) {
  const theme = useTheme();
  const dismiss = useStore((s) => s.dismissToast);

  const isError = toast.kind === 'error';
  const color = isError ? theme.danger : toast.kind === 'success' ? theme.success : theme.accent;
  const soft = isError ? theme.dangerSoft : toast.kind === 'success' ? theme.successSoft : theme.accentSoft;

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
    // Даём морфингу досыграть уход, затем убираем из store.
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

  // web: пауза при наведении. native: пауза, пока палец на пилюле.
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
      style={[styles.pillWrap, { transform: [{ translateY: dragY }] }]}
    >
      <MotiView
        from={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.88, translateY: -10 }}
        animate={
          closing
            ? reduced
              ? { opacity: 0 }
              : { opacity: 0, scale: 0.94, translateY: -8 }
            : { opacity: 1, scale: 1, translateY: 0 }
        }
        transition={
          reduced
            ? { type: 'timing', duration: 0 }
            : { type: 'spring', damping: 24, stiffness: 320 }
        }
        style={[{ width: '100%' }, theme.shadow]}
      >
        <Pressable
          accessibilityLiveRegion="polite"
          accessibilityRole={isError ? 'alert' : undefined}
          style={[
            styles.pill,
            { backgroundColor: theme.glass, borderColor: theme.glassBorder },
            WEB_GLASS,
          ]}
        >
          {/* Тонкий стеклянный блик по верхней кромке. */}
          <View
            pointerEvents="none"
            style={[
              styles.highlight,
              { backgroundColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.65)' },
            ]}
          />

          <View style={[styles.iconWrap, { backgroundColor: soft }]}>
            <Ionicons name={iconFor(toast.kind)} size={15} color={color} />
          </View>

          <Text style={[styles.message, { color: theme.textPrimary }]} numberOfLines={2}>
            {toast.message}
          </Text>

          {toast.action ? (
            <Pressable
              onPress={toast.action}
              accessibilityRole="button"
              accessibilityLabel={toast.actionLabel ?? 'Действие'}
              hitSlop={6}
              style={({ pressed }) => [styles.action, { opacity: pressed ? 0.65 : 1 }]}
            >
              <Text style={[styles.actionText, { color }]} numberOfLines={1}>
                {toast.actionLabel ?? 'Повторить'}
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Закрыть"
            hitSlop={8}
            style={({ pressed }) => [styles.close, { opacity: pressed ? 0.55 : 1 }]}
          >
            <Ionicons name="close" size={14} color={theme.textDisabled} />
          </Pressable>
        </Pressable>
      </MotiView>
    </Animated.View>
  );
}

/**
 * Плавающие toast-уведомления: стеклянная пилюля.
 * Web — сверху справа, mobile — сверху по центру. Новые сверху, максимум 2.
 */
export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  const reduced = useReducedMotion();

  return (
    <View pointerEvents="box-none" style={[styles.host, Platform.OS === 'web' && styles.hostWeb]}>
      {toasts.map((t) => (
        <ToastPill key={t.id} toast={t} reduced={reduced} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    top: 14,
    left: 0,
    right: 0,
    zIndex: 999,
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  hostWeb: {
    top: 16,
    right: 16,
    left: undefined,
    alignItems: 'flex-end',
    paddingHorizontal: 0,
  },
  pillWrap: {
    width: '100%',
    maxWidth: 380,
    marginBottom: 8,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 9,
    paddingHorizontal: 13,
    overflow: 'hidden',
  },
  highlight: {
    position: 'absolute',
    top: 0,
    left: 14,
    right: 14,
    height: 1,
    borderTopLeftRadius: 999,
    borderTopRightRadius: 999,
  },
  iconWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  message: {
    flexShrink: 1,
    flexGrow: 1,
    fontSize: 13,
    lineHeight: 17,
  },
  action: {
    marginLeft: 2,
  },
  actionText: {
    fontSize: 12.5,
    fontWeight: '600',
  },
  close: {
    marginLeft: 1,
    padding: 1,
  },
});
