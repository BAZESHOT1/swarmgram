import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { GlassCard } from '../profile/Glass';

/** Карточка закреплённого сообщения в информации о чате. */
export function PinnedCard({
  text,
  username,
  loading,
  onUnpin,
}: {
  text: string;
  username?: string;
  loading?: boolean;
  onUnpin: () => void;
}) {
  const theme = useTheme();
  return (
    <GlassCard padding={12} style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={[styles.iconBox, { backgroundColor: theme.accentSoft }]}>
          <Ionicons name="pin" size={15} color={theme.accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700' }} numberOfLines={1}>
            {username ? `@${username}` : 'Закреплённое сообщение'}
          </Text>
          <Text style={{ color: theme.textSecondary, fontSize: 12.5, marginTop: 1 }} numberOfLines={2}>
            {text || 'Сообщение'}
          </Text>
        </View>
        <Pressable
          onPress={onUnpin}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Открепить сообщение"
          hitSlop={6}
          style={({ pressed }) => [styles.unpin, { borderColor: theme.line, opacity: loading ? 0.5 : pressed ? 0.7 : 1 }]}
        >
          <Ionicons name={loading ? 'hourglass-outline' : 'close'} size={14} color={theme.textSecondary} />
          <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontWeight: '600' }}>{loading ? '…' : 'Открепить'}</Text>
        </Pressable>
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  iconBox: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  unpin: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
});
