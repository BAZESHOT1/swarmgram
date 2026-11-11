import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import { PressableScale } from './PressableScale';
import { motion } from '../../theme/motion';

/** Плашка над композером: режим ответа или редактирования сообщения. */
export function ReplyBar({
  mode,
  username,
  text,
  onClose,
}: {
  mode: 'reply' | 'edit';
  username?: string;
  text: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  return (
    <MotiView
      from={{ opacity: 0, translateY: 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
      style={[styles.wrap, { backgroundColor: theme.surfaceElevated, borderColor: theme.line }]}
    >
      <View style={{ width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: mode === 'edit' ? theme.accent : theme.success }} />
      <Ionicons
        name={mode === 'edit' ? 'create-outline' : 'arrow-undo-outline'}
        size={16}
        color={mode === 'edit' ? theme.accent : theme.success}
      />
      <View style={{ flex: 1 }}>
        <Text style={{ color: mode === 'edit' ? theme.accent : theme.success, fontSize: 12.5, fontWeight: '700' }} numberOfLines={1}>
          {mode === 'edit' ? 'Редактирование' : `Ответ ${username ?? ''}`}
        </Text>
        <Text style={{ color: theme.textSecondary, fontSize: 12.5 }} numberOfLines={1}>
          {text || 'Вложение'}
        </Text>
      </View>
      <PressableScale onPress={onClose} pressedScale={0.85} accessibilityRole="button" accessibilityLabel="Отменить" hitSlop={8} style={styles.close}>
        <Ionicons name="close" size={18} color={theme.textSecondary} />
      </PressableScale>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 10,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  close: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
});
