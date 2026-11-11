/**
 * Верхняя панель режима мультивыбора: «Выбрано N» и массовые действия.
 * Кнопки компактные, чтобы помещаться на смартфоне.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';

interface Action {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  danger?: boolean;
}

export function SelectionToolbar({
  count,
  onCancel,
  onArchive,
  onMute,
  onRead,
  onDelete,
}: {
  count: number;
  onCancel: () => void;
  onArchive: () => void;
  onMute: () => void;
  onRead: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const actions: Action[] = [
    { key: 'read', label: 'Прочитано', icon: 'checkmark-done-outline', onPress: onRead },
    { key: 'mute', label: 'Без звука', icon: 'notifications-off-outline', onPress: onMute },
    { key: 'archive', label: 'В архив', icon: 'archive-outline', onPress: onArchive },
    { key: 'delete', label: 'Удалить', icon: 'trash-outline', onPress: onDelete, danger: true },
  ];

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: theme.dark ? 'rgba(20,28,42,0.92)' : 'rgba(255,255,255,0.95)',
          borderColor: theme.glassBorder,
        },
      ]}
    >
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Отменить выбор"
        style={({ pressed }) => [styles.cancel, { backgroundColor: pressed ? theme.surfacePressed : 'transparent' }]}
      >
        <Ionicons name="close" size={21} color={theme.textPrimary} />
      </Pressable>
      <Text style={{ color: theme.textPrimary, fontWeight: '800', fontSize: 14, flex: 1 }} numberOfLines={1}>
        Выбрано {count}
      </Text>
      {actions.map((action) => (
        <Pressable
          key={action.key}
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: pressed ? (action.danger ? theme.dangerSoft : theme.surfacePressed) : 'transparent' },
          ]}
        >
          <Ionicons name={action.icon} size={19} color={action.danger ? theme.danger : theme.textPrimary} />
          <Text
            style={{
              color: action.danger ? theme.danger : theme.textSecondary,
              fontSize: 10.5,
              fontWeight: '700',
              marginTop: 2,
            }}
            numberOfLines={1}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 4,
    paddingVertical: 4,
    minHeight: 52,
  },
  cancel: { width: 38, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  action: {
    minWidth: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 4,
    borderRadius: 10,
  },
});
