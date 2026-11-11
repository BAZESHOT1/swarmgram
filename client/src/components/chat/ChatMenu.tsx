import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import { PressableScale } from './PressableScale';
import { motion } from '../../theme/motion';

/** Всплывающее меню «⋮» в шапке чата. Закрывается тапом по затемнённой области. */
export function ChatMenu({
  visible,
  onClose,
  onSearch,
  onAttachments,
  onSecret,
  creatingSecret,
}: {
  visible: boolean;
  onClose: () => void;
  onSearch: () => void;
  onAttachments: () => void;
  /** null — пункт «Создать секретный чат» недоступен для этого диалога. */
  onSecret: (() => void) | null;
  creatingSecret?: boolean;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  if (!visible) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Закрыть меню"
      />
      <MotiView
        from={{ opacity: 0, scale: reduced ? 1 : 0.9, translateY: reduced ? 0 : -6 }}
        animate={{ opacity: 1, scale: 1, translateY: 0 }}
        transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
        style={[
          styles.menu,
          {
            backgroundColor: theme.surfaceElevated,
            borderColor: theme.line,
            ...theme.shadow,
          },
        ]}
      >
        <MenuItem icon="search-outline" label="Поиск по чату" onPress={onSearch} />
        <MenuItem icon="images-outline" label="Вложения" onPress={onAttachments} />
        {onSecret ? (
          <>
            <View style={{ height: 1, backgroundColor: theme.line, marginVertical: 5 }} />
            <MenuItem
              icon="lock-closed-outline"
              label={creatingSecret ? 'Создаём…' : 'Создать секретный чат'}
              accent
              disabled={creatingSecret}
              onPress={onSecret}
            />
          </>
        ) : null}
      </MotiView>
    </View>
  );
}

function MenuItem({
  icon,
  label,
  onPress,
  accent,
  disabled,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  accent?: boolean;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const color = accent ? theme.accent : theme.textPrimary;
  return (
    <PressableScale
      pressedScale={0.97}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.item, { backgroundColor: pressed ? theme.surfacePressed : 'transparent', opacity: disabled ? 0.55 : 1 }]}
    >
      <Ionicons name={icon} size={17} color={accent ? theme.accent : theme.textSecondary} />
      <Text style={{ color, fontSize: 14, fontWeight: accent ? '600' : '400', flex: 1 }}>{label}</Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  menu: {
    position: 'absolute',
    top: 62,
    right: 10,
    width: 236,
    borderRadius: 14,
    borderWidth: 1,
    padding: 6,
    zIndex: 100,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: 9,
    minHeight: 40,
  },
});
