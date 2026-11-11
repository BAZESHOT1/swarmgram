import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../../../src/theme/useTheme';
import { motion } from '../../../../src/theme/motion';
import { EmptyState } from '../../../../src/components/EmptyState';
import { ChatInfoSkeleton } from '../../../../src/components/skeletons/PageSkeletons';
import { useReducedMotion } from '../../../../src/components/useReducedMotion';
import { PressableScale } from '../../../../src/components/profile/PressableScale';
import { GlassCard } from '../../../../src/components/profile/Glass';
import { ConfirmModal } from '../../../../src/components/profile/ConfirmModal';
import { ReportModal } from '../../../../src/components/profile/ReportModal';
import { InfoHero } from '../../../../src/components/chatinfo/InfoHero';
import { InfoQuickActions, type QuickAction } from '../../../../src/components/chatinfo/InfoQuickActions';
import { InfoTabs, type InfoTabItem } from '../../../../src/components/chatinfo/InfoTabs';
import { MembersTab } from '../../../../src/components/chatinfo/MembersTab';
import { MediaTab } from '../../../../src/components/chatinfo/MediaTab';
import { FilesTab } from '../../../../src/components/chatinfo/FilesTab';
import { PinnedCard } from '../../../../src/components/chatinfo/PinnedCard';
import { InfoActions, type InfoActionItem } from '../../../../src/components/chatinfo/InfoActions';
import { ManageTab } from '../../../../src/components/chatinfo/ManageTab';
import { canOpenManage, hasRight, normalizeVisibility, roleOf, visibilityLabel } from '../../../../src/components/chatinfo/ManageTypes';
import { joinByChatId, manageActions, manageError } from '../../../../src/components/chatinfo/ManageData';
import { Avatar } from '../../../../src/components/Avatar';
import { Btn } from '../../../../src/components/Btn';
import type { ChatMemberRow } from '../../../../src/components/chatinfo/MembersTab';
import {
  useChatMessages,
  useCreateChat,
  useDeleteChat,
  useLeaveChat,
  useReportUser,
  useSetBlock,
  useSubscribe,
  useUnsubscribe,
  humanError,
} from '../../../../src/data/queries';
import * as api from '../../../../src/data/api';
import type { Chat } from '../../../../src/data/api';
import { useStore } from '../../../../src/state/useStore';

const TYPE_LABEL: Record<string, string> = { direct: 'Диалог', group: 'Группа', channel: 'Канал' };

