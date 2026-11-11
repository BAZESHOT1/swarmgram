/**
 * SwarmGram client root: query/provider, realtime, auth-редиректы,
 * персист темы и сессии.
 */
import React, { useEffect } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Stack, useLocalSearchParams, usePathname, useRouter, useSegments } from 'expo-router';
import { MotiView } from 'moti';
import { Ionicons } from '@expo/vector-icons';
import { ThemeProvider, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { StatusBar } from 'expo-status-bar';
import { AppState, View, ActivityIndicator, StyleSheet, Text } from 'react-native';
import { useTheme } from '../src/theme/useTheme';
import { ACCENTS, type AccentName } from '../src/theme/theme';
import { useBodyBackground } from '../src/theme/useBodyBackground';
import { ToastHost } from '../src/components/Toast';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { LoadingBar } from '../src/components/LoadingBar';
import { GlobalHotkeys } from '../src/components/GlobalHotkeys';
import { useSounds } from '../src/components/useSounds';
import { useHaptics } from '../src/components/useHaptics';
import { onMeshEnvelope } from '../src/modules/meshLink';
import { decryptEnvelopeAuto } from '../src/data/messaging';
import { APP_VERSION_LABEL } from '../src/version';
import { useStore } from '../src/state/useStore';
import { kv } from '../src/crypto/storage';
import { api, ensureAccessToken, getSession, setSession, initSession, wsUrl, type Envelope } from '../src/data/api';
import { applyServerPreferences, initPreferenceSync } from '../src/data/preferences';
import { ModuleProvider } from '../src/modules/ModuleProvider';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/* -------------------------------------------------------------- realtime -- */

/** Тост о заявках включён по умолчанию; на web отключается через localStorage. */
function isRequestsNotifyEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    return localStorage.getItem('sg:notify-requests') !== '0';
  } catch {
    return true;
  }
}

