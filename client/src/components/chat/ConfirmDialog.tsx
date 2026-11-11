/**
 * Стеклянное подтверждение опасного действия (удаление чатов).
 * Не блокирует интерфейс дольше, чем нужно; закрывается по фону и Esc на web.
 */
import React from 'react';
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import { motion } from '../../theme/motion';

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Удалить',
  busy = false,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel}>
      <Pressable style={[styles.backdrop, { backgroundColor: theme.overlay }]} onPress={busy ? undefined : onCancel}>
        <MotiView
          from={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.95, translateY: 10 }}
          animate={{ opacity: 1, scale: 1, translateY: 0 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
          style={[
            styles.card,
            theme.shadow,
            {
              backgroundColor: theme.dark ? 'rgba(20,28,42,0.96)' : 'rgba(255,255,255,0.98)',
              borderColor: theme.glassBorder,
            },
            Platform.OS === 'web' ? ({ backdropFilter: 'blur(18px)' } as object) : null,
          ]}
        >
          <View style={[styles.icon, { backgroundColor: theme.dangerSoft }]}>
            <Ionicons name="trash-outline" size={22} color={theme.danger} />
          </View>
          <Text style={{ color: theme.textPrimary, fontWeight: '800', fontSize: 16, textAlign: 'center' }}>{title}</Text>
          <Text style={{ color: theme.textSecondary, fontSize: 13.5, lineHeight: 19, textAlign: 'center' }}>{message}</Text>
          <View style={styles.row}>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Отмена"
              style={({ pressed }) => [
                styles.btn,
                { backgroundColor: pressed ? theme.surfacePressed : theme.surface, borderColor: theme.line, opacity: busy ? 0.5 : 1 },
              ]}
            >
              <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: 14 }}>Отмена</Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              style={({ pressed }) => [
                styles.btn,
                { backgroundColor: theme.danger, borderColor: theme.danger, opacity: busy ? 0.7 : pressed ? 0.85 : 1 },
              ]}
            >
              {busy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>{confirmLabel}</Text>
              )}
            </Pressable>
          </View>
        </MotiView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 380, borderRadius: 20, borderWidth: 1, padding: 20, gap: 10, alignItems: 'center' },
  icon: { width: 48, height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', gap: 10, alignSelf: 'stretch', marginTop: 4 },
  btn: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
