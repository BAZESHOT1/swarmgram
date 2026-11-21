/**
 * Красивые ссылки на личные чаты: /chat/@username вместо /chat/<uuid>.
 * Ищем личный чат с пользователем в кэше списка; если его нет — Hub возвращает существующий
 * (или создаёт) диалог. Пока ищем — короткий индикатор.
 */
import React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '../../data/api';
import { useStore } from '../../state/useStore';
import { useTheme } from '../../theme/useTheme';

export function directPeerFromParam(id: string): string | null {
  const raw = decodeURIComponent(id || '');
  return raw.startsWith('@') && raw.length > 1 ? raw.slice(1).toLowerCase() : null;
}

/** Ссылка на чат: личный — /chat/@username, остальные — по id. */
export function chatHref(chat: { id: string; type?: string; members?: Array<{ username: string }> }, myUsername: string, suffix = ''): string {
  if (chat.type === 'direct') {
    const peer = chat.members?.find((m) => m.username.toLowerCase() !== myUsername.toLowerCase());
    if (peer?.username) return `/chat/@${peer.username}${suffix}`;
  }
  return `/chat/${chat.id}${suffix}`;
}

export function DirectChatResolver({ username, render }: { username: string; render: (chatId: string) => React.ReactElement }) {
  const theme = useTheme();
  const qc = useQueryClient();
  const me = useStore((s) => s.me?.username ?? '');
  const [chatId, setChatId] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    const lists = qc.getQueriesData<api.Chat[]>({ queryKey: ['chats'] });
    for (const [, list] of lists) {
      const found = (Array.isArray(list) ? list : []).find(
        (c) => c?.type === 'direct' && c.members?.some((m) => m.username.toLowerCase() === username && m.username.toLowerCase() !== me.toLowerCase()),
      );
      if (found) {
        setChatId(found.id);
        return undefined;
      }
    }
    api.api
      .createChat({ type: 'direct', username } as never)
      .then((chat) => alive && setChatId(chat.id))
      .catch(() => alive && setError('Не удалось открыть диалог с этим пользователем.'));
    return () => {
      alive = false;
    };
  }, [username, me, qc]);

  if (chatId) return render(chatId);
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
      {error ? <Text style={{ color: theme.danger }}>{error}</Text> : <ActivityIndicator color={theme.accent} />}
    </View>
  );
}
