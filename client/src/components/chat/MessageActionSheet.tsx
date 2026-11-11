import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import type { ViewMessage } from '../../data/messaging';

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

/**
 * Меню долгого нажатия на сообщение: быстрые реакции и действия.
 * Открывается снизу как лист, закрывается тапом по фону.
 */
export function MessageActionSheet({
  message,
  pinned,
  onClose,
  onReact,
  onReply,
  onCopy,
  onEdit,
  onDelete,
  onPin,
  allowCopy = true,
}: {
  message: ViewMessage | null;
  pinned: boolean;
  onClose: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onPin: () => void;
  /** Секретный чат: копирование/пересылка запрещены. */
  allowCopy?: boolean;
}) {
  const theme = useTheme();
  return (
    <Modal visible={Boolean(message)} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Закрыть меню сообщения"
        />
        {message ? (
          <MotiView
            from={{ opacity: 0, translateY: 40, scale: 0.97 }}
            animate={{ opacity: 1, translateY: 0, scale: 1 }}
            transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            style={[styles.sheet, { backgroundColor: theme.surfaceElevated, borderColor: theme.line, ...theme.shadow }]}
          >
            <View style={styles.grabber}>
              <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: theme.line }} />
            </View>

            <Text style={{ color: theme.textSecondary, fontSize: 12.5 }} numberOfLines={2}>
              {message.senderUsername}: {message.text || (message.kind === 'media' ? 'Вложение' : 'Зашифрованное сообщение')}
            </Text>

            <View style={[styles.reactions, { borderColor: theme.line }]}>
              {QUICK_REACTIONS.map((emoji) => (
                <MotiView
                  key={emoji}
                  from={{ scale: 0.85 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', damping: 16, stiffness: 340 }}
                >
                  <Pressable
                    onPress={() => onReact(emoji)}
                    accessibilityRole="button"
                    accessibilityLabel={`Реакция ${emoji}`}
                    style={({ pressed }) => [styles.reactionBtn, { backgroundColor: pressed ? theme.accentSoft : theme.surface }]}
                  >
                    <Text style={{ fontSize: 21 }}>{emoji}</Text>
                  </Pressable>
                </MotiView>
              ))}
            </View>

            <Action icon="arrow-undo-outline" label="Ответить" onPress={onReply} />
            {allowCopy ? <Action icon="copy-outline" label="Копировать" onPress={onCopy} /> : null}
            {message.mine ? <Action icon="create-outline" label="Изменить" onPress={onEdit} /> : null}
            {message.mine ? (
              <Action icon={pinned ? 'pin-outline' : 'pin'} label={pinned ? 'Открепить' : 'Закрепить'} onPress={onPin} />
            ) : null}
            {message.mine ? <Action icon="trash-outline" label="Удалить" danger onPress={onDelete} /> : null}
          </MotiView>
        ) : null}
      </View>
    </Modal>
  );
}

function Action({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  const theme = useTheme();
  const color = danger ? theme.danger : theme.textPrimary;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.action, { backgroundColor: pressed ? (danger ? theme.dangerSoft : theme.surfacePressed) : 'transparent' }]}
    >
      <Ionicons name={icon} size={18} color={danger ? theme.danger : theme.textSecondary} />
      <Text style={{ color, fontSize: 15, flex: 1 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  sheet: {
    width: '100%',
    maxWidth: 520,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 12,
    paddingBottom: 18,
    paddingTop: 8,
    gap: 6,
  },
  grabber: { alignItems: 'center', paddingVertical: 6 },
  reactions: { flexDirection: 'row', justifyContent: 'space-between', gap: 6, borderTopWidth: 1, borderBottomWidth: 1, paddingVertical: 8, marginVertical: 4 },
  reactionBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
    paddingHorizontal: 8,
    borderRadius: 10,
    minHeight: 44,
  },
});
