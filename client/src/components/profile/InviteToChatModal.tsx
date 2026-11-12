import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { ProfileModal } from './ProfileModal';
import { PressableScale } from './PressableScale';
import { Btn } from '../Btn';
import { useChats, useMySubscriptions, humanError } from '../../data/queries';
import { useStore } from '../../state/useStore';
import * as api from '../../data/api';
import type { Chat, ChatRole } from '../../data/api';

const ROLE_LABEL: Record<ChatRole, string> = {
  owner: 'владелец',
  admin: 'админ',
  moderator: 'модератор',
  member: 'участник',
};

/** Может ли текущий пользователь приглашать в этот чат без ссылки. */
function canInviteTo(chat: Chat, myUsername?: string): boolean {
  if (myUsername && chat.ownerUsername === myUsername) return true;
  const role = chat.myRole;
  if (role === 'owner' || role === 'admin') return true;
  // Модератор — только если матрица прав явно разрешает manageInvites.
  if (role === 'moderator') return Boolean(chat.permissions?.moderator?.manageInvites);
  return false;
}

/**
 * Модалка «Пригласить в чат»: группы и каналы, где у вас есть право
 * приглашать напрямую. Отправляет POST /v1/chats/:id/invite.
 */
export function InviteToChatModal({
  visible,
  username,
  displayName,
  onClose,
}: {
  visible: boolean;
  username: string;
  displayName?: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const myUsername = useStore((s) => s.me?.username);
  const chatsQuery = useChats();
  const subsQuery = useMySubscriptions();
  const [search, setSearch] = React.useState('');
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [invited, setInvited] = React.useState<Set<string>>(() => new Set());

  React.useEffect(() => {
    if (!visible) {
      setSearch('');
      setInvited(new Set());
      setPendingId(null);
    }
  }, [visible]);

  const eligible = React.useMemo(() => {
    const map = new Map<string, Chat>();
    for (const chat of (chatsQuery.data ?? []) as Chat[]) map.set(chat.id, chat);
    for (const chat of (subsQuery.data ?? []) as Chat[]) if (!map.has(chat.id)) map.set(chat.id, chat);
    const rows = [...map.values()];
    const q = search.trim().toLowerCase();
    return rows
      .filter((chat) => chat.type === 'group' || chat.type === 'channel')
      .filter((chat) => canInviteTo(chat, myUsername))
      .filter((chat) => (q ? (chat.title || '').toLowerCase().includes(q) : true))
      .sort((a, b) => (a.title || '').localeCompare(b.title || '', 'ru'));
  }, [chatsQuery.data, subsQuery.data, search, myUsername]);

  async function invite(chat: Chat) {
    if (pendingId) return;
    setPendingId(chat.id);
    try {
      const result = await api.api.directInvite(chat.id, username);
      setInvited((prev) => new Set(prev).add(chat.id));
      pushToast({
        kind: 'success',
        message: result.added === false
          ? `${displayName || `@${username}`} уже в чате «${chat.title}»`
          : `Приглашение отправлено: «${chat.title}»`,
      });
    } catch (e: unknown) {
      // Приватность пользователя (invitePrivacy) вернёт понятную ошибку с Hub.
      pushToast({ kind: 'error', message: humanError(e) });
    } finally {
      setPendingId(null);
    }
  }

  return (
    <ProfileModal
      visible={visible}
      title="Пригласить в чат"
      subtitle={`${displayName || `@${username}`} получит приглашение в группу или канал`}
      onClose={onClose}
      maxWidth={480}
    >
      <View style={[styles.search, { backgroundColor: theme.dark ? 'rgba(10,14,20,0.55)' : 'rgba(255,255,255,0.85)', borderColor: theme.line }]}>
        <Ionicons name="search-outline" size={16} color={theme.textSecondary} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Поиск по названию"
          placeholderTextColor={theme.textDisabled}
          accessibilityLabel="Поиск чата"
          style={{ flex: 1, color: theme.textPrimary, fontSize: 14, paddingVertical: 8 }}
        />
      </View>

      <ScrollView style={{ maxHeight: 340, marginTop: 10 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {chatsQuery.isLoading ? (
          <View style={{ paddingVertical: 30, alignItems: 'center' }}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : chatsQuery.isError ? (
          <View style={{ paddingVertical: 18, gap: 6 }}>
            <Text style={{ color: theme.danger, fontSize: 13 }}>{humanError(chatsQuery.error)}</Text>
            <Text style={{ color: theme.textSecondary, fontSize: 12 }} onPress={() => void chatsQuery.refetch()}>
              Нажмите, чтобы повторить
            </Text>
          </View>
        ) : eligible.length === 0 ? (
          <View style={{ paddingVertical: 26, alignItems: 'center', gap: 6 }}>
            <Ionicons name="people-outline" size={26} color={theme.textDisabled} />
            <Text style={{ color: theme.textSecondary, fontSize: 13, textAlign: 'center' }}>
              {search.trim()
                ? 'Ничего не найдено.'
                : 'Нет групп и каналов, где вы можете приглашать участников напрямую.'}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 6 }}>
            {eligible.map((chat) => {
              const isMember = (chat.members ?? []).some((member) => member.username === username);
              const isInvited = invited.has(chat.id) || isMember;
              const role = (chat.myRole ?? 'member') as ChatRole;
              return (
                <View key={chat.id} style={[styles.row, { borderColor: theme.line }]}>
                  <View style={[styles.iconBox, { backgroundColor: theme.accentSoft }]}>
                    <Ionicons
                      name={chat.type === 'channel' ? 'megaphone-outline' : 'people-outline'}
                      size={16}
                      color={theme.accent}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
                      {chat.title || (chat.type === 'channel' ? 'Канал' : 'Группа')}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
                      {ROLE_LABEL[role] ?? role}
                      {chat.membersCount ? ` · ${chat.membersCount} участн.` : ''}
                    </Text>
                  </View>
                  {isInvited ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8 }}>
                      <Ionicons name="checkmark-circle" size={15} color={theme.success} />
                      <Text style={{ color: theme.success, fontSize: 12, fontWeight: '600' }}>
                        {isMember ? 'Уже в чате' : 'Приглашён'}
                      </Text>
                    </View>
                  ) : (
                    <PressableScale
                      onPress={() => void invite(chat)}
                      disabled={pendingId === chat.id}
                      accessibilityRole="button"
                      accessibilityLabel={`Пригласить в ${chat.title}`}
                      style={[styles.inviteBtn, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}
                    >
                      {pendingId === chat.id ? (
                        <ActivityIndicator size="small" color={theme.accent} />
                      ) : (
                        <>
                          <Ionicons name="person-add-outline" size={14} color={theme.accent} />
                          <Text style={{ color: theme.accent, fontSize: 12.5, fontWeight: '700' }}>Пригласить</Text>
                        </>
                      )}
                    </PressableScale>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>

      <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 16, marginTop: 10 }}>
        Приглашение придёт напрямую. Если пользователь ограничил приглашения в настройках приватности, Hub отклонит
        добавление — вы увидите причину в уведомлении.
      </Text>

      <View style={{ marginTop: 12 }}>
        <Btn title="Готово" onPress={onClose} />
      </View>
    </ProfileModal>
  );
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 52,
  },
  iconBox: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  inviteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 9,
    minHeight: 32,
    minWidth: 92,
  },
});
