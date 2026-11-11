import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { PressableScale } from './PressableScale';
import type { SharedChatRef } from '../../data/api';

const TYPE_META: Record<SharedChatRef['type'], { icon: keyof typeof Ionicons.glyphMap; label: string }> = {
  direct: { icon: 'chatbubble-outline', label: 'Диалог' },
  group: { icon: 'people-outline', label: 'Группа' },
  channel: { icon: 'megaphone-outline', label: 'Канал' },
};

/** Список общих чатов с пользователем. */
export function SharedChatsList({ chats, onOpen }: { chats: SharedChatRef[]; onOpen: (id: string) => void }) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  if (!chats.length) {
    return (
      <Text style={{ color: theme.textSecondary, fontSize: 13, paddingVertical: 8 }}>
        Общих чатов пока нет — самое время познакомиться.
      </Text>
    );
  }

  return (
    <View style={{ gap: 6 }}>
      {chats.map((chat, index) => {
        const meta = TYPE_META[chat.type] ?? TYPE_META.direct;
        return (
          <MotiView
            key={chat.id}
            from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 8, scale: 0.99 }}
            animate={{ opacity: 1, translateY: 0, scale: 1 }}
            transition={
              reduced
                ? { type: 'timing', duration: 0 }
                : { ...motion.spring, delay: Math.min(index, 6) * motion.staggerStepMs }
            }
          >
            <PressableScale
              onPress={() => onOpen(chat.id)}
              accessibilityRole="button"
              accessibilityLabel={`Открыть чат ${chat.title || meta.label}`}
              style={[styles.row, { borderColor: theme.line }]}
            >
              <View style={[styles.iconBox, { backgroundColor: theme.accentSoft }]}>
                <Ionicons name={meta.icon} size={16} color={theme.accent} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                  {chat.title || meta.label}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
                  {meta.label}
                  {chat.membersCount ? ` · ${chat.membersCount} участн.` : ''}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={15} color={theme.textDisabled} />
            </PressableScale>
          </MotiView>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 11,
    borderWidth: 1,
    minHeight: 52,
  },
  iconBox: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
