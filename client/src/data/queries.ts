/**
 * Серверные данные (react-query). Все вызовы — реальные, без кеширования моков.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as api from './api';
import type { Chat, Envelope } from './api';
import { loadChatMessages, type ViewMessage } from './messaging';
import { useStore } from '../state/useStore';

export const CHATS_KEY = 'chats';
export const CHANNELS_KEY = 'channels';
export const NODES_KEY = 'nodes';
export const MODULES_KEY = 'modules';
export const STATS_KEY = 'stats';
export const BLOCKED_KEY = 'blocked';

/** Разумные окна свежести: список чатов меняется часто, справочники — редко. */
export const STALE = {
  chats: 12_000,
  messages: 4_000,
  profile: 30_000,
  me: 30_000,
  directory: 60_000,
  search: 30_000,
} as const;

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.api.me(),
    retry: false,
    staleTime: STALE.me,
    gcTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useChats() {
  const me = useStore((s) => s.me);
  return useQuery({
    queryKey: [CHATS_KEY, me?.username],
    queryFn: () => api.api.listChats(),
    enabled: Boolean(me),
    staleTime: STALE.chats,
    gcTime: 30 * 60_000,
    placeholderData: (prev) => prev,
  });
}

/** Архивные чаты текущего пользователя. */
export function useArchivedChats() {
  const me = useStore((s) => s.me);
  return useQuery({
    queryKey: [CHATS_KEY, 'archived'],
    queryFn: () => api.api.listChats(true),
    enabled: Boolean(me),
    staleTime: STALE.chats,
    gcTime: 30 * 60_000,
    placeholderData: (prev) => prev,
  });
}

/**
 * Тёплый старт чата: пока пользователь ведёт курсор/палец к строке,
 * заранее подтягиваем метаданные и историю сообщений. Уже загруженное не трогаем.
 */
export async function prefetchChat(qc: QueryClient, chat: Chat): Promise<void> {
  if (!chat?.id) return;
  const jobs: Promise<unknown>[] = [];
  if (qc.getQueryData(['chat', chat.id]) === undefined) {
    jobs.push(
      qc.prefetchQuery({
        queryKey: ['chat', chat.id],
        queryFn: () => api.api.getChat(chat.id),
        staleTime: STALE.profile,
      }),
    );
  }
  if (qc.getQueryData(['messages', chat.id]) === undefined) {
    jobs.push(
      qc.prefetchQuery<ViewMessage[]>({
        queryKey: ['messages', chat.id],
        queryFn: () => {
          const me = useStore.getState().me;
          return loadChatMessages(chat, me?.username ?? api.getSession()?.username ?? '');
        },
        staleTime: STALE.messages,
      }),
    );
  }
  if (jobs.length) await Promise.allSettled(jobs);
}

/** Архивировать/вернуть чат из архива. */
export function useSetChatArchived() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; archived: boolean }) =>
      api.api.setChatArchived(input.id, input.archived),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [CHATS_KEY] });
      void qc.invalidateQueries({ queryKey: [CHATS_KEY, 'archived'] });
    },
  });
}

export function useChatMessages(chat: Chat | null) {
  return useQuery<ViewMessage[]>({
    queryKey: ['messages', chat?.id],
    enabled: Boolean(chat),
    queryFn: async () => {
      if (!chat) return [];
      const me = useStore.getState().me;
      return loadChatMessages(chat, me?.username ?? api.getSession()?.username ?? '');
    },
    staleTime: STALE.messages,
    gcTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useChannels(search: string) {
  const me = useStore((s) => s.me);
  return useQuery({
    queryKey: [CHANNELS_KEY, search, me?.username],
    queryFn: () => api.api.listChannels(search),
    enabled: Boolean(me),
    staleTime: STALE.directory,
    gcTime: 15 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useMySubscriptions() {
  return useQuery({
    queryKey: [CHANNELS_KEY, 'subs'],
    queryFn: () => api.api.mySubscriptions(),
    staleTime: STALE.directory,
    gcTime: 15 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useNodes() {
  const me = useStore((s) => s.me);
  return useQuery({
    queryKey: [NODES_KEY, me?.username],
    queryFn: () => api.api.myNodes(),
    enabled: Boolean(me),
    staleTime: STALE.directory,
    placeholderData: (prev) => prev,
  });
}

export function useNetwork() {
  return useQuery({
    queryKey: ['network'],
    queryFn: () => api.api.networkNodes(),
  });
}

export function useModules() {
  const me = useStore((s) => s.me);
  return useQuery({
    queryKey: [MODULES_KEY, me?.username],
    queryFn: () => api.api.listModules(),
    enabled: Boolean(me),
    staleTime: STALE.directory,
    gcTime: 15 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useStats() {
  return useQuery({
    queryKey: [STATS_KEY],
    queryFn: () => api.api.stats(),
    staleTime: STALE.directory,
    gcTime: 15 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useCreateChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.api.createChat>[0]) => api.api.createChat(input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [CHATS_KEY] }),
  });
}

export function useSubscribe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.subscribe(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [CHANNELS_KEY] }),
  });
}

export function useUnsubscribe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.unsubscribe(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [CHANNELS_KEY] }),
  });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title: string) => api.api.createChannel(title),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [CHANNELS_KEY] }),
  });
}

