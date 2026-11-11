/**
 * Компактная кнопка «+» в шапке списка чатов.
 * Тап раскрывает стеклянное меню: личный чат, группа, канал.
 * Работает одинаково на ПК и смартфонах, не перекрывает контент снизу.
 */
import React from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { router } from 'expo-router';
import { useTheme } from '../theme/useTheme';
import { useHaptics } from './useHaptics';
import { useReducedMotion } from './useReducedMotion';
import { PressableScale } from './chat/PressableScale';
import { motion } from '../theme/motion';

const ACTIONS = [
  { key: 'direct', label: 'Личный чат', hint: 'Написать человеку', icon: 'chatbubbles-outline' as const, href: '/compose?mode=direct' },
  { key: 'group', label: 'Группа', hint: 'Несколько участников', icon: 'people-outline' as const, href: '/compose?mode=group' },
  { key: 'channel', label: 'Канал', hint: 'Публикации для подписчиков', icon: 'megaphone-outline' as const, href: '/compose?mode=channel' },
];

export function HeaderCreateMenu() {
  const theme = useTheme();
  const haptics = useHaptics();
  const reduced = useReducedMotion();
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <PressableScale
        pressedScale={0.92}
        onPress={() => {
          haptics.tap();
          setOpen((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Закрыть меню создания' : 'Создать чат, группу или канал'}
        style={({ pressed }) => [
          styles.fab,
          theme.shadow,
          { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <MotiView
          animate={{ rotate: open ? '135deg' : '0deg' }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
        >
          <Ionicons name="add" size={24} color={theme.onAccent} />
        </MotiView>
      </PressableScale>

      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Закрыть меню создания">
          <MotiView
            from={{ opacity: 0, translateY: reduced ? 0 : -10, scale: reduced ? 1 : 0.96 }}
            animate={{ opacity: 1, translateY: 0, scale: 1 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
            style={[
              styles.menu,
              {
                backgroundColor: theme.dark ? 'rgba(20,28,42,0.94)' : 'rgba(255,255,255,0.96)',
                borderColor: theme.glassBorder,
              },
              theme.shadow,
              Platform.OS === 'web' ? ({ backdropFilter: 'blur(18px) saturate(1.4)' } as object) : null,
            ]}
          >
            {ACTIONS.map((action, index) => (
              <MotiView
                key={action.key}
                from={{ opacity: 0, translateX: reduced ? 0 : 12 }}
                animate={{ opacity: 1, translateX: 0 }}
                transition={
                  reduced
                    ? { type: 'timing', duration: 0 }
                    : {
                        damping: motion.spring.damping,
                        stiffness: motion.spring.stiffness,
                        mass: motion.spring.mass,
                        delay: index * motion.staggerStepMs,
                      }
                }
              >
                <Pressable
                  onPress={() => {
                    haptics.tap();
                    setOpen(false);
                    router.push(action.href as never);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Создать: ${action.label}`}
                  style={({ pressed }) => [styles.item, { backgroundColor: pressed ? theme.surfacePressed : 'transparent' }]}
                >
                  <View style={[styles.iconWrap, { backgroundColor: theme.accentSoft }]}>
                    <Ionicons name={action.icon} size={18} color={theme.accent} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }}>{action.label}</Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }}>{action.hint}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={14} color={theme.textDisabled} />
                </Pressable>
              </MotiView>
            ))}
          </MotiView>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  fab: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.16)' },
  menu: {
    position: 'absolute',
    top: 64,
    right: 16,
    width: 268,
    borderRadius: 18,
    borderWidth: 1,
    padding: 6,
    gap: 2,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 9,
    borderRadius: 12,
  },
  iconWrap: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