function RealtimeBridge() {
  const session = useStore((s) => s.session);
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const sounds = useSounds();
  const haptics = useHaptics();

  // Актуальные значения для долгоживущего WebSocket-эффекта.
  const pathnameRef = React.useRef(pathname);
  pathnameRef.current = pathname;
  const soundsRef = React.useRef(sounds);
  soundsRef.current = sounds;
  const hapticsRef = React.useRef(haptics);
  hapticsRef.current = haptics;

  React.useEffect(() => {
    if (!session) return;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let firstConnect = true;
    // Счётчик неудачных попыток для exponential backoff; сбрасывается на onopen.
    let reconnectAttempt = 0;
    let lastFallbackAt = 0;
    let disposed = false;

    /** Аккуратно патчим кэш списка чатов (активные и архив). */
    const patchChatLists = (chatId: string, patch: (chat: any) => any) => {
      qc.setQueriesData<any[]>({ queryKey: ['chats'] }, (prev) =>
        Array.isArray(prev) ? prev.map((c) => (c?.id === chatId ? patch(c) : c)) : prev,
      );
    };

    /** Патч чата и в списках, и в точечном кэше ['chat', id]. */
    const patchChatEverywhere = (chatId: string, patch: (chat: any) => any) => {
      patchChatLists(chatId, patch);
      const cached = qc.getQueryData<any>(['chat', chatId]);
      if (cached) qc.setQueryData(['chat', chatId], patch(cached));
    };

    /** Патч одного сообщения в кэше; false — сообщения в кэше нет. */
    const patchMessage = (chatId: string, messageId: string, patch: (m: any) => any): boolean => {
      const list = qc.getQueryData<any[]>(['messages', chatId]);
      if (!Array.isArray(list)) return false;
      let found = false;
      const next = list.map((m) => {
        if (m?.id === messageId) {
          found = true;
          return patch(m);
        }
        return m;
      });
      if (found) qc.setQueryData(['messages', chatId], next);
      return found;
    };

    const activeChatId = (): string | undefined => useStore.getState().activeChat?.id;

    /**
     * Изменение состава/ролей участников: точечно правим members, myRole и
     * membersCount, не перезапрашивая весь список чатов.
     */
    const applyMemberEvent = (
      type: 'chat_member_added' | 'chat_member_removed' | 'chat_member_role',
      event: any,
    ) => {
      const chatId = typeof event.chatId === 'string' ? event.chatId : '';
      if (!chatId) return;
      const uid =
        typeof event.userId === 'string'
          ? event.userId
          : typeof event.member?.userId === 'string'
            ? event.member.userId
            : '';
      const meId = getSession()?.userId;
      const cachedBefore = qc.getQueryData<any>(['chat', chatId]);

      patchChatEverywhere(chatId, (c) => {
        const hadMembers = Array.isArray(c?.members);
        const members: any[] = hadMembers ? c.members : [];
        let nextMembers = members;
        if (type === 'chat_member_added' && uid) {
          const incoming = event.member && typeof event.member === 'object'
            ? event.member
            : { userId: uid, role: event.role ?? 'member' };
          nextMembers = members.some((m) => m?.userId === uid)
            ? members.map((m) => (m?.userId === uid ? { ...m, ...incoming } : m))
            : [...members, incoming];
        } else if (type === 'chat_member_removed' && uid) {
          nextMembers = members.filter((m) => m?.userId !== uid);
        } else if (type === 'chat_member_role' && uid) {
          nextMembers = members.map((m) => (m?.userId === uid ? { ...m, role: event.role ?? m.role } : m));
        }

        const next: any = { ...c };
        if (hadMembers) {
          next.members = nextMembers;
          next.membersCount = nextMembers.length;
        }
        if (typeof event.membersCount === 'number') next.membersCount = event.membersCount;
        if (uid && uid === meId) {
          if (type === 'chat_member_role' && typeof event.role === 'string') next.myRole = event.role;
          if (type === 'chat_member_added' && typeof event.role === 'string') next.myRole = event.role;
        }
        return next;
      });

      // Меня исключили — убираем чат из кэша, чтобы не висеть на 404.
      if (type === 'chat_member_removed' && uid && uid === meId) {
        qc.setQueriesData<any[]>({ queryKey: ['chats'] }, (prev) =>
          Array.isArray(prev) ? prev.filter((c) => c?.id !== chatId) : prev,
        );
        qc.removeQueries({ queryKey: ['chat', chatId] });
        qc.removeQueries({ queryKey: ['messages', chatId] });
      } else if (cachedBefore && !Array.isArray(cachedBefore.members)) {
        // В кэше чата не было списка участников — точечно перечитаем только его.
        void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      }
    };

    /** presence/user_online: обновляем online у direct-чата и профиля. */
    const applyPresence = (event: any) => {
      const userId =
        typeof event.userId === 'string'
          ? event.userId
          : typeof event.user?.userId === 'string'
            ? event.user.userId
            : '';
      if (!userId) return;
      const online =
        event.online === true ||
        event.online === 1 ||
        event.presence === 'online' ||
        event.status === 'online';
      const patch = (c: any) => {
        if (c?.type !== 'direct') return c;
        const members: any[] = Array.isArray(c?.members) ? c.members : [];
        if (!members.some((m) => m?.userId === userId)) return c;
        return {
          ...c,
          online,
          members: members.map((m) => (m?.userId === userId ? { ...m, online } : m)),
        };
      };
      qc.setQueriesData<any[]>({ queryKey: ['chats'] }, (prev) =>
        Array.isArray(prev) ? prev.map(patch) : prev,
      );
      const openId = activeChatId();
      if (openId) {
        const cached = qc.getQueryData<any>(['chat', openId]);
        if (cached) qc.setQueryData(['chat', openId], patch(cached));
      }
      // Профиль пользователя, если открыт: обновляем только его.
      const username = typeof event.username === 'string' ? event.username : '';
      if (username) {
        const profile = qc.getQueryData<any>(['profile', username]);
        if (profile) qc.setQueryData(['profile', username], { ...profile, online });
      }
    };

    /** module_status: обновляем индикатор транспорта и, при необходимости, узлы. */
    const applyModuleStatus = (event: any) => {
      const src = event.module && typeof event.module === 'object' ? event.module : event;
      const current = useStore.getState().transportModule;
      const gateway = typeof src.gateway === 'boolean' ? src.gateway : current?.gateway;
      const model = typeof src.model === 'string' ? src.model : current?.model ?? '';
      if (typeof gateway === 'boolean') {
        useStore.getState().setTransportModule({ gateway, model });
      }
      // Узлы/модули обновляем точечно и только если они уже загружены.
      void qc.invalidateQueries({ queryKey: ['nodes'], type: 'active' });
      void qc.invalidateQueries({ queryKey: ['modules'], type: 'active' });
    };

    /** Просмотры сообщения: патчим viewsCount по id. */
    const applyViews = (event: any) => {
      const chatId = typeof event.chatId === 'string' ? event.chatId : '';
      const messageId =
        typeof event.messageId === 'string'
          ? event.messageId
          : typeof event.id === 'string'
            ? event.id
            : '';
      const views = Number(event.viewsCount ?? event.views ?? event.count ?? event.total);
      if (chatId && messageId && Number.isFinite(views)) {
        const patched = patchMessage(chatId, messageId, (m) => ({ ...m, viewsCount: views }));
        if (!patched) void qc.invalidateQueries({ queryKey: ['messages', chatId] });
      } else if (chatId) {
        void qc.invalidateQueries({ queryKey: ['messages', chatId] });
      }
    };

    /** Мягкий догон после reconnect: только то, что могло устареть. */
    const catchUp = () => {
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['messages'], type: 'active' });
      void qc.invalidateQueries({ queryKey: ['requests'], type: 'active' });
      const id = activeChatId();
      if (id) void qc.invalidateQueries({ queryKey: ['chat', id] });
    };

    /** Exponential backoff 2s → 30s с джиттером ±20%. */
    const scheduleReconnect = () => {
      if (disposed) return;
      // Нет сети — ждём события `online`, не тратим попытки впустую.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const base = Math.min(30_000, 2_000 * 2 ** Math.min(reconnectAttempt, 4));
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const connect = async (fallbackToken?: string) => {
      if (disposed) return;
      // Если access-token истёк — обновляем до открытия сокета, иначе 401.
      const token = (await ensureAccessToken()) || fallbackToken;
      if (!token) return;
      const ws = new WebSocket(wsUrl(token));
      socket = ws;
      ws.onopen = () => {
        reconnectAttempt = 0;
        useStore.getState().setTransportOnline(true);
        // Догон после переподключения: пока связи не было, события могли потеряться.
        if (!firstConnect) catchUp();
        firstConnect = false;
      };
      ws.onerror = () => useStore.getState().setTransportOnline(false);
      ws.onclose = () => {
        if (socket === ws) socket = null;
        useStore.getState().setTransportOnline(false);
        scheduleReconnect();
      };
      ws.onmessage = (raw) => {
        try {
          const event = JSON.parse(String(raw.data));
          if (event.type === 'message') void onEnvelope(event.message as Envelope);
          else if (event.type === 'message_delivered') {
            qc.setQueriesData<any>({ queryKey: ['messages', event.chatId] }, (prev: any) =>
              Array.isArray(prev) ? prev.map((m: any) => (m.id === event.messageId ? { ...m, delivered: true, pending: false, failed: false } : m)) : prev,
            );
          } else if (event.type === 'message_read') {
            qc.setQueriesData<any>({ queryKey: ['messages', event.chatId] }, (prev: any) =>
              Array.isArray(prev) ? prev.map((m: any) => (m.seq <= event.seq && m.mine ? { ...m, delivered: true, pending: false } : m)) : prev,
            );
          } else if (event.type === 'typing') {
            if (typeof event.chatId === 'string' && typeof event.username === 'string' && event.username) {
              useStore.getState().setTyping(event.chatId, event.username);
            }
          } else if (
            event.type === 'message_view' ||
            event.type === 'message_views' ||
            event.type === 'views'
          ) {
            applyViews(event);
          } else if (
            event.type === 'chat_member_added' ||
            event.type === 'chat_member_removed' ||
            event.type === 'chat_member_role'
          ) {
            applyMemberEvent(event.type, event);
          } else if (event.type === 'presence' || event.type === 'user_online') {
            applyPresence(event);
          } else if (event.type === 'module_status') {
            applyModuleStatus(event);
          } else if (event.type === 'message_reaction' || event.type === 'message_edited') {
            const messageId = typeof event.messageId === 'string' ? event.messageId : '';
            const patch = (m: any) => ({
              ...m,
              ...(event.message && typeof event.message === 'object' ? event.message : {}),
              ...(Array.isArray(event.reactions) ? { reactions: event.reactions } : {}),
              ...(event.edited ? { edited: true } : {}),
            });
            const patched = messageId
              ? patchMessage(event.chatId, messageId, patch)
              : false;
            // Формат события без messageId/текста — перечитываем историю.
            if (!patched) void qc.invalidateQueries({ queryKey: ['messages', event.chatId] });
          } else if (event.type === 'message_deleted') {
            const messageId = typeof event.messageId === 'string' ? event.messageId : '';
            const list = qc.getQueryData<any[]>(['messages', event.chatId]);
            if (Array.isArray(list) && messageId) {
              qc.setQueryData(
                ['messages', event.chatId],
                list.filter((m) => m?.id !== messageId),
              );
            } else {
              void qc.invalidateQueries({ queryKey: ['messages', event.chatId] });
            }
            void qc.invalidateQueries({ queryKey: ['chats'] });
          } else if (event.type === 'join_request') {
            // Заявка на вступление: тост (можно отключить в localStorage) и патч списков.
            if (isRequestsNotifyEnabled()) {
              useStore.getState().pushToast({ kind: 'info', message: 'Новая заявка на вступление в чат' });
            }
            // Умеренный тактильный отклик на важное событие (уважает sg:haptics).
            hapticsRef.current.tap();
            const requests = qc.getQueryData<any[]>(['requests', event.chatId]);
            if (Array.isArray(requests)) {
              const request = event.request ?? event.data ?? null;
              const requestId = request?.id ?? event.requestId ?? event.userId;
              const exists = requestId != null && requests.some((r) => r?.id === requestId || r?.userId === request?.userId);
              if (request && !exists) qc.setQueryData(['requests', event.chatId], [request, ...requests]);
              else if (!request) void qc.invalidateQueries({ queryKey: ['requests', event.chatId] });
            } else {
              void qc.invalidateQueries({ queryKey: ['requests', event.chatId] });
            }
            patchChatLists(event.chatId, (c) => ({ ...c, pendingRequests: (c.pendingRequests ?? 0) + 1 }));
          } else if (event.type === 'chat_pin') {
            const patch = (c: any) => ({
              ...c,
              ...(event.chat && typeof event.chat === 'object' ? event.chat : {}),
              ...(event.pinnedMessageId !== undefined ? { pinnedMessageId: event.pinnedMessageId } : {}),
              ...(event.pinnedMessage !== undefined ? { pinnedMessage: event.pinnedMessage } : {}),
            });
            patchChatLists(event.chatId, patch);
            const cached = qc.getQueryData<any>(['chat', event.chatId]);
            if (cached) qc.setQueryData(['chat', event.chatId], patch(cached));
            else void qc.invalidateQueries({ queryKey: ['chat', event.chatId] });
          } else if (event.type === 'chat_added' || event.type === 'chat_key_added') {
            if (event.chat && typeof event.chat === 'object') {
              const added = event.chat as any;
              qc.setQueriesData<any[]>({ queryKey: ['chats'] }, (prev) => {
                if (!Array.isArray(prev)) return prev;
                return prev.some((c) => c?.id === added.id)
                  ? prev.map((c) => (c?.id === added.id ? { ...c, ...added } : c))
                  : [added, ...prev];
              });
            } else {
              void qc.invalidateQueries({ queryKey: ['chats'] });
            }
            void qc.invalidateQueries({ queryKey: ['channels'] });
          } else if (event.type === 'chat_updated') {
            const chatId = typeof event.chatId === 'string' ? event.chatId : '';
            if (event.chat && typeof event.chat === 'object' && chatId) {
              patchChatLists(chatId, (c) => ({ ...c, ...(event.chat as any) }));
              const cached = qc.getQueryData<any>(['chat', chatId]);
              if (cached) qc.setQueryData(['chat', chatId], { ...cached, ...(event.chat as any) });
            } else {
              void qc.invalidateQueries({ queryKey: ['chats'] });
              if (chatId) void qc.invalidateQueries({ queryKey: ['chat', chatId] });
            }
          } else if (event.type === 'chat_removed') {
            const removedId = typeof event.chatId === 'string' ? event.chatId : '';
            qc.setQueriesData<any[]>({ queryKey: ['chats'] }, (prev) =>
              Array.isArray(prev) ? prev.filter((c) => c?.id !== removedId) : prev,
            );
            if (removedId) {
              qc.removeQueries({ queryKey: ['messages', removedId] });
              qc.removeQueries({ queryKey: ['chat', removedId] });
            }
            void qc.invalidateQueries({ queryKey: ['channels'] });
            const current = pathnameRef.current;
            // Если удалили открытый чат — уходим из него, чтобы не висеть на 404.
            if (removedId && (current === `/chat/${removedId}` || current.startsWith(`/chat/${removedId}/`))) {
              router.replace('/chats' as never);
            }
          }
        } catch {
          /* игнорируем некорректные фреймы */
        }
      };
    };

    /** Немедленный reconnect по online/visibility — без ожидания backoff. */
    const reconnectNow = () => {
      if (disposed) return;
      if (!getSession()?.refreshToken) return;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      void connect();
    };

    const onBrowserOnline = () => reconnectNow();
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') reconnectNow();
    };
    // Chrome ругается «Page entered Back-Forward Cache», если при уходе со
    // страницы остаётся открытый WebSocket. Закрываем его на pagehide и
    // поднимаем заново на pageshow.
    const onPageHide = () => {
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
      useStore.getState().setTransportOnline(false);
    };
    const onPageShow = () => reconnectNow();

    // В React Native есть глобальный window, но без addEventListener.
    const hasDomEvents =
      typeof window !== 'undefined' &&
      typeof (window as unknown as { addEventListener?: unknown }).addEventListener === 'function' &&
      typeof document !== 'undefined' &&
      typeof (document as unknown as { addEventListener?: unknown }).addEventListener === 'function';

    if (hasDomEvents) {
      window.addEventListener('online', onBrowserOnline);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', onPageHide);
      window.addEventListener('pageshow', onPageShow);
    }

    // Лёгкий фолбэк: только при видимой вкладке, offline-сокете и не чаще раза в 30 с.
    fallbackTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (useStore.getState().transportOnline) return;
      const now = Date.now();
      if (now - lastFallbackAt < 30_000) return;
      lastFallbackAt = now;
      void qc.invalidateQueries({ queryKey: ['chats'] });
    }, 30_000);

    void connect(session.accessToken);

    // Входящие через модуль: обрабатываем как WS-событие только когда
    // интернета нет, иначе сервер доставит их сам (и будет дубль).
    const unsubMesh = onMeshEnvelope((raw) => {
      if (useStore.getState().transportOnline) return;
      const item = raw as unknown as Record<string, any>;
      const chatId = typeof item.chatId === 'string' ? item.chatId : '';
      const ciphertext = typeof item.envelopeB64 === 'string' ? item.envelopeB64 : '';
      if (!chatId || !ciphertext) return;
      if (item.senderUserId && item.senderUserId === getSession()?.userId) return;
      void (async () => {
        const meName = useStore.getState().me?.username || '';
        const chat =
          queryClient.getQueryData<any>(['chat', chatId]) ??
          ({ id: chatId, type: 'direct', encryption: 'server', members: [] } as any);
        const message = await decryptEnvelopeAuto(
          {
            id: item.clientId || `mesh-${Date.now()}`,
            chatId,
            seq: 0,
            senderUserId: item.senderUserId,
            senderUsername: item.senderUsername || 'Модуль',
            kind: item.kind || 'text',
            createdAt: item.createdAt || new Date().toISOString(),
            nonce: item.nonce,
            header: item.header,
            ciphertext,
            mine: false,
          } as any,
          chat,
          meName,
        ).catch(() => null);
        if (!message) return;
        queryClient.setQueryData<any[]>(['messages', chatId], (prev) => {
          const list = Array.isArray(prev) ? prev : [];
          if (list.some((m) => m?.id === message.id || (m?.clientId && m.clientId === item.clientId))) return list;
          return [message, ...list];
        });
        void queryClient.invalidateQueries({ queryKey: ['chats'] });
      })();
    });

    return () => {
      disposed = true;
      unsubMesh();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (fallbackTimer) clearInterval(fallbackTimer);
      if (hasDomEvents) {
        window.removeEventListener('online', onBrowserOnline);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
      }
      socket?.close();
      useStore.getState().setTransportOnline(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.deviceId, session?.userId]);

  async function onEnvelope(env: Envelope) {
    useStore.getState().setPushEvent({ kind: 'message', payload: env });
    const meId = getSession()?.userId;
    const mine = Boolean(meId && env.senderUserId === meId);

    // Инкрементальный патч истории: оптимистичное сообщение заменяем по id/clientId.
    const messages = queryClient.getQueryData<any[]>(['messages', env.chatId]);
    if (Array.isArray(messages)) {
      const index = messages.findIndex(
        (m) => m && (m.id === env.id || (env.clientId && m.clientId === env.clientId)),
      );
      if (index >= 0) {
        const next = [...messages];
        next[index] = {
          ...next[index],
          id: env.id,
          seq: env.seq,
          kind: env.kind,
          createdAt: env.createdAt,
          reactions: env.reactions ?? next[index].reactions,
          edited: env.edited ?? next[index].edited,
          delivered: true,
          pending: false,
          failed: false,
        };
        queryClient.setQueryData(['messages', env.chatId], next);
      } else {
        // Новое сообщение нужно расшифровать — точечный refetch этого чата.
        void queryClient.invalidateQueries({ queryKey: ['messages', env.chatId] });
      }
    }

    // Список чатов патчим без полного refetch: превью, время, непрочитанные.
    const activeId = useStore.getState().activeChat?.id;
    queryClient.setQueriesData<any[]>({ queryKey: ['chats'] }, (prev) =>
      Array.isArray(prev)
        ? prev.map((c) =>
            c?.id === env.chatId
              ? {
                  ...c,
                  lastMessage: {
                    id: env.id,
                    seq: env.seq,
                    kind: env.kind,
                    createdAt: env.createdAt,
                    senderUserId: env.senderUserId,
                    senderUsername: env.senderUsername,
                  },
                  updatedAt: env.createdAt,
                  unread: mine || activeId === env.chatId ? c.unread ?? 0 : (c.unread ?? 0) + 1,
                }
              : c,
          )
        : prev,
    );

    // квитанция не требует ключа: серверные и E2E-чаты доставляются одинаково
    if (env.senderUserId && meId && env.senderUserId !== meId) {
      // Тихое «дин» и лёгкая вибрация для входящих, кроме приглушённых чатов.
      if (!useStore.getState().mutedChats.includes(env.chatId)) {
        soundsRef.current.receive();
        hapticsRef.current.receive();
      }
      await api.postReceipt(env.chatId, env.id).catch(() => undefined);
    }
  }

  return null;
}

