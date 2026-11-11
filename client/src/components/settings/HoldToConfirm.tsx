/**
 * Кнопка с подтверждением удержанием (1 секунда).
 * Прогресс заполняет фон; отпускание раньше времени сбрасывает действие.
 * reduced motion не ломается: анимация здесь функциональная и линейная.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';

const HOLD_MS = 1000;
const TICK_MS = 40;

export function HoldToConfirm({
  title,
  subtitle,
  onConfirmed,
  disabled,
  icon = 'log-out-outline',
}: {
  title: string;
  subtitle?: string;
  onConfirmed: () => void;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const theme = useTheme();
  const [progress, setProgress] = React.useState(0);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const fired = React.useRef(false);

  const clear = React.useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  React.useEffect(() => clear, [clear]);

  function stop(reset: boolean) {
    clear();
    if (reset) setProgress(0);
  }

  function start() {
    if (disabled || timer.current) return;
    fired.current = false;
    const startedAt = Date.now();
    setProgress(0);
    timer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - startedAt) / HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        stop(false);
        setProgress(1);
        if (!fired.current) {
          fired.current = true;
          onConfirmed();
        }
      }
    }, TICK_MS);
  }

  return (
    <Pressable
      onPressIn={start}
      onPressOut={() => stop(progress < 1)}
      onResponderTerminate={() => stop(progress < 1)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${title}. Удерживайте одну секунду для подтверждения`}
      style={({ pressed }) => [
        styles.btn,
        {
          borderColor: theme.danger,
          backgroundColor: theme.dangerSoft,
          opacity: disabled ? 0.5 : pressed ? 0.92 : 1,
        },
      ]}
    >
      {/* Заливка прогресса удержания */}
      <View
        pointerEvents="none"
        style={[styles.fill, { width: `${Math.round(progress * 100)}%`, backgroundColor: theme.danger }]}
      />
      <View style={styles.content}>
        <Ionicons name={icon} size={18} color={theme.danger} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.danger, fontSize: 14.5, fontWeight: '700' }}>{title}</Text>
          <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }}>
            {progress > 0 && progress < 1 ? 'Отпустите, чтобы отменить…' : subtitle ?? 'Удерживайте 1 секунду'}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    borderWidth: 1,
    borderRadius: 14,
    overflow: 'hidden',
    minHeight: 52,
    justifyContent: 'center',
  },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, opacity: 0.22 },
  content: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 },
});
