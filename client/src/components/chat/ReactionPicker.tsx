/**
 * Быстрое меню реакций по долгому нажатию на сообщение.
 * Показывает только эмодзи-панель; «⋯» открывает полное меню действий.
 * На web подавляет выделение текста и контекстное меню браузера.
 */
import React from 'react';
import { Modal, Pressable, Text, View, StyleSheet, Platform } from 'react-native';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import { PressableScale } from './PressableScale';
import { motion } from '../../theme/motion';

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const;

export function ReactionPicker({
  visible,
  onClose,
  onPick,
  onMore,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
  onMore: () => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Закрыть меню реакций">
        <View pointerEvents="box-none" style={styles.center}>
          <MotiView
            from={{ opacity: 0, scale: reduced ? 1 : 0.82, translateY: reduced ? 0 : 12 }}
            animate={{ opacity: 1, scale: 1, translateY: 0 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
            style={[
              styles.card,
              {
                backgroundColor: theme.dark ? 'rgba(20,28,42,0.92)' : 'rgba(255,255,255,0.94)',
                borderColor: theme.glassBorder,
              },
              Platform.OS === 'web' ? ({ backdropFilter: 'blur(18px) saturate(1.4)' } as object) : null,
            ]}
          >
            {QUICK_REACTIONS.map((emoji, index) => (
              <MotiView
                key={emoji}
                from={{ opacity: 0, scale: reduced ? 1 : 0.7, translateY: reduced ? 0 : 6 }}
                animate={{ opacity: 1, scale: 1, translateY: 0 }}
                transition={
                  reduced
                    ? { type: 'timing', duration: 0 }
                    : { ...motion.spring, delay: index * motion.staggerStepMs }
                }
              >
                <PressableScale
                  pressedScale={0.86}
                  onPress={() => onPick(emoji)}
                  accessibilityRole="button"
                  accessibilityLabel={`Реакция ${emoji}`}
                  style={({ pressed }) => [styles.emojiBtn, { backgroundColor: pressed ? theme.accentSoft : 'transparent' }]}
                >
                  <Text style={styles.emoji}>{emoji}</Text>
                </PressableScale>
              </MotiView>
            ))}
            <PressableScale
              pressedScale={0.9}
              onPress={onMore}
              accessibilityRole="button"
              accessibilityLabel="Ещё действия с сообщением"
              style={({ pressed }) => [styles.moreBtn, { backgroundColor: pressed ? theme.surfacePressed : theme.surface }]}
            >
              <Text style={{ color: theme.textSecondary, fontSize: 20, fontWeight: '700' }}>⋯</Text>
            </PressableScale>
          </MotiView>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.18)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  emojiBtn: { width: 46, height: 46, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  emoji: { fontSize: 26 },
  moreBtn: { width: 40, height: 40, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginLeft: 2 },
});
