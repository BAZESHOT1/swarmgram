import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { router, usePathname } from 'expo-router';
import { useTheme } from '../theme/useTheme';
import { useHaptics } from './useHaptics';
import { useReducedMotion } from './useReducedMotion';

const ACTIONS = [
  { key: 'direct', label: 'Чат', icon: 'chatbubbles-outline' as const, href: '/compose?mode=direct' },
  { key: 'group', label: 'Группа', icon: 'people-outline' as const, href: '/compose?mode=group' },
  { key: 'channel', label: 'Канал', icon: 'megaphone-outline' as const, href: '/compose?mode=channel' },
];

/** «+» раскрывает радиальное меню: чат, группа, канал. */
export function RadialFab() {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const haptics = useHaptics();
  const pathname = usePathname();
  const reduced = useReducedMotion();

  if (!pathname.startsWith('/chats')) return null;

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      <AnimatePresenceSafe open={open} reduced={reduced}>
        {open
          ? ACTIONS.map((a, i) => (
              <MotiView
                key={a.key}
                from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 12, translateX: 8, scale: 0.6 }}
                animate={reduced ? { opacity: 1 } : { opacity: 1, translateY: -8 - i * 58, translateX: 0, scale: 1 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.6 }}
                transition={{ type: 'spring', damping: 20, stiffness: 280 }}
                style={styles.action}
              >
                <Pressable
                  onPress={() => {
                    haptics.tap();
                    setOpen(false);
                    router.push(a.href as never);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Создать: ${a.label}`}
                  style={({ pressed }) => [styles.actionBtn, { backgroundColor: theme.surfaceElevated, borderColor: theme.line, opacity: pressed ? 0.8 : 1 }]}
                >
                  <Ionicons name={a.icon} size={19} color={theme.accent} />
                  <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }}>{a.label}</Text>
                </Pressable>
              </MotiView>
            ))
          : null}
      </AnimatePresenceSafe>

      <Pressable
        onPress={() => {
          haptics.tap();
          setOpen((v) => !v);
        }}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Закрыть меню создания' : 'Создать чат, группу или канал'}
        style={({ pressed }) => [styles.main, theme.shadow, { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 }]}
      >
        <MotiView
          animate={{ rotate: open ? '135deg' : '0deg' }}
          transition={{ type: 'timing', duration: reduced ? 0 : 200 }}
          style={{ alignItems: 'center', justifyContent: 'center', width: 56, height: 56 }}
        >
          <Ionicons name="add" size={28} color={theme.onAccent} />
        </MotiView>
      </Pressable>
    </View>
  );
}

/** Простой AnimatePresence-лок по ключу (moti AnimatePresence требует aynı parent). */
function AnimatePresenceSafe({ open, children, reduced }: { open: boolean; children: React.ReactNode; reduced: boolean }) {
  void reduced;
  return <View style={styles.actionsLayer}>{children}</View>;
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 18,
    bottom: 96,
    zIndex: 50,
    alignItems: 'flex-end',
  },
  actionsLayer: { alignItems: 'center', marginBottom: 10 },
  action: { marginBottom: 8, alignItems: 'center' },
  actionBtn: {
    width: 62,
    height: 62,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  main: { width: 56, height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
});
