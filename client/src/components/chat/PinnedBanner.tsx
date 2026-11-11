import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';

/** Плашка закреплённого сообщения под шапкой. */
export function PinnedBanner({
  text,
  username,
  onPress,
  onUnpin,
}: {
  text: string;
  username?: string;
  onPress: () => void;
  onUnpin: () => void;
}) {
  const theme = useTheme();
  return (
    <MotiView
      from={{ opacity: 0, translateY: -8 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: 'spring', damping: 24, stiffness: 300 }}
      style={[styles.wrap, { backgroundColor: theme.surfaceElevated, borderColor: theme.line }]}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Перейти к закреплённому сообщению"
        style={({ pressed }) => [styles.body, { backgroundColor: pressed ? theme.surfacePressed : 'transparent' }]}
      >
        <View style={styles.stripe}>
          <View style={{ width: 3, height: 30, borderRadius: 2, backgroundColor: theme.accent }} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700' }} numberOfLines={1}>
            <Ionicons name="pin" size={10} color={theme.accent} /> {username ? `${username}:` : 'Закреплено'}
          </Text>
          <Text style={{ color: theme.textSecondary, fontSize: 12.5 }} numberOfLines={1}>
            {text}
          </Text>
        </View>
      </Pressable>
      <Pressable onPress={onUnpin} accessibilityRole="button" accessibilityLabel="Открепить сообщение" hitSlop={8} style={styles.close}>
        <Ionicons name="close" size={17} color={theme.textSecondary} />
      </Pressable>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 10,
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    overflow: 'hidden',
  },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, paddingLeft: 6, paddingRight: 4 },
  stripe: { alignSelf: 'stretch', justifyContent: 'center' },
  close: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
});