/* ----------------------------------------------------------------- root --- */

export default function RootLayout() {
  const theme = useTheme();
  const segments = useSegments();
  const router = useRouter();
  const pathname = usePathname();
  const params = useLocalSearchParams<{ next?: string }>();
  const sessionState = useStore((s) => s.session);
  const lastNavRef = React.useRef<{ to: string; at: number }>({ to: '', at: 0 });
  useBodyBackground();
  const [ready, setReady] = React.useState(false);
  const [mounted, setMounted] = React.useState(false);

  // Навигационная тема: фон прозрачный, чтобы единственным слоем был <body>.
  const navTheme = React.useMemo(() => {
    const base = theme.dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        background: 'transparent',
        card: 'transparent',
        border: 'transparent',
      },
    };
  }, [theme.dark]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    void (async () => {
      const savedTheme = await kv.get('sg:theme');
      if (savedTheme === 'dark' || savedTheme === 'light' || savedTheme === 'system') useStore.getState().setThemeName(savedTheme);
      // Акцентная палитра хранится отдельно от темы; неизвестное значение игнорируем.
      const savedAccent = await kv.get('sg:accent');
      if (savedAccent && savedAccent in ACCENTS) useStore.getState().setAccent(savedAccent as AccentName);
      // Язык по умолчанию берём локальный; серверные настройки применятся ниже.
      const savedLocale = await kv.get('sg:locale');
      if (savedLocale) useStore.getState().setLocale(savedLocale);
      const s = await initSession();
      useStore.getState().setSession(s);
      // Приглушённые чаты живут локально и не зависят от сервера.
      void useStore.getState().hydrateMuted();
      if (s) {
        try {
          const u = await api.me();
          useStore.getState().setMe(u);
          // Настройки с сервера применяем без отправки обратно.
          applyServerPreferences(u);
        } catch (meError) {
          // протухший access — пробуем refresh
          try {
            const s2 = getSession();
            if (!s2) throw new Error('no-session');
            const r = await api.refresh(s2.refreshToken);
            await setSession({ ...s2, accessToken: r.accessToken, refreshToken: r.refreshToken, accessExp: Date.now() + r.expiresIn * 1000 });
            const u2 = await api.me();
            useStore.getState().setMe(u2);
            applyServerPreferences(u2);
          } catch (refreshError) {
            const status = Number((refreshError as { status?: number } | null)?.status ?? (meError as { status?: number } | null)?.status ?? 0);
            // 401/403 — сессия действительно недействительна; сеть/5xx — оставляем вход
            if (status === 401 || status === 403) await setSession(null);
          }
        }
      }
      // store ready — для (app)-layout, local ready — для внутренних гейтов этого layout
      useStore.getState().setReady(true);
      setReady(true);
      // Синхронизация настроек: включаем после применения серверных значений.
      initPreferenceSync();
    })();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const inAuth = segments.length === 0 || segments[0] === 'auth' || segments[0] === '(auth)';
    const isJoin = segments[0] === 'join';
    const hasSession = Boolean(sessionState) || getSession() !== null;
    const nextPath = typeof params.next === 'string' && params.next.startsWith('/') ? params.next : '/chats';

    // Один переход за раз: повторный replace во время анимации нативного
    // стека мог привести к зависанию интерфейса после входа/регистрации.
    const go = (to: string) => {
      if (pathname === to) return;
      const now = Date.now();
      if (lastNavRef.current.to === to && now - lastNavRef.current.at < 1200) return;
      lastNavRef.current = { to, at: now };
      router.replace(to as never);
    };

    if (hasSession && inAuth) go(nextPath);
    else if (!hasSession && !inAuth && !isJoin) go('/login');
  }, [ready, segments, router, params.next, pathname, sessionState]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }} suppressHydrationWarning>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <QueryClientProvider client={queryClient} suppressHydrationWarning>
        <ThemeProvider value={navTheme}>
        {/* Модуль восстанавливается сам при запуске; на экране логина не сканирует. */}
        <ErrorBoundary>
        <ModuleProvider>
          {mounted ? (
            <>
              <RealtimeBridge />
              <GlobalHotkeys />
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background } }}>
                <Stack.Screen name="index" />
                <Stack.Screen name="(auth)" />
                <Stack.Screen name="(app)" />
                <Stack.Screen name="join/[token]" options={{ animation: 'slide_from_bottom' }} />
              </Stack>
              {!ready ? <FullSkeleton /> : null}
              <ToastHost />
              {/* Верхний прогресс-бар: сетевые запросы + инициализация сессии. */}
              <LoadingBar forceVisible={!ready} />
            </>
          ) : (
            <FullSkeleton />
          )}
        </ModuleProvider>
        </ErrorBoundary>
        </ThemeProvider>
      </QueryClientProvider>
    </View>
  );
}

function FullSkeleton() {
  const theme = useTheme();
  return (
    <View style={[styles.center, { backgroundColor: theme.background }]}>
      <MotiView
        from={{ scale: 0.88, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', damping: 14, stiffness: 170 }}
        style={{ alignItems: 'center', gap: 12 }}
      >
        <MotiView
          animate={{ scale: [1, 1.06, 1] }}
          transition={{ type: 'timing', duration: 1600, repeat: Infinity, repeatReverse: true }}
          style={{
            width: 68,
            height: 68,
            borderRadius: 22,
            backgroundColor: theme.accent,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="git-network" size={34} color={theme.onAccent} />
        </MotiView>
        <Text style={{ color: theme.textPrimary, fontSize: 22, fontWeight: '800', letterSpacing: 0.3 }}>SwarmGram</Text>
        <Text style={{ color: theme.textSecondary, fontSize: 12.5, fontWeight: '600' }}>{APP_VERSION_LABEL}</Text>
        <View style={{ marginTop: 8 }}>
          <ActivityIndicator color={theme.accent} />
        </View>
        <Text style={{ color: theme.textDisabled, fontSize: 11 }}>Проверяем сессию…</Text>
      </MotiView>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
