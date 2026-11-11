import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/useTheme';
import type { Chat } from '../data/api';
import { Avatar } from './Avatar';

function previewOf(chat: Chat, myUsername: string): string {
  const m = chat.lastMessage;
  if (!m) return 'нет сообщений';
  const who = m.senderUsername === myUsername ? 'Вы' : m.senderUsername;
  const what = m.kind === 'media' ? 'Медиа' : 'Сообщение';
  return `${who}: ${what}`;
}

function timeAgo(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч`;
  const day = Math.floor(h / 24);
  if (day === 1) return 'вчера';
  const dd = new Date(d);
  return `${dd.getDate()}.${dd.getMonth() + 1}`;
}

export function ChatListItem({
  item,
  myUsername,
  myHasModule,
  myHasNode,
  unread,
  onPress,
}: {
  item: Chat;
  myUsername: string;
  myHasModule: boolean;
  myHasNode: boolean;
  unread: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const peer = item.members.find((m) => m.username !== myUsername);
  const title = item.type === 'channel' ? item.title : (peer?.displayName || peer?.username || item.title);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Открыть ${title}`}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.surfacePressed : 'transparent', borderBottomColor: theme.line },
      ]}
    >
      <Avatar name={title} hasModule={myHasModule} hasNode={myHasNode} size={48} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: theme.textPrimary }]} numberOfLines={1} ellipsizeMode="tail">
          {title}
        </Text>
        <Text style={[styles.sub, { color: theme.textSecondary }]} numberOfLines={1}>
          {previewOf(item, myUsername)}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={[styles.time, { color: theme.textDisabled }]}>
          {item.lastMessage ? timeAgo(item.lastMessage.createdAt) : ''}
        </Text>
        {unread > 0 ? (
          <View style={[styles.badge, { backgroundColor: theme.accent }]}>
            <Text style={[styles.badgeText, { color: theme.onAccent }]}>{unread}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: 1, minHeight: 64 },
  title: { fontWeight: '600', fontSize: 16 },
  sub: { fontSize: 14, marginTop: 2 },
  right: { alignItems: 'flex-end', gap: 6 },
  time: { fontSize: 12 },
  badge: { minWidth: 24, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, alignItems: 'center' },
  badgeText: { fontSize: 12, fontWeight: '700' },
});
