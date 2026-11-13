/**
 * Серверные данные (react-query). Все вызовы — реальные, без кеширования моков.
 */
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as api from './api';
import type { Chat, Envelope, UserProfile } from './api';
import { loadChatMessages, sendMessage, type ViewMessage } from './messaging';
import { useStore } from '../state/useStore';
import {
  getCachedChats,
  getCachedChannelSubs,
  getCachedMe,
  getCachedProfile,
  loadCachedProfile,
  getCachedMessages,
  loadCachedMessages,
  saveChannelSubs,
  saveMessages,
  saveChats,
  saveMe,
  saveProfile,
} from './cache';

export const CHATS_KEY = 'chats';
export const CHANNELS_KEY = 'channels';
export const NODES_KEY = 'nodes';
export const MODULES_KEY = 'modules';
export const MODULE_TRANSFERS_KEY = 'module-transfers';
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
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => api.api.me(),
    retry: false,
    staleTime: STALE.me,
    gcTime: 10 * 60_000,
    // Кэш из storage — как initialData: при ошибке сети данные не пропадают,
    // а isLoading остаётся false (status уже success).
    initialData: () => getCachedMe() ?? undefined,
    // Кэш всегда считается устаревшим, чтобы сеть обновила его в фоне.
    initialDataUpdatedAt: 0,
    placeholderData: (prev) => prev ?? getCachedMe() ?? undefined,
  });

  // Каждый успешный ответ (и placeholder) обновляет постоянный кэш в фоне.
  const data = query.data;
  useEffect(() => {
    if (data) saveMe(data);
  }, [data]);

  return query;
}

export function useChats() {
  const me = useStore((s) => s.me);
  const username = me?.username;
  const query = useQuery({
    queryKey: [CHATS_KEY, username],
    queryFn: async () => {
      try {
        return await api.api.listChats();
      } catch (error) {
        const cached = username ? getCachedChats(username) : null;
        if (cached) return cached;
        // Без сервера и без кэша показываем пустой список, а не ошибку.
        if (!useStore.getState().transportOnline) return [];
        throw error;
      }
    },
    enabled: Boolean(me),
    staleTime: STALE.chats,
    gcTime: 30 * 60_000,
    // Страховка от потерянных WS-событий: список чатов обновляется сам.
    refetchInterval: 30_000,
    initialData: () => (username ? getCachedChats(username) ?? undefined : undefined),
    initialDataUpdatedAt: 0,
    placeholderData: (prev) => prev ?? (username ? getCachedChats(username) ?? undefined : undefined),
  });

  const data = query.data;
  useEffect(() => {
    if (username && data) saveChats(username, data);
  }, [username, data]);

  return query;
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
      try {
        const messages = await loadChatMessages(chat, me?.username ?? api.getSession()?.username ?? '');
        saveMessages(chat.id, messages);
        return messages;
      } catch (error) {
        // Без интернета показываем последние сохранённые сообщения чата.
        const cached = await loadCachedMessages(chat.id);
        if (cached) return cached as ViewMessage[];
        if (!useStore.getState().transportOnline) return [];
        throw error;
      }
    },
    initialData: () => (chat ? (getCachedMessages(chat.id) as ViewMessage[] | undefined) : undefined),
    initialDataUpdatedAt: 0,
    // Лента всегда перечитывается при входе в чат и при возврате приложения:
    // иначе подтверждённое сообщение может «пропасть» из устаревшего кэша.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    gcTime: 30 * 60_000,
    // Открытый чат не должен «зависать», даже если сокет потерял событие.
    refetchInterval: 12_000,
    placeholderData: (prev) => prev ?? (chat ? (getCachedMessages(chat.id) as ViewMessage[] | undefined) : undefined),
  });
}

/**
 * Отправка сообщения через useMutation с настоящим optimistic update:
 * cancelQueries → setQueryData → mutation → rollback onError → replace onSuccess.
 * Транспорт выбирает sendMessage: интернет → HTTP, иначе KMT/mesh/outbox.
 */