export function useCreateClaim() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nodeName: string) => api.api.createClaim(nodeName),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [NODES_KEY] }),
  });
}

export function useNodeStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status: string }) => api.api.setNodeStatus(input.id, input.status),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [NODES_KEY] }),
  });
}

/** Плавный вывод узла: drain → миграция реплик → удаление данных → стоп. */
export function useDrainNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.drainNode(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [NODES_KEY] });
      void qc.invalidateQueries({ queryKey: ['network'] });
    },
  });
}

export function useUnbindModule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.unbindModule(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [MODULES_KEY] }),
  });
}

/** Подключить wearable к клиенту по BLE/USB. */
export function useAttachModule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; transport: 'ble' | 'usb' }) =>
      api.api.attachModule(input.id, input.transport),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [MODULES_KEY] }),
  });
}

/** Отключить wearable от клиента. */
export function useDetachModule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.detachModule(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [MODULES_KEY] }),
  });
}

/** Аппаратная блокировка по hardware_id (не снимается перепрошивкой). */
export function useBlockModule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; reason?: string }) => api.api.blockModule(input.id, input.reason),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [MODULES_KEY] }),
  });
}

/** Снять аппаратную блокировку. */
export function useUnblockModule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.unblockModule(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [MODULES_KEY] }),
  });
}

/** Добавить подготовленный модуль по 8-значному публичному ID. */
export function useClaimModule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (publicId: string) => api.api.claimModule(publicId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [MODULES_KEY] }),
  });
}

/** Параметры глобальной mesh-сети (read-only для UI). */
export function useModuleMesh() {
  return useQuery({
    queryKey: [MODULES_KEY, 'mesh'],
    queryFn: () => api.api.getModuleMesh(),
    staleTime: STALE.directory,
    gcTime: 30 * 60_000,
  });
}

/** Убрать shadow-запись «привязан на другом устройстве». */
export function useDismissModuleShadow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shadowId: string) => api.api.dismissModuleShadow(shadowId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [MODULES_KEY] }),
  });
}

/** «Это не я»: отправить shadow-запись в поддержку. */
export function useReportModuleShadow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (shadowId: string) => api.api.reportModuleShadow(shadowId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [MODULES_KEY] }),
  });
}

export function usePatchUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName: string }) => api.api.patchMe(input.displayName),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useUserProfile(username: string | null) {
  return useQuery({
    queryKey: ['profile', username],
    queryFn: () => api.api.userProfile(username as string),
    enabled: Boolean(username),
    retry: false,
    staleTime: STALE.profile,
    gcTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      displayName?: string;
      bio?: string;
      status?: string;
      location?: string;
      birthday?: string | null;
    }) => api.api.patchMe(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

/** Сохранить аватар (объект уже загружен на узлы). */
export function usePutAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { objectId: string; key: string; mime: string }) => api.api.putAvatar(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
      // Аватар показывается и в списке чатов (участники) — освежаем превью.
      void qc.invalidateQueries({ queryKey: [CHATS_KEY] });
    },
  });
}

/** Убрать аватар из профиля. */
export function useDeleteAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.api.deleteAvatar(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
      void qc.invalidateQueries({ queryKey: [CHATS_KEY] });
    },
  });
}

export function useSetBlock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { username: string; blocked: boolean }) => api.api.setBlock(input.username, input.blocked),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: ['profile', input.username] });
      void qc.invalidateQueries({ queryKey: [BLOCKED_KEY] });
      void qc.invalidateQueries({ queryKey: [CHATS_KEY] });
    },
  });
}

export function useBlockedUsers() {
  const me = useStore((s) => s.me);
  return useQuery({
    queryKey: [BLOCKED_KEY, me?.username],
    queryFn: () => api.api.myBlocked(),
    enabled: Boolean(me),
  });
}

export function useReportUser() {
  return useMutation({
    mutationFn: (input: { username: string; reason: string; note?: string }) =>
      api.api.reportUser(input.username, input.reason, input.note),
  });
}

