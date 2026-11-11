/**
 * Вспомогательные стеклянные элементы для подстраниц настроек:
 * плитки сводки, прогресс, бейджи статусов, модальные окна и форматирование.
 * Стиль общий: тёмное стекло, оранжевый акцент, мягкие границы theme.glassBorder.
 */
import React from 'react';
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { GlassCard } from './SettingsUI';

export type BadgeTone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

const tonePalette = (theme: ReturnType<typeof useTheme>, tone: BadgeTone) => {
  switch (tone) {
    case 'accent':
      return { bg: theme.accentSoft, fg: theme.accent };
    case 'success':
      return { bg: theme.successSoft, fg: theme.success };
    case 'warning':
      return { bg: theme.warningSoft, fg: theme.warning };
    case 'danger':
      return { bg: theme.dangerSoft, fg: theme.danger };
    default:
      return { bg: theme.surfacePressed, fg: theme.textSecondary };
  }
};

/** Компактный бейдж статуса: online/degraded/offline, роли, блокировки. */
export function StatusBadge({ text, tone = 'neutral' }: { text: string; tone?: BadgeTone }) {
  const theme = useTheme();
  const palette = tonePalette(theme, tone);
  return (
    <View style={[styles.badge, { backgroundColor: palette.bg, borderColor: palette.fg }]}>
      <Text style={{ color: palette.fg, fontSize: 10.5, fontWeight: '700' }}>{text}</Text>
    </View>
  );
}

/** Сетка плиток сводки: на узком экране плитки переносятся на новую строку. */
export function SummaryGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.summaryGrid}>{children}</View>;
}

/** Плитка сводки: значение + подпись + пояснение. */
export function SummaryTile({
  icon,
  label,
  value,
  sub,
  tone = 'accent',
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  sub?: string;
  tone?: BadgeTone;
}) {
  const theme = useTheme();
  const palette = tonePalette(theme, tone);
  return (
    <GlassCard style={styles.summaryCard}>
      <View style={{ padding: 9, gap: 5 }}>
        <View style={[styles.summaryIcon, { backgroundColor: palette.bg }]}>
          <Ionicons name={icon} size={15} color={palette.fg} />
        </View>
        <Text
          style={{ color: theme.textPrimary, fontSize: 17, fontWeight: '800', fontVariant: ['tabular-nums'] as never }}
          numberOfLines={1}
        >
          {value}
        </Text>
        <Text style={{ color: theme.textSecondary, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.4 }} numberOfLines={1}>
          {label.toUpperCase()}
        </Text>
        {sub ? (
          <Text style={{ color: theme.textDisabled, fontSize: 10.5 }} numberOfLines={2}>
            {sub}
          </Text>
        ) : null}
      </View>
    </GlassCard>
  );
}

/** Тонкий прогресс заполнения (ёмкость узла, заряд модуля). */
export function ProgressBar({
  pct,
  tone = 'accent',
  height = 5,
}: {
  pct: number;
  tone?: BadgeTone;
  height?: number;
}) {
  const theme = useTheme();
  const palette = tonePalette(theme, tone);
  const reduced = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const progress = React.useRef(new Animated.Value(reduced ? 1 : 0)).current;

  React.useEffect(() => {
    if (reduced) {
      progress.setValue(1);
      return undefined;
    }
    progress.setValue(0);
    const animation = Animated.spring(progress, {
      toValue: 1,
      damping: motion.softSpring.damping,
      stiffness: motion.softSpring.stiffness,
      mass: motion.softSpring.mass,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [clamped, progress, reduced]);

  return (
    <View style={[styles.track, { backgroundColor: theme.surfacePressed, height }]}>
      <Animated.View
        style={{
          width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', `${clamped}%`] }),
          height: '100%',
          borderRadius: 999,
          backgroundColor: palette.fg,
        }}
      />
    </View>
  );
}

/** Разделитель между строками внутри стеклянной карточки. */
export function SettingsDivider() {
  const theme = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.line, marginHorizontal: 10 }} />;
}

/** Круглая кнопка-иконка в шапке страницы (обновить, добавить). */
export function HeaderIconButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [
        styles.headerBtn,
        { backgroundColor: theme.glass, borderColor: theme.glassBorder, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      <Ionicons name={icon} size={18} color={theme.accent} />
    </Pressable>
  );
}

/** Поле ввода в стиле настроек: подпись, фокусная рамка, плейсхолдер из темы. */
export function SettingsInput({ label, style, onFocus, onBlur, ...props }: TextInputProps & { label?: string }) {
  const theme = useTheme();
  const [focused, setFocused] = React.useState(false);
  return (
    <View style={{ marginBottom: 10 }}>
      {label ? (
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 6, paddingHorizontal: 2 }}>
          {label}
        </Text>
      ) : null}
      <TextInput
        {...props}
        placeholderTextColor={props.placeholderTextColor ?? theme.textDisabled}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        style={[
          styles.input,
          {
            backgroundColor: theme.dark ? 'rgba(0,0,0,0.18)' : theme.surface,
            borderColor: focused ? theme.accent : theme.line,
            color: theme.textPrimary,
          },
          style,
        ]}
      />
    </View>
  );
}

