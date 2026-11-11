/**
 * Стеклянное контекстное меню чата (долгое нажатие / правый клик).
 * Показывает только реальные действия; анимация уважает reduced motion.
 */
import React from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import { motion } from '../../theme/motion';

interface MenuAction {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  destructive?: boolean;
  accent?: boolean;
}

export function ChatContextMenu({
  visible,
  title,
  pinned,
  muted,
  archived,
  unread,
  canMarkRead,
  onClose,
  onTogglePin,
  onToggleMute,
  onMarkRead,
  onArchive,
  onSelect,
  onDelete,
}: {
  visible: boolean;
  title: string;
  pinned: boolean;
  muted: boolean;
  archived: boolean;
  unread: number;
  canMarkRead: boolean;
  onClose: () => void;
  onTogglePin: () => void;
  onToggleMute: () => void;
  onMarkRead: () => void;
  onArchive: () => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  const actions: MenuAction[] = [
    {
      key: 'pin',
      label: archived ? 'Закрепить' : pinned ? 'Открепить' : 'Закрепить',
      icon: pinned ? 'pin-outline' : 'pin',
      onPress: onTogglePin,
    },
    {
      key: 'mute',
      label: muted ? 'Со звуком' : 'Без звука',
      icon: muted ? 'volume-high-outline' : 'notifications-off-outline',
      onPress: onToggleMute,
    },
    ...(canMarkRead
      ? [
          {
            key: 'read',
            label: 'Отметить прочитанным',
            icon: 'checkmark-done-outline' as const,
            onPress: onMarkRead,
          },
        ]
      : []),
    {
      key: 'archive',
      label: archived ? 'Вернуть из архива' : 'Архивировать',
      icon: archived ? 'archive-outline' : 'archive',
      onPress: onArchive,
      accent: !archived,
    },
    {
      key: 'select',
      label: 'Выбрать',
      icon: 'checkmark-circle-outline',
      onPress: onSelect,
    },
    {
      key: 'delete',
      label: 'Удалить',
      icon: 'trash-outline',
      onPress: onDelete,
      destructive: true,
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: theme.overlay }]} onPress={onClose} accessibilityLabel="Закрыть меню">
        <MotiView
          from={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, translateY: 12 }}
          animate={{ opacity: 1, scale: 1, translateY: 0 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
          style={[
            styles.menu,
            theme.shadow,
            {
              backgroundColor: theme.dark ? 'rgba(20,28,42,0.95)' : 'rgba(255,255,255,0.97)',
              borderColor: theme.glassBorder,
            },
            Platform.OS === 'web' ? ({ backdropFilter: 'blur(18px) saturate(1.4)' } as object) : null,
          ]}
        >
          <View style={styles.head}>
            <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: 14.5 }} numberOfLines={1}>
              {title}
            </Text>
            {unread > 0 ? (
              <View style={[styles.count, { backgroundColor: theme.accentSoft }]}>
                <Text style={{ color: theme.accent, fontWeight: '700', fontSize: 11 }}>{unread} новых</Text>
              </View>
            ) : null}
          </View>

          {actions.map((action, index) => {
            const color = action.destructive ? theme.danger : action.accent ? theme.accent : theme.textPrimary;
            return (
              <MotiView
                key={action.key}
                from={reduced ? { opacity: 0 } : { opacity: 0, translateX: 10 }}
                animate={{ opacity: 1, translateX: 0 }}
                transition={
                  reduced
                    ? { type: 'timing', duration: 0 }
                    : { ...motion.softSpring, delay: 20 + index * 18 }
                }
              >
                <Pressable
                  onPress={() => {
                    onClose();
                    action.onPress();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={action.label}
                  style={({ pressed }) => [
                    styles.item,
                    {
                      backgroundColor: pressed
                        ? action.destructive
                          ? theme.dangerSoft
                          : theme.surfacePressed
                        : 'transparent',
                    },
                  ]}
                >
                  <Ionicons name={action.icon} size={19} color={color} />
                  <Text style={{ color, fontSize: 14.5, fontWeight: action.destructive ? '700' : '600', flex: 1 }}>
                    {action.label}
                  </Text>
                </Pressable>
              </MotiView>
            );
          })}
        </MotiView>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 22 },
  menu: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 20,
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 10,
  },
  count: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 12,
    minHeight: 44,
  },
});
