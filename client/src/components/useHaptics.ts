/**
 * Тактильная отдача.
 *  - web: navigator.vibrate (Android Chrome); iOS Safari API нет — тихий no-op;
 *  - native: expo-haptics (iOS/Android).
 * Настройка `sg:haptics` в localStorage ('0' — выключено) читается при каждом
 * вызове, поэтому переключение в настройках действует сразу, без переподписки.
 */
import * as ExpoHaptics from 'expo-haptics';
import { Platform } from 'react-native';

const STORAGE_KEY = 'sg:haptics';

/** Минимальный интервал между лёгкими tap(), чтобы не было двойной вибрации. */
const TAP_THROTTLE_MS = 60;

/** Глобальная метка последнего tap() — общая для всех хуков и компонентов. */
let lastTapAt = 0;

function webEnabled(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/** vibrate есть только в Android Chrome; на iOS вызов тихо пропускается. */
function vibrate(pattern: number | number[]): void {
  if (Platform.OS !== 'web' || !webEnabled()) return;
  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & { vibrate?: (value: number | number[]) => boolean };
  if (typeof nav.vibrate !== 'function') return;
  try {
    nav.vibrate(pattern);
  } catch {
    /* вибрация не критична */
  }
}

/** Короткий лёгкий отклик на нативные платформы. */
function nativeLight(): void {
  if (Platform.OS === 'ios') void ExpoHaptics.selectionAsync().catch(() => undefined);
  if (Platform.OS === 'android') {
    void ExpoHaptics.impactAsync(ExpoHaptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }
}

export function useHaptics() {
  return {
    /** Лёгкий отклик на тап/навигацию; антидубликат 60 мс. */
    tap: () => {
      const now = Date.now();
      if (now - lastTapAt < TAP_THROTTLE_MS) return;
      lastTapAt = now;
      if (Platform.OS === 'web') {
        vibrate(10);
        return;
      }
      nativeLight();
    },
    /** Короткий отклик на отправку сообщения (12 мс на web). */
    send: () => {
      if (Platform.OS === 'web') {
        vibrate(12);
        return;
      }
      nativeLight();
    },
    /** Входящее сообщение: двойной короткий паттерн. */
    receive: () => {
      if (Platform.OS === 'web') {
        vibrate([18, 30, 18]);
        return;
      }
      if (Platform.OS === 'ios' || Platform.OS === 'android') {
        void ExpoHaptics.impactAsync(ExpoHaptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      }
    },
    /** Заметный отклик на важное действие (успех). */
    success: () => {
      if (Platform.OS === 'web') {
        vibrate(20);
        return;
      }
      if (Platform.OS === 'ios' || Platform.OS === 'android') {
        void ExpoHaptics.notificationAsync(ExpoHaptics.NotificationFeedbackType.Success).catch(() => undefined);
      }
    },
    /** Отклик на ошибку. */
    error: () => {
      if (Platform.OS === 'web') {
        vibrate([20, 40, 20]);
        return;
      }
      if (Platform.OS === 'ios' || Platform.OS === 'android') {
        void ExpoHaptics.notificationAsync(ExpoHaptics.NotificationFeedbackType.Error).catch(() => undefined);
      }
    },
  };
}