/** Страница информации о чате: hero, быстрые действия, вкладки и управление чатом. */
export default function ChatInfoScreen() {
  const theme = useTheme();
  const router = useRouter();
  const reduced = useReducedMotion();
  const params = useLocalSearchParams<{
    id: string;
    title?: string;
    description?: string;
    visibility?: string;
    type?: string;
    members?: string;
  }>();
  const chatId = String(params.id ?? '');

  const session = useStore((s) => s.session);
  const myUsername = session?.username ?? '';
  const qc = useQueryClient();
  const pushToast = useStore((s) => s.pushToast);
  const mutedChats = useStore((s) => s.mutedChats);
  const toggleMuted = useStore((s) => s.toggleMuted);

  const [chat, setChat] = React.useState<Chat | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState('');
  const [tab, setTab] = React.useState('members');
  const [unpinLoading, setUnpinLoading] = React.useState(false);
  const [confirm, setConfirm] = React.useState<'' | 'leave' | 'delete' | 'block'>('');
  const [reportOpen, setReportOpen] = React.useState(false);
  const [secretLoading, setSecretLoading] = React.useState(false);
  const [subscribed, setSubscribed] = React.useState(false);
  const [notMember, setNotMember] = React.useState(false);
  const [joinBusy, setJoinBusy] = React.useState(false);
  const [joinPending, setJoinPending] = React.useState(false);

  const createChat = useCreateChat();
  const leaveChat = useLeaveChat();
  const deleteChat = useDeleteChat();
  const setBlock = useSetBlock();
  const reportUser = useReportUser();
  const subscribe = useSubscribe();
  const unsubscribe = useUnsubscribe();

  const placeholderChat = React.useMemo(
    () =>
      ({
        id: chatId,
        type: 'direct',
        title: '',
        encryption: 'server',
        pinnedMessage: null,
        createdAt: '',
        updatedAt: '',
        lastSeq: 0,
        unread: 0,
        members: [],
        lastMessage: null,
      }) as unknown as Chat,
    [chatId],
  );

  const messagesQuery = useChatMessages(chatId ? (chat ?? placeholderChat) : null);
  const messages = messagesQuery.data ?? [];

  const loadedOnce = React.useRef(false);

  const loadChat = React.useCallback(async () => {
    // Скелетон только при первом открытии: действия в «Управлении» не должны
    // перерисовывать весь экран.
    if (!loadedOnce.current) setLoading(true);
    setLoadError('');
    try {
      const fresh = await api.api.getChat(chatId);
      setChat(fresh);
      setNotMember(false);
      setSubscribed(fresh.members.some((m) => m.username === myUsername));
      loadedOnce.current = true;
    } catch (e: unknown) {
      // Не участник: даём экран вступления вместо «Чат не найден».
      const code = e instanceof api.ApiError ? e.code : '';
      const status = e instanceof api.ApiError ? e.status : 0;
      setNotMember(code === 'not_a_member' || status === 403);
      setLoadError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, [chatId, myUsername]);

  React.useEffect(() => {
    void loadChat();
  }, [loadChat]);

  const type = chat?.type ?? 'direct';
  const isDirect = type === 'direct';
  const isChannel = type === 'channel';
  const encryption = chat?.encryption === 'e2e' ? 'e2e' : 'server';
  const peer = chat?.members.find((m) => m.username !== myUsername) ?? null;
  const title = isDirect ? peer?.displayName || peer?.username || chat?.title || 'Диалог' : chat?.title || 'Чат';
  const members = chat?.members ?? [];
  const muted = mutedChats.includes(chatId);
  const isOwner = Boolean(chat?.ownerUsername && chat.ownerUsername === myUsername);
  const myRole = roleOf(chat, myUsername);
  const manageAvailable = canOpenManage(chat, myUsername);
  const canManagePeople =
    !isDirect && (myRole === 'owner' || (myRole === 'admin' && hasRight(chat, myUsername, 'manageMembers')));
  const managePending = chat?.pendingRequests ?? 0;

  const pinned = chat?.pinnedMessage ?? null;
  const pinnedMessage = pinned ? messages.find((m) => m.id === pinned.id) ?? null : null;
  const pinnedText = pinnedMessage
    ? pinnedMessage.text || pinnedMessage.file?.name || 'Вложение'
    : pinned
      ? 'Закреплённое сообщение'
      : '';

  const tabs: InfoTabItem[] = [
    {
      key: 'members',
      label: isChannel ? 'Подписчики' : 'Участники',
      icon: isChannel ? 'megaphone-outline' : 'people-outline',
      badge: isDirect ? undefined : members.length || chat?.membersCount,
    },
    ...(manageAvailable
      ? [
          {
            key: 'manage',
            label: 'Управление',
            icon: 'settings-outline' as const,
            badge: managePending > 0 ? managePending : undefined,
          },
        ]
      : []),
    { key: 'media', label: 'Медиа', icon: 'images-outline' },
    { key: 'files', label: 'Файлы', icon: 'document-attach-outline' },
  ];

  async function toggleMute() {
    toggleMuted(chatId);
    pushToast({ kind: 'info', message: muted ? 'Уведомления включены' : 'Уведомления выключены' });
  }

  async function unpin() {
    setUnpinLoading(true);
    try {
      await api.api.pinMessage(chatId, null);
      pushToast({ kind: 'success', message: 'Сообщение откреплено' });
      await loadChat();
      await messagesQuery.refetch();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    } finally {
      setUnpinLoading(false);
    }
  }

  async function createSecretChat() {
    if (!isDirect || !peer || encryption === 'e2e' || secretLoading) return;
    setSecretLoading(true);
    try {
      const created = await createChat.mutateAsync({ type: 'direct', username: peer.username, encryption: 'e2e' });
      try {
        const core = await import('../../../../src/crypto/core');
        const keys = await core.storage.loadKeys();
        if (keys) {
          const bundle = await api.api
            .getBundle(peer.username)
            .catch(() => ({ devices: [] as { deviceId: string; ecdhPub: string }[] }));
          const { createAndShareChatKey } = await import('../../../../src/data/chatkit');
          await createAndShareChatKey(
            created.id,
            [
              { deviceId: keys.deviceId, ecdhPub: JSON.stringify(core.publicJwkOf(keys.ecdhPriv)) },
              ...bundle.devices.map((d) => ({ deviceId: d.deviceId, ecdhPub: d.ecdhPub })),
            ],
            keys,
          );
          const { refreshKeyBackup } = await import('../../../../src/data/auth');
          void refreshKeyBackup();
        }
      } catch {
        /* ключ можно дослать позже */
      }
      pushToast({ kind: 'success', message: 'Секретный чат создан' });
      router.push(`/chat/${created.id}` as never);
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    } finally {
      setSecretLoading(false);
    }
  }

  async function doLeave() {
    try {
      await leaveChat.mutateAsync(chatId);
      pushToast({ kind: 'success', message: 'Вы покинули чат' });
      setConfirm('');
      router.replace('/chats' as never);
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  async function doDelete() {
    try {
      await deleteChat.mutateAsync(chatId);
      pushToast({ kind: 'success', message: 'Чат удалён' });
      setConfirm('');
      router.replace('/chats' as never);
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  async function doBlock() {
    if (!peer) return;
    try {
      await setBlock.mutateAsync({ username: peer.username, blocked: true });
      pushToast({ kind: 'success', message: 'Пользователь заблокирован' });
      setConfirm('');
      await loadChat();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  async function sendReport(reason: string, note: string) {
    if (!peer) return;
    try {
      await reportUser.mutateAsync({ username: peer.username, reason, note });
      pushToast({ kind: 'success', message: 'Жалоба отправлена' });
      setReportOpen(false);
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  async function toggleSubscription() {
    try {
      if (subscribed) {
        await unsubscribe.mutateAsync(chatId);
        setSubscribed(false);
        pushToast({ kind: 'success', message: 'Вы отписались от канала' });
      } else {
        await subscribe.mutateAsync(chatId);
        setSubscribed(true);
        pushToast({ kind: 'success', message: 'Вы подписались на канал' });
      }
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  /** Смена роли участника из вкладки «Участники». */
  async function changeMemberRole(member: ChatMemberRow, role: 'admin' | 'moderator' | 'member') {
    try {
      await manageActions.setMemberRole(chatId, member.userId, role);
      pushToast({ kind: 'success', message: `Роль @${member.username} обновлена` });
      await loadChat();
      void qc.invalidateQueries({ queryKey: ['chats'] });
    } catch (e: unknown) {
      const message = manageError(e);
      pushToast({ kind: 'error', message });
      throw new Error(message);
    }
  }

  /** Исключение участника (кроме владельца). */
  async function removeChatMember(member: ChatMemberRow) {
    try {
      await manageActions.removeMember(chatId, member.userId);
      pushToast({ kind: 'success', message: `@${member.username} исключён(а)` });
      await loadChat();
      void qc.invalidateQueries({ queryKey: ['chats'] });
    } catch (e: unknown) {
      const message = manageError(e);
      pushToast({ kind: 'error', message });
      throw new Error(message);
    }
  }

  /** Вступление/заявка из информации о найденной в поиске группе. */
  async function joinFromInfo() {
    if (joinBusy || joinPending) return;
    setJoinBusy(true);
    try {
      const outcome = await joinByChatId(chatId);
      if (outcome.status === 'pending') {
        setJoinPending(true);
        pushToast({ kind: 'success', message: 'Заявка отправлена, ожидайте одобрения' });
      } else {
        pushToast({ kind: 'success', message: 'Вы вступили в чат' });
        router.replace(`/chat/${outcome.chatId || chatId}` as never);
      }
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setJoinBusy(false);
    }
  }

  const quickActions: QuickAction[] = [
    { key: 'search', icon: 'search-outline', label: 'Поиск', hint: 'по сообщениям', onPress: () => router.push(`/chat/${chatId}?search=1` as never) },
    {
      key: 'mute',
      icon: muted ? 'notifications-off-outline' : 'notifications-outline',
      label: muted ? 'Без звука' : 'Уведомления',
      hint: muted ? 'выключены' : 'включены',
      active: muted,
      onPress: () => void toggleMute(),
    },
    ...(isDirect && encryption === 'server'
      ? [
          {
            key: 'secret',
            icon: 'lock-closed-outline' as const,
            label: 'Секретный чат',
            hint: 'E2E',
            onPress: () => void createSecretChat(),
            disabled: secretLoading || !peer,
          },
        ]
      : []),
  ];

  const actions: InfoActionItem[] = [];
  if (isChannel && !isOwner) {
    actions.push({
      key: 'subscribe',
      icon: subscribed ? 'notifications-off-outline' : 'add-circle-outline',
      label: subscribed ? 'Отписаться от канала' : 'Подписаться на канал',
      hint: subscribed ? 'Новые посты перестанут приходить' : 'Получать новые посты',
      onPress: () => void toggleSubscription(),
      loading: subscribe.isPending || unsubscribe.isPending,
      danger: subscribed,
    });
  }
  if (!isChannel && !isDirect) {
    actions.push({
      key: 'leave',
      icon: 'exit-outline',
      label: 'Покинуть чат',
      hint: 'Вы перестанете получать сообщения',
      onPress: () => setConfirm('leave'),
    });
  }
  if (isDirect) {
    actions.push({
      key: 'delete',
      icon: 'trash-outline',
      label: 'Удалить чат',
      hint: 'Диалог будет удалён у обоих участников',
      onPress: () => setConfirm('delete'),
      danger: true,
    });
  }
  if (isDirect && peer) {
    actions.push({
      key: 'block',
      icon: 'ban-outline',
      label: 'Заблокировать',
      hint: `@${peer.username}`,
      onPress: () => setConfirm('block'),
      danger: true,
    });
    actions.push({
      key: 'report',
      icon: 'flag-outline',
      label: 'Пожаловаться',
      hint: 'Отправить жалобу модераторам',
      onPress: () => setReportOpen(true),
    });
  }
  if (isOwner && isChannel) {
    actions.push({
      key: 'owner',
      icon: 'shield-checkmark-outline',
      label: 'Вы владелец канала',
      hint: 'Управление доступно во вкладке «Управление»',
      onPress: () => undefined,
      disabled: true,
    });
  }

  if (loading) {
    return <ChatInfoSkeleton onBack={() => router.back()} />;
  }

  // Пользователь ещё не участник: показываем карточку вступления с данными из поиска.
  if (notMember && !chat) {
    const fallbackTitle = String(params.title ?? (params.type === 'channel' ? 'Канал' : 'Группа'));
    const fallbackType = params.type === 'channel' ? 'channel' : 'group';
    const fallbackVisibility = normalizeVisibility(params.visibility);
    const fallbackMembers = Number(params.members) || 0;
    const isClosed = fallbackVisibility === 'closed';
    return (
      <ScrollView contentContainerStyle={{ padding: 12, paddingTop: 44, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        <View style={styles.center}>
          <PressableScale
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Назад"
            style={[styles.backRow, { backgroundColor: theme.dark ? 'rgba(24,32,46,0.6)' : 'rgba(255,255,255,0.7)' }]}
          >
            <Ionicons name="chevron-back" size={20} color={theme.textPrimary} />
            <Text style={{ color: theme.textPrimary, fontWeight: '600', fontSize: 13 }}>Назад</Text>
          </PressableScale>

          <GlassCard glow padding={20} style={{ alignItems: 'center' }}>
            <Avatar name={fallbackTitle} size={78} hasModule={false} hasNode={false} />
            <Text style={{ color: theme.textPrimary, fontSize: 20, fontWeight: '700', marginTop: 12, textAlign: 'center' }}>
              {fallbackTitle}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9, justifyContent: 'center' }}>
              <View style={[styles.fallbackBadge, { backgroundColor: theme.surfacePressed, borderColor: theme.line }]}>
                <Ionicons name={fallbackType === 'channel' ? 'megaphone-outline' : 'people-outline'} size={11} color={theme.textSecondary} />
                <Text style={{ color: theme.textSecondary, fontSize: 11, fontWeight: '600' }}>
                  {fallbackType === 'channel' ? 'Канал' : 'Группа'}
                </Text>
              </View>
              <View style={[styles.fallbackBadge, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}>
                <Ionicons name={fallbackVisibility === 'private' ? 'key-outline' : fallbackVisibility === 'closed' ? 'shield-half-outline' : 'globe-outline'} size={11} color={theme.accent} />
                <Text style={{ color: theme.accent, fontSize: 11, fontWeight: '600' }}>
                  {visibilityLabel(fallbackVisibility, fallbackType)}
                </Text>
              </View>
              {fallbackMembers > 0 ? (
                <View style={[styles.fallbackBadge, { backgroundColor: theme.surfacePressed, borderColor: theme.line }]}>
                  <Ionicons name="person-outline" size={11} color={theme.textSecondary} />
                  <Text style={{ color: theme.textSecondary, fontSize: 11, fontWeight: '600' }}>
                    {fallbackMembers} {fallbackType === 'channel' ? 'подписчиков' : 'участников'}
                  </Text>
                </View>
              ) : null}
            </View>

            {params.description ? (
              <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 12, textAlign: 'center' }}>
                {String(params.description)}
              </Text>
            ) : null}

            <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 12, textAlign: 'center' }}>
              {isClosed
                ? 'Это закрытая группа: отправьте заявку, и администратор её рассмотрит.'
                : fallbackVisibility === 'private'
                  ? 'Это частная группа: вступление возможно по приглашению.'
                  : 'Вы можете вступить в эту группу прямо сейчас.'}
            </Text>

            <View style={{ width: '100%', marginTop: 16 }}>
              {joinPending ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 12 }}>
                  <Ionicons name="hourglass-outline" size={16} color={theme.warning} />
                  <Text style={{ color: theme.warning, fontSize: 13, fontWeight: '600' }}>Заявка отправлена, ожидайте одобрения</Text>
                </View>
              ) : (
                <Btn
                  title={isClosed ? 'Подать заявку' : 'Вступить'}
                  loading={joinBusy}
                  onPress={() => void joinFromInfo()}
                />
              )}
            </View>
          </GlassCard>

          <Text style={{ color: theme.textDisabled, fontSize: 11, marginTop: 12, textAlign: 'center' }}>
            {loadError || 'Чтобы открыть чат, нужно вступить в него.'}
          </Text>
        </View>
      </ScrollView>
    );
  }

  if (loadError || !chat) {
    return (
      <View style={{ flex: 1, paddingTop: 44 }}>
        <EmptyState
          title="Чат не найден"
          subtitle={loadError || 'Возможно, чат удалён или вы не участник.'}
          actionLabel="Назад"
          onAction={() => router.back()}
        />
      </View>
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        <View style={styles.center}>
          <InfoHero
            title={title}
            type={type}
            subtitle={isDirect ? (peer ? `@${peer.username}` : TYPE_LABEL[type]) : undefined}
            encryption={encryption}
            membersCount={chat.membersCount ?? members.length}
            ownerUsername={chat.ownerUsername}
            onBack={() => router.back()}
          />

          <InfoQuickActions actions={quickActions} />

          {pinned ? (
            <PinnedCard text={pinnedText} username={pinned.senderUsername} loading={unpinLoading} onUnpin={() => void unpin()} />
          ) : null}

          <InfoTabs tabs={tabs} value={tab} onChange={setTab} />

          <MotiView
            key={tab}
            from={reduced ? { opacity: 0 } : { opacity: 0, translateX: 10 }}
            animate={{ opacity: 1, translateX: 0 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
          >
            {tab === 'members' ? (
              <MembersTab
                members={members}
                myUsername={myUsername}
                type={type}
                myRole={myRole}
                canManage={canManagePeople}
                onChangeRole={changeMemberRole}
                onRemove={removeChatMember}
                onOpenUser={(u) => router.push(`/user/${u}` as never)}
              />
            ) : tab === 'manage' ? (
              <ManageTab
                chat={chat}
                myUsername={myUsername}
                onChanged={loadChat}
                onDelete={() => setConfirm('delete')}
              />
            ) : tab === 'media' ? (
              <MediaTab messages={messages} />
            ) : (
              <FilesTab messages={messages} />
            )}
          </MotiView>

          {!chat.pinnedMessage && tab === 'members' ? (
            <GlassCard padding={12} style={{ marginTop: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Ionicons name="information-circle-outline" size={16} color={theme.textSecondary} />
                <Text style={{ color: theme.textSecondary, fontSize: 12.5, flex: 1 }}>
                  {encryption === 'e2e'
                    ? 'Секретный чат: ключ хранится только на устройствах участников.'
                    : 'История шифруется серверным ключом и доступна на ваших устройствах.'}
                </Text>
              </View>
            </GlassCard>
          ) : null}

          <View style={{ marginTop: 12 }}>
            <InfoActions actions={actions} />
          </View>

          {isDirect && peer ? (
            <PressableScale
              onPress={() => router.push(`/user/${peer.username}` as never)}
              accessibilityRole="button"
              accessibilityLabel={`Профиль @${peer.username}`}
              style={[styles.profileLink, { borderColor: theme.line }]}
            >
              <Ionicons name="person-circle-outline" size={17} color={theme.accent} />
              <Text style={{ color: theme.accent, fontSize: 13, fontWeight: '600', flex: 1 }}>Открыть профиль @{peer.username}</Text>
              <Ionicons name="chevron-forward" size={15} color={theme.textDisabled} />
            </PressableScale>
          ) : null}
        </View>
      </ScrollView>

      <ConfirmModal
        visible={confirm === 'leave'}
        title="Покинуть чат?"
        message="Вы перестанете получать сообщения этого чата. Вернуться можно будет по приглашению."
        confirmLabel="Покинуть"
        loading={leaveChat.isPending}
        onClose={() => setConfirm('')}
        onConfirm={() => void doLeave()}
      />
      <ConfirmModal
        visible={confirm === 'delete'}
        title="Удалить чат?"
        message={
          isDirect
            ? 'Диалог и его локальная история будут удалены. Это действие нельзя отменить.'
            : isChannel
              ? 'Канал и его история будут удалены для всех подписчиков. Это действие нельзя отменить.'
              : 'Группа и её история будут удалены для всех участников. Это действие нельзя отменить.'
        }
        confirmLabel="Удалить"
        loading={deleteChat.isPending}
        onClose={() => setConfirm('')}
        onConfirm={() => void doDelete()}
      />
      <ConfirmModal
        visible={confirm === 'block'}
        title="Заблокировать пользователя?"
        message="Пользователь не сможет писать вам. Разблокировать можно в его профиле."
        confirmLabel="Заблокировать"
        loading={setBlock.isPending}
        onClose={() => setConfirm('')}
        onConfirm={() => void doBlock()}
      />
      <ReportModal
        visible={reportOpen}
        loading={reportUser.isPending}
        onClose={() => setReportOpen(false)}
        onSubmit={(reason, note) => void sendReport(reason, note)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  center: { width: '100%', maxWidth: 720, alignSelf: 'center' },
  profileLink: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 11, marginTop: 10 },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    marginBottom: 10,
  },
  fallbackBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
});
