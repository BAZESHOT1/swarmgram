import React from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { glassStyle } from './Glass';

/** Каркас модального окна профиля: затемнение, стеклянная карточка, крестик. */
export function ProfileModal({
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
      <View style={[styles.root, { backgroundColor: theme.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть" />
        <MotiView
          from={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, translateY: 12 }}
          animate={{ opacity: 1, scale: 1, translateY: 0 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
          style={[glassStyle(theme.dark, 20), styles.card, { maxWidth, ...theme.shadow }]}
        >
          <View style={styles.head}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.textPrimary, fontSize: 17, fontWeight: '700' }}>{title}</Text>
              {subtitle ? <Text style={{ color: theme.textSecondary, fontSize: 12.5, marginTop: 3 }}>{subtitle}</Text> : null}
            </View>
            <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть" hitSlop={8} style={styles.close}>
              <Ionicons name="close" size={20} color={theme.textSecondary} />
            </Pressable>
          </View>
          {children}
        </MotiView>
      </View>
    </Modal>
  );
}

/** Горизонтальная пара кнопок «Отмена / Действие». */
export function ModalButtons({
  onCancel,
  onConfirm,
  confirmLabel,
  cancelLabel = 'Отмена',
  danger,
  loading,
  disabled,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const accent = danger ? theme.danger : theme.accent;
  return (
    <View style={styles.buttons}>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel={cancelLabel}
        style={({ pressed }) => [styles.btn, { borderColor: theme.line, opacity: pressed ? 0.75 : 1 }]}
      >
        <Text style={{ color: theme.textSecondary, fontWeight: '600', fontSize: 14 }}>{cancelLabel}</Text>
      </Pressable>
      <Pressable
        onPress={onConfirm}
        disabled={loading || disabled}
        accessibilityRole="button"
        accessibilityLabel={confirmLabel}
        style={({ pressed }) => [
          styles.btn,
          { backgroundColor: accent, borderColor: accent, opacity: loading || disabled ? 0.5 : pressed ? 0.82 : 1 },
        ]}
      >
        <Text style={{ color: theme.onAccent, fontWeight: '700', fontSize: 14 }}>
          {loading ? 'Подождите…' : confirmLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', padding: 18, borderRadius: 20 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 14 },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 18 },
  btn: {
    flex: 1,
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
});