/** Каркас модального окна: затемнение, стеклянная карточка, заголовок и крестик. */
export function SettingsModal({
  visible,
  title,
  subtitle,
  onClose,
  children,
  maxWidth = 440,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: number;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.modalRoot, { backgroundColor: theme.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть" />
        <MotiView
          from={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, translateY: 12 }}
          animate={{ opacity: 1, scale: 1, translateY: 0 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
          style={[
            styles.modalCard,
            theme.shadow,
            {
              maxWidth,
              backgroundColor: theme.glassStrong,
              borderColor: theme.glassBorder,
              ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(18px) saturate(1.3)' } as object) : null),
            },
          ]}
        >
          <View style={styles.modalHead}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.textPrimary, fontSize: 17, fontWeight: '800' }}>{title}</Text>
              {subtitle ? (
                <Text style={{ color: theme.textSecondary, fontSize: 12.5, marginTop: 3, lineHeight: 18 }}>{subtitle}</Text>
              ) : null}
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
              hitSlop={8}
              style={({ pressed }) => [styles.modalClose, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Ionicons name="close" size={20} color={theme.textSecondary} />
            </Pressable>
          </View>
          {children}
        </MotiView>
      </View>
    </Modal>
  );
}

/** Подтверждение действия в стеклянной модалке (вместо Alert — работает и на web). */
export function SettingsConfirm({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Отмена',
  loading,
  danger = true,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  loading?: boolean;
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const theme = useTheme();
  const accent = danger ? theme.danger : theme.accent;
  return (
    <SettingsModal visible={visible} title={title} onClose={onClose} maxWidth={400}>
      <Text style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 20 }}>{message}</Text>
      <View style={styles.modalButtons}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={cancelLabel}
          style={({ pressed }) => [styles.modalBtn, { borderColor: theme.line, opacity: pressed ? 0.75 : 1 }]}
        >
          <Text style={{ color: theme.textSecondary, fontWeight: '600', fontSize: 14 }}>{cancelLabel}</Text>
        </Pressable>
        <Pressable
          onPress={onConfirm}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel={confirmLabel}
          style={({ pressed }) => [
            styles.modalBtn,
            { backgroundColor: accent, borderColor: accent, opacity: loading ? 0.5 : pressed ? 0.82 : 1 },
          ]}
        >
          <Text style={{ color: theme.onAccent, fontWeight: '700', fontSize: 14 }}>
            {loading ? 'Подождите…' : confirmLabel}
          </Text>
        </Pressable>
      </View>
    </SettingsModal>
  );
}

/* ----------------------------------------------------------- форматирование -- */

/** Байты в человекочитаемый вид: 0 Б, 24 МБ, 10 ГБ, 1.2 ТБ. */
export function formatBytes(bytes: number | null | undefined): string {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  const digits = index === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[index]}`;
}

/** Дата и время в локали ru-RU; пустое/некорректное значение → «—». */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Относительное «5 мин назад» для последней активности; старше недели — дата. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return formatDateTime(iso);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} дн назад`;
  return formatDateTime(iso);
}

/** Тон бейджа по статусу узла/модуля. */
export function toneForStatus(status: string | null | undefined): BadgeTone {
  switch (status) {
    case 'online':
      return 'success';
    case 'degraded':
    case 'draining':
    case 'pending':
      return 'warning';
    case 'banned':
    case 'blocked':
      return 'danger';
    case 'offline':
      return 'neutral';
    default:
      return 'neutral';
  }
}

const styles = StyleSheet.create({
  badge: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
  summaryCard: { flexGrow: 1, flexBasis: 96, minWidth: 96 },
  summaryIcon: { width: 26, height: 26, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  track: { borderRadius: 999, overflow: 'hidden', width: '100%' },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 14.5,
    minHeight: 42,
  },
  modalRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', padding: 18, borderRadius: 20, borderWidth: 1 },
  modalHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 14 },
  modalClose: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  modalButtons: { flexDirection: 'row', gap: 10, marginTop: 18 },
  modalBtn: {
    flex: 1,
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
});