export function useLeaveChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.leaveChat(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [CHATS_KEY] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useDeleteChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.deleteChat(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [CHATS_KEY] });
      void qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useChangeUsername() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => api.api.changeUsername(username),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: { oldPassword: string; newPassword: string }) => api.api.changePassword(input.oldPassword, input.newPassword),
  });
}

/** Удаление аккаунта пользователем (с подтверждением пароля). */
export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api.api.deleteAccount(password),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
    },
  });
}

export function useSearchUsers(q: string) {
  return useQuery({
    queryKey: ['users', q],
    queryFn: () => api.api.searchUsers(q),
    enabled: q.length >= 2,
    staleTime: STALE.search,
    gcTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useDevices(token: string) {
  return useQuery({
    queryKey: ['devices'],
    queryFn: () => api.api.listDevices(token),
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.revokeDevice(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['devices'] }),
  });
}

export function useDeleteMessage(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) => api.api.deleteMessage(chatId, messageId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['messages', chatId] }),
  });
}

/**
 * Отметить сообщение просмотренным. Кеш специально не инвалидируем:
 * счётчик просмотров не критичен, а лишний рефетч истории не нужен.
 */
export function useMarkMessageView() {
  return useMutation({
    mutationFn: (input: { chatId: string; messageId: string }) =>
      api.api.markMessageView(input.chatId, input.messageId),
  });
}

/* ------------------------------------------------------- админ: жалобы ---- */

export function useAdminReports(status: 'open' | 'all') {
  return useQuery({
    queryKey: ['admin', 'reports', status],
    queryFn: () => api.api.adminReports(status),
    staleTime: 10_000,
  });
}

export function useResolveReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: number; status: 'open' | 'resolved' | 'dismissed'; note?: string }) =>
      api.api.adminResolveReport(input.id, input.status, input.note),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'reports'] }),
  });
}

export function useAdminUserChats(userId: string | null) {
  return useQuery({
    queryKey: ['admin', 'userChats', userId],
    queryFn: () => api.api.adminUserChats(userId as string),
    enabled: Boolean(userId),
    staleTime: 10_000,
  });
}

export function useAdminChatView(chatId: string | null) {
  return useQuery({
    queryKey: ['admin', 'chatView', chatId],
    queryFn: () => api.api.adminChatView(chatId as string),
    enabled: Boolean(chatId),
    staleTime: 0,
  });
}

export function useAdminDeleteMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { chatId: string; messageId: string }) => api.api.adminDeleteMessage(input.messageId),
    onSuccess: (_data, input) => {
      void qc.invalidateQueries({ queryKey: ['admin', 'chatView', input.chatId] });
      void qc.invalidateQueries({ queryKey: ['admin', 'userChats'] });
    },
  });
}

export function useWarnUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; note: string }) => api.api.adminWarnUser(input.userId, input.note),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'reports'] }),
  });
}

/* ------------------------------------- группы/каналы: права и приглашения -- */

export function useInvites(chatId: string | null) {
  return useQuery({
    queryKey: ['invites', chatId],
    queryFn: () => api.api.chatInvites(chatId as string),
    enabled: Boolean(chatId),
    staleTime: 10_000,
  });
}

export function useCreateInvite(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: { role?: 'member' | 'moderator' | 'admin'; expiresInHours?: number | null; maxUses?: number | null } = {},
    ) => api.api.createInvite(chatId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invites', chatId] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function useRevokeInvite(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (inviteId: string) => api.api.revokeInvite(chatId, inviteId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['invites', chatId] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function useInvitePreview(token: string | null) {
  return useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.api.invitePreview(token as string),
    enabled: Boolean(token),
    retry: false,
  });
}

export function useJoinInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.api.joinInvite(token),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['chat', data.chatId] });
      void qc.invalidateQueries({ queryKey: ['invites', data.chatId] });
    },
  });
}

export function useJoinRequests(chatId: string | null) {
  return useQuery({
    queryKey: ['requests', chatId],
    queryFn: () => api.api.joinRequests(chatId as string),
    enabled: Boolean(chatId),
    staleTime: 10_000,
  });
}

export function useApproveRequest(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.api.approveRequest(chatId, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['requests', chatId] });
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function useRejectRequest(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.api.rejectRequest(chatId, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['requests', chatId] });
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function useChatBans(chatId: string | null) {
  return useQuery({
    queryKey: ['bans', chatId],
    queryFn: () => api.api.chatBans(chatId as string),
    enabled: Boolean(chatId),
    staleTime: 10_000,
  });
}