export function useSendChatMessage(chatId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      body: string;
      clientId: string;
      myUsername: string;
      replyId?: string;
      asChannel?: boolean;
    }) =>
      sendMessage(chatId, { text: input.body }, 'text', input.myUsername, {
        clientId: input.clientId,
        replyTo: input.replyId,
        asChannel: input.asChannel,
      }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ['messages', chatId] });
      const previous = qc.getQueryData<ViewMessage[]>(['messages', chatId]);
      const optimistic: ViewMessage = {
        id: input.clientId,
        clientId: input.clientId,
        seq: Number.MAX_SAFE_INTEGER,
        senderUsername: input.myUsername,
        mine: true,
        createdAt: new Date().toISOString(),
        kind: 'text',
        text: input.body,
        replyTo: input.replyId ?? null,
        scheme: 'server',
        reactions: [],
        delivered: false,
        pending: true,
        failed: false,
        asChannel: input.asChannel,
      };
      const base = Array.isArray(previous) ? previous : [];
      const next = [...base, optimistic].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      qc.setQueryData<ViewMessage[]>(['messages', chatId], next);
      saveMessages(chatId, next);
      return { previous, clientId: input.clientId };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        qc.setQueryData(['messages', chatId], context.previous);
        saveMessages(chatId, context.previous);
      } else {
        qc.setQueryData<ViewMessage[]>(['messages', chatId], (prev) =>
          Array.isArray(prev) ? prev.filter((m) => m.clientId !== context?.clientId) : prev,
        );
      }
    },
    onSuccess: (message, _input, context) => {
      const key = message.clientId ?? context?.clientId ?? message.id;
      qc.setQueryData<ViewMessage[]>(['messages', chatId], (prev) => {
        const list = Array.isArray(prev) ? prev : [];
        const next = list.filter((m) => m.clientId !== key && m.id !== message.id && m.id !== key);
        next.push(message);
        next.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        saveMessages(chatId, next);
        return next;
      });
      void qc.invalidateQueries({ queryKey: ['chats'] });
    },
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
  const me = useStore((s) => s.me);
  const username = me?.username;
  const query = useQuery({
    queryKey: [CHANNELS_KEY, 'subs', username],
    queryFn: async () => {
      try {
        return await api.api.mySubscriptions();
      } catch (error) {
        const cached = getCachedChannelSubs(username);
        if (cached) return cached;
        if (!useStore.getState().transportOnline) return [];
        throw error;
      }
    },
    enabled: Boolean(me),
    staleTime: STALE.directory,
    gcTime: 15 * 60_000,
    initialData: () => getCachedChannelSubs(username) ?? undefined,
    initialDataUpdatedAt: 0,
    placeholderData: (prev) => prev ?? getCachedChannelSubs(username) ?? undefined,
  });

  // Каналы кэшируем отдельно: серверный /v1/chats их не возвращает.
  const data = query.data;
  useEffect(() => {
    if (username && data) saveChannelSubs(username, data);
  }, [username, data]);

  return query;
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

/** Входящие/исходящие заявки на перенос модулей. */
export function useModuleTransfers() {
  const me = useStore((s) => s.me);
  return useQuery({
    queryKey: [MODULE_TRANSFERS_KEY, me?.username],
    queryFn: () => api.api.listModuleTransfers(),
    enabled: Boolean(me),
    staleTime: STALE.directory,
    gcTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });
}

function invalidateTransfers(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: [MODULE_TRANSFERS_KEY] });
  void qc.invalidateQueries({ queryKey: [MODULES_KEY] });
}

/** Попросить другого пользователя принять модуль. */
export function useRequestModuleTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; username?: string; userId?: string }) =>
      api.api.requestModuleTransfer(input.id, {
        username: input.username,
        userId: input.userId,
      }),
    onSuccess: () => invalidateTransfers(qc),
  });
}

/** Принять входящую заявку на перенос. */
export function useAcceptModuleTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.acceptModuleTransfer(id),
    onSuccess: () => invalidateTransfers(qc),
  });
}

/** Отклонить входящую заявку на перенос. */
export function useDeclineModuleTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.declineModuleTransfer(id),
    onSuccess: () => invalidateTransfers(qc),
  });
}

/** Отменить исходящую заявку на перенос. */
export function useCancelModuleTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.api.cancelModuleTransfer(id),
    onSuccess: () => invalidateTransfers(qc),
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
  const query = useQuery({
    queryKey: ['profile', username],
    queryFn: async () => {
      try {
        return await api.api.userProfile(username as string);
      } catch (error) {
        const cached = await loadCachedProfile(username);
        if (cached) return cached;
        const me = getCachedMe();
        if (me && username && me.username.toLowerCase() === username.toLowerCase()) {
          return {
            userId: me.id,
            username: me.username,
            displayName: me.displayName || me.username,
            avatar: me.avatar ?? null,
            banner: me.banner,
            status: me.status,
            bio: (me as unknown as { bio?: string }).bio ?? '',
            links: me.links ?? [],
            location: me.location ?? '',
            birthday: me.birthday ?? null,
            createdAt: me.createdAt ?? new Date().toISOString(),
            online: true,
            nodeOnline: false,
            moduleOnline: false,
            lastSeenAt: new Date().toISOString(),
            isSelf: true,
            blockedByMe: false,
            blockedMe: false,
            sharedChats: [],
            role: me.role,
            modulesTotal: 0,
            modulesOnline: 0,
            nodesTotal: me.nodes?.length ?? 0,
            nodesOnline: me.nodes?.filter((node) => node.status === 'online').length ?? 0,
            nodeCapacityBytes: me.nodes?.reduce((sum, node) => sum + Number(node.capacity_bytes ?? 0), 0) ?? 0,
            nodeUsedBytes: me.usedBytes ?? 0,
          } as UserProfile;
        }
        throw error;
      }
    },
    enabled: Boolean(username),
    retry: false,
    staleTime: STALE.profile,
    gcTime: 10 * 60_000,
    // initialData сохраняет кэш даже после сетевой ошибки (offline).
    initialData: () => (username ? getCachedProfile(username) ?? undefined : undefined),
    initialDataUpdatedAt: 0,
    placeholderData: (prev) => prev ?? (username ? getCachedProfile(username) ?? undefined : undefined),
  });

  const data = query.data;
  useEffect(() => {
    if (username && data) saveProfile(data);
  }, [username, data]);

  return query;
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