export function useBanMember(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; reason?: string; durationHours?: number }) =>
      api.api.banMember(chatId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bans', chatId] });
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function useUnbanMember(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.api.unbanMember(chatId, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bans', chatId] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function useChatAudit(chatId: string | null) {
  return useQuery({
    queryKey: ['audit', chatId],
    queryFn: () => api.api.chatAudit(chatId as string),
    enabled: Boolean(chatId),
    staleTime: 10_000,
  });
}

export function useSetMemberRole(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; role: 'admin' | 'moderator' | 'member' }) =>
      api.api.setMemberRole(chatId, input.userId, input.role),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function useRemoveMember(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.api.removeMember(chatId, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['messages', chatId] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function useTransferOwnership(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.api.transferOwnership(chatId, userId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function usePatchChat(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title?: string; description?: string; visibility?: api.ChatVisibility }) =>
      api.api.patchChat(chatId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

/** Сменить аватар группы/канала (объект уже загружен и зашифрован клиентом). */
export function useSetChatAvatar(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { objectId: string; key: string; mime: string }) =>
      api.api.setChatAvatar(chatId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: [CHANNELS_KEY] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

/** Удалить аватар группы/канала. */
export function useDeleteChatAvatar(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.api.deleteChatAvatar(chatId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: [CHANNELS_KEY] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function useChatPermissionsQuery(chatId: string | null) {
  return useQuery({
    queryKey: ['permissions', chatId],
    queryFn: () => api.api.getChatPermissions(chatId as string),
    enabled: Boolean(chatId),
    staleTime: 10_000,
  });
}

export function useSetChatPermissions(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      admin?: Partial<api.ChatPermissionSet>;
      moderator?: Partial<api.ChatPermissionSet>;
    }) => api.api.setChatPermissions(chatId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['permissions', chatId] });
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

export function useDirectInvite(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => api.api.directInvite(chatId, username),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['requests', chatId] });
      void qc.invalidateQueries({ queryKey: ['audit', chatId] });
    },
  });
}

/* ------------------------------------ комментарии под постами каналов ----- */

export function useChannelComments(chatId: string, messageId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['comments', messageId],
    queryFn: () => api.api.channelComments(chatId, messageId as string),
    enabled: Boolean(chatId && messageId && enabled),
    staleTime: 10_000,
  });
}

export function useAddChannelComment(chatId: string, messageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { objectId: string; nonce: string; header?: unknown }) =>
      api.api.createChannelComment(chatId, messageId, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['comments', messageId] });
      void qc.invalidateQueries({ queryKey: ['messages', chatId] });
    },
  });
}

export function useDeleteChannelComment(chatId: string, messageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => api.api.deleteChannelComment(chatId, messageId, commentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['comments', messageId] });
      void qc.invalidateQueries({ queryKey: ['messages', chatId] });
    },
  });
}

export function useSearchGroups(search: string) {
  return useQuery({
    queryKey: ['groups', search],
    queryFn: () => api.api.searchGroups(search),
    staleTime: 20_000,
  });
}

export const usePendingEnvelope = (envelope: Envelope | null) => envelope;

/** Русский перевод типовых ошибок бэкенда. */
export function humanError(err: unknown): string {
  if (err instanceof api.ApiError) {
    switch (err.code) {
      case 'quota_exceeded': return 'Закончилось место. Освободите файлы или подключите свой узел.';
      case 'username_taken': return 'Этот username уже занят другим пользователем.';
      case 'username_reserved': return 'Имя зарезервировано системой. Попробуйте другое.';
      case 'username_cooldown': return 'Сменить имя можно не чаще, чем раз в 90 дней.';
      case 'invalid_username': return 'Имя должно быть 3–32 символа: a-z, 0-9 и «_».';
      case 'email_taken': return 'Email уже используется.';
      case 'invalid_email': return 'Некорректный email.';
      case 'invalid_code': return 'Неверный код подтверждения.';
      case 'claim_token_required': case 'invalid_claim_token': return 'Сравните токен привязки. Создайте его на вкладке «Сеть».';
      case 'module_paired_to_other_user': return 'Модуль уже привязан к другому аккаунту.';
      case 'hardware_blocked': return 'Плата в блок-листе. Обратитесь в поддержку.';
      case 'no_nodes_available': case 'no_healthy_nodes': return 'Нет доступных узлов сети. Попробуйте позже.';
      case 'node_error': return 'Узел хранения не ответил.';
      case 'unavailable': return 'Сеть недоступна.';
      case 'channel_private': return 'Это приватный канал.';
      case 'user_blocked': return 'Пользователь заблокирован. Разблокируйте его в настройках приватности.';
      case 'invalid_password': return 'Неверный пароль.';
      case 'channel_limit_reached': return 'Достигнут лимит каналов (10).';
      default: return err.message || 'Ошибка сети.';
    }
  }
  return 'Что-то пошло не так. Попробуйте ещё раз.';
}
