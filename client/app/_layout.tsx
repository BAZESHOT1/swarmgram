/**
 * Kinto client root: query/provider, realtime, auth-СЂРµРґРёСЂРµРєС‚С‹,
 * РїРµСЂСЃРёСЃС‚ С‚РµРјС‹ Рё СЃРµСЃСЃРёРё.
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
import { InAppNotifications } from '../src/components/InAppNotifications';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { ModuleAutoBanner } from '../src/components/ModuleAutoBanner';
import { GlobalHotkeys } from '../src/components/GlobalHotkeys';
import { useSounds } from '../src/components/useSounds';
import { useHaptics } from '../src/components/useHaptics';
import { onMeshEnvelope } from '../src/modules/meshLink';
import { decryptEnvelopeAuto, flushOutbox } from '../src/data/messaging';
import { APP_VERSION_LABEL } from '../src/version';
import { useStore } from '../src/state/useStore';
import { kv } from '../src/crypto/storage';
import { api, ensureAccessToken, getSession, setSession, initSession, wsUrl, type Envelope } from '../src/data/api';
import { applyServerPreferences, initPreferenceSync } from '../src/data/preferences';
import { loadCaches, loadProfileCaches, preloadMessageCaches, getCachedMe, findCachedChat } from '../src/data/cache';
import { initPush } from '../src/push';
import { ModuleProvider } from '../src/modules/ModuleProvider';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/* -------------------------------------------------------------- realtime -- */

/** РўРѕСЃС‚ Рѕ Р·Р°СЏРІРєР°С… РІРєР»СЋС‡С‘РЅ РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ; РЅР° web РѕС‚РєР»СЋС‡Р°РµС‚СЃСЏ С‡РµСЂРµР· localStorage. */
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

  // РђРєС‚СѓР°Р»СЊРЅС‹Рµ Р·РЅР°С‡РµРЅРёСЏ РґР»СЏ РґРѕР»РіРѕР¶РёРІСѓС‰РµРіРѕ WebSocket-СЌС„С„РµРєС‚Р°.
  const pathnameRef = React.useRef(pathname);
  pathnameRef.current = pathname;
  const soundsRef = React.useRef(sounds);
  soundsRef.current = sounds;
  const hapticsRef = React.useRef(haptics);
  hapticsRef.current = haptics;

  // При возврате приложения в активное состояние пробуем доотправить очередь.
  useEffect(() => {
    const flush = () => {
      if (!useStore.getState().transportOnline) return;
      void flushOutbox(useStore.getState().me?.username ?? getSession()?.username ?? '')
        .then((sent) => {
          if (sent.length) void queryClient.invalidateQueries({ queryKey: ['chats'] });
        })
        .catch(() => undefined);
    };
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') flush();
    });
    // Периодический ретрай: сообщение могло не уйти при нестабильной сети.
    const timer = setInterval(flush, 45_000);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, []);

  React.useEffect(() => {
    if (!session) return;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let firstConnect = true;
    // РЎС‡С‘С‚С‡РёРє РЅРµСѓРґР°С‡РЅС‹С… РїРѕРїС‹С‚РѕРє РґР»СЏ exponential backoff; СЃР±СЂР°СЃС‹РІР°РµС‚СЃСЏ РЅР° onopen.
    let reconnectAttempt = 0;
    let lastFallbackAt = 0;
    let disposed = false;

    /** РђРєРєСѓСЂР°С‚РЅРѕ РїР°С‚С‡РёРј РєСЌС€ СЃРїРёСЃРєР° С‡Р°С‚РѕРІ (Р°РєС‚РёРІРЅС‹Рµ Рё Р°СЂС…РёРІ). */
    const patchChatLists = (chatId: string, patch: (chat: any) => any) => {
      qc.setQueriesData<any[]>({ queryKey: ['chats'] }, (prev) =>
        Array.isArray(prev) ? prev.map((c) => (c?.id === chatId ? patch(c) : c)) : prev,
      );
    };

    /** РџР°С‚С‡ С‡Р°С‚Р° Рё РІ СЃРїРёСЃРєР°С…, Рё РІ С‚РѕС‡РµС‡РЅРѕРј РєСЌС€Рµ ['chat', id]. */
    const patchChatEverywhere = (chatId: string, patch: (chat: any) => any) => {
      patchChatLists(chatId, patch);
      const cached = qc.getQueryData<any>(['chat', chatId]);
      if (cached) qc.setQueryData(['chat', chatId], patch(cached));
    };

    /** РџР°С‚С‡ РѕРґРЅРѕРіРѕ СЃРѕРѕР±С‰РµРЅРёСЏ РІ РєСЌС€Рµ; false вЂ” СЃРѕРѕР±С‰РµРЅРёСЏ РІ РєСЌС€Рµ РЅРµС‚. */
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
     * РР·РјРµРЅРµРЅРёРµ СЃРѕСЃС‚Р°РІР°/СЂРѕР»РµР№ СѓС‡Р°СЃС‚РЅРёРєРѕРІ: С‚РѕС‡РµС‡РЅРѕ РїСЂР°РІРёРј members, myRole Рё
     * membersCount, РЅРµ РїРµСЂРµР·Р°РїСЂР°С€РёРІР°СЏ РІРµСЃСЊ СЃРїРёСЃРѕРє С‡Р°С‚РѕРІ.
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

      // РњРµРЅСЏ РёСЃРєР»СЋС‡РёР»Рё вЂ” СѓР±РёСЂР°РµРј С‡Р°С‚ РёР· РєСЌС€Р°, С‡С‚РѕР±С‹ РЅРµ РІРёСЃРµС‚СЊ РЅР° 404.
      if (type === 'chat_member_removed' && uid && uid === meId) {
        qc.setQueriesData<any[]>({ queryKey: ['chats'] }, (prev) =>
          Array.isArray(prev) ? prev.filter((c) => c?.id !== chatId) : prev,
        );
        qc.removeQueries({ queryKey: ['chat', chatId] });
        qc.removeQueries({ queryKey: ['messages', chatId] });
      } else if (cachedBefore && !Array.isArray(cachedBefore.members)) {
        // Р’ РєСЌС€Рµ С‡Р°С‚Р° РЅРµ Р±С‹Р»Рѕ СЃРїРёСЃРєР° СѓС‡Р°СЃС‚РЅРёРєРѕРІ вЂ” С‚РѕС‡РµС‡РЅРѕ РїРµСЂРµС‡РёС‚Р°РµРј С‚РѕР»СЊРєРѕ РµРіРѕ.
        void qc.invalidateQueries({ queryKey: ['chat', chatId] });
      }
    };

    /** presence/user_online: РѕР±РЅРѕРІР»СЏРµРј online Сѓ direct-С‡Р°С‚Р° Рё РїСЂРѕС„РёР»СЏ. */
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
      // РџСЂРѕС„РёР»СЊ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ, РµСЃР»Рё РѕС‚РєСЂС‹С‚: РѕР±РЅРѕРІР»СЏРµРј С‚РѕР»СЊРєРѕ РµРіРѕ.
      const username = typeof event.username === 'string' ? event.username : '';
      if (username) {
        const profile = qc.getQueryData<any>(['profile', username]);
        if (profile) qc.setQueryData(['profile', username], { ...profile, online });
      }
    };

    /** module_status: РѕР±РЅРѕРІР»СЏРµРј РёРЅРґРёРєР°С‚РѕСЂ С‚СЂР°РЅСЃРїРѕСЂС‚Р° Рё, РїСЂРё РЅРµРѕР±С…РѕРґРёРјРѕСЃС‚Рё, СѓР·Р»С‹. */
    const applyModuleStatus = (event: any) => {
      const src = event.module && typeof event.module === 'object' ? event.module : event;
      const current = useStore.getState().transportModule;
      const gateway = typeof src.gateway === 'boolean' ? src.gateway : current?.gateway;
      const model = typeof src.model === 'string' ? src.model : current?.model ?? '';
      if (typeof gateway === 'boolean') {
        useStore.getState().setTransportModule({ gateway, model });
      }
      // РЈР·Р»С‹/РјРѕРґСѓР»Рё РѕР±РЅРѕРІР»СЏРµРј С‚РѕС‡РµС‡РЅРѕ Рё С‚РѕР»СЊРєРѕ РµСЃР»Рё РѕРЅРё СѓР¶Рµ Р·Р°РіСЂСѓР¶РµРЅС‹.
      void qc.invalidateQueries({ queryKey: ['nodes'], type: 'active' });
      void qc.invalidateQueries({ queryKey: ['modules'], type: 'active' });
    };

    /** РџСЂРѕСЃРјРѕС‚СЂС‹ СЃРѕРѕР±С‰РµРЅРёСЏ: РїР°С‚С‡РёРј viewsCount РїРѕ id. */
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

    /** РњСЏРіРєРёР№ РґРѕРіРѕРЅ РїРѕСЃР»Рµ reconnect: С‚РѕР»СЊРєРѕ С‚Рѕ, С‡С‚Рѕ РјРѕРіР»Рѕ СѓСЃС‚Р°СЂРµС‚СЊ. */
    const catchUp = () => {
      void qc.invalidateQueries({ queryKey: ['chats'] });
      void qc.invalidateQueries({ queryKey: ['messages'], type: 'active' });
      void qc.invalidateQueries({ queryKey: ['requests'], type: 'active' });
      const id = activeChatId();
      if (id) void qc.invalidateQueries({ queryKey: ['chat', id] });
    };

    /** Exponential backoff 2s в†’ 30s СЃ РґР¶РёС‚С‚РµСЂРѕРј В±20%. */
    const scheduleReconnect = () => {
      if (disposed) return;
      // РќРµС‚ СЃРµС‚Рё вЂ” Р¶РґС‘Рј СЃРѕР±С‹С‚РёСЏ `online`, РЅРµ С‚СЂР°С‚РёРј РїРѕРїС‹С‚РєРё РІРїСѓСЃС‚СѓСЋ.
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
      // Р•СЃР»Рё access-token РёСЃС‚С‘Рє вЂ” РѕР±РЅРѕРІР»СЏРµРј РґРѕ РѕС‚РєСЂС‹С‚РёСЏ СЃРѕРєРµС‚Р°, РёРЅР°С‡Рµ 401.
      const token = (await ensureAccessToken()) || fallbackToken;
      if (!token) return;
      const ws = new WebSocket(wsUrl(token));
      socket = ws;
      ws.onopen = () => {
        reconnectAttempt = 0;
        useStore.getState().setTransportOnline(true);
        // Р”РѕРіРѕРЅ РїРѕСЃР»Рµ РїРµСЂРµРїРѕРґРєР»СЋС‡РµРЅРёСЏ: РїРѕРєР° СЃРІСЏР·Рё РЅРµ Р±С‹Р»Рѕ, СЃРѕР±С‹С‚РёСЏ РјРѕРіР»Рё РїРѕС‚РµСЂСЏС‚СЊСЃСЏ.
        if (!firstConnect) catchUp();
        firstConnect = false;
        void flushOutbox(useStore.getState().me?.username ?? getSession()?.username ?? '')
          .then((sent) => {
            if (!sent.length) return;
            void qc.invalidateQueries({ queryKey: ['chats'] });
          })
          .catch(() => undefined);
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
            // Р¤РѕСЂРјР°С‚ СЃРѕР±С‹С‚РёСЏ Р±РµР· messageId/С‚РµРєСЃС‚Р° вЂ” РїРµСЂРµС‡РёС‚С‹РІР°РµРј РёСЃС‚РѕСЂРёСЋ.
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
            // Р—Р°СЏРІРєР° РЅР° РІСЃС‚СѓРїР»РµРЅРёРµ: С‚РѕСЃС‚ (РјРѕР¶РЅРѕ РѕС‚РєР»СЋС‡РёС‚СЊ РІ localStorage) Рё РїР°С‚С‡ СЃРїРёСЃРєРѕРІ.
            if (isRequestsNotifyEnabled()) {
              useStore.getState().pushToast({ kind: 'info', message: 'РќРѕРІР°СЏ Р·Р°СЏРІРєР° РЅР° РІСЃС‚СѓРїР»РµРЅРёРµ РІ С‡Р°С‚' });
            }
            // РЈРјРµСЂРµРЅРЅС‹Р№ С‚Р°РєС‚РёР»СЊРЅС‹Р№ РѕС‚РєР»РёРє РЅР° РІР°Р¶РЅРѕРµ СЃРѕР±С‹С‚РёРµ (СѓРІР°Р¶Р°РµС‚ sg:haptics).
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
            // Р•СЃР»Рё СѓРґР°Р»РёР»Рё РѕС‚РєСЂС‹С‚С‹Р№ С‡Р°С‚ вЂ” СѓС…РѕРґРёРј РёР· РЅРµРіРѕ, С‡С‚РѕР±С‹ РЅРµ РІРёСЃРµС‚СЊ РЅР° 404.
            if (removedId && (current === `/chat/${removedId}` || current.startsWith(`/chat/${removedId}/`))) {
              router.replace('/chats' as never);
            }
          }
        } catch {
          /* РёРіРЅРѕСЂРёСЂСѓРµРј РЅРµРєРѕСЂСЂРµРєС‚РЅС‹Рµ С„СЂРµР№РјС‹ */
        }
      };
    };

    /** РќРµРјРµРґР»РµРЅРЅС‹Р№ reconnect РїРѕ online/visibility вЂ” Р±РµР· РѕР¶РёРґР°РЅРёСЏ backoff. */
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
    // Chrome СЂСѓРіР°РµС‚СЃСЏ В«Page entered Back-Forward CacheВ», РµСЃР»Рё РїСЂРё СѓС…РѕРґРµ СЃРѕ
    // СЃС‚СЂР°РЅРёС†С‹ РѕСЃС‚Р°С‘С‚СЃСЏ РѕС‚РєСЂС‹С‚С‹Р№ WebSocket. Р—Р°РєСЂС‹РІР°РµРј РµРіРѕ РЅР° pagehide Рё
    // РїРѕРґРЅРёРјР°РµРј Р·Р°РЅРѕРІРѕ РЅР° pageshow.
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

    // Р’ React Native РµСЃС‚СЊ РіР»РѕР±Р°Р»СЊРЅС‹Р№ window, РЅРѕ Р±РµР· addEventListener.
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

    // Р›С‘РіРєРёР№ С„РѕР»Р±СЌРє: С‚РѕР»СЊРєРѕ РїСЂРё РІРёРґРёРјРѕР№ РІРєР»Р°РґРєРµ, offline-СЃРѕРєРµС‚Рµ Рё РЅРµ С‡Р°С‰Рµ СЂР°Р·Р° РІ 30 СЃ.
    fallbackTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (useStore.getState().transportOnline) return;
      const now = Date.now();
      if (now - lastFallbackAt < 30_000) return;
      lastFallbackAt = now;
      void qc.invalidateQueries({ queryKey: ['chats'] });
    }, 30_000);

    void connect(session.accessToken);

    // Р’С…РѕРґСЏС‰РёРµ С‡РµСЂРµР· РјРѕРґСѓР»СЊ: РѕР±СЂР°Р±Р°С‚С‹РІР°РµРј РєР°Рє WS-СЃРѕР±С‹С‚РёРµ С‚РѕР»СЊРєРѕ РєРѕРіРґР°
    // РёРЅС‚РµСЂРЅРµС‚Р° РЅРµС‚, РёРЅР°С‡Рµ СЃРµСЂРІРµСЂ РґРѕСЃС‚Р°РІРёС‚ РёС… СЃР°Рј (Рё Р±СѓРґРµС‚ РґСѓР±Р»СЊ).
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
            senderUsername: item.senderUsername || 'РњРѕРґСѓР»СЊ',
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

    // РРЅРєСЂРµРјРµРЅС‚Р°Р»СЊРЅС‹Р№ РїР°С‚С‡ РёСЃС‚РѕСЂРёРё: РѕРїС‚РёРјРёСЃС‚РёС‡РЅРѕРµ СЃРѕРѕР±С‰РµРЅРёРµ Р·Р°РјРµРЅСЏРµРј РїРѕ id/clientId.
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
        // РќРѕРІРѕРµ СЃРѕРѕР±С‰РµРЅРёРµ РЅСѓР¶РЅРѕ СЂР°СЃС€РёС„СЂРѕРІР°С‚СЊ вЂ” С‚РѕС‡РµС‡РЅС‹Р№ refetch СЌС‚РѕРіРѕ С‡Р°С‚Р°.
        void queryClient.invalidateQueries({ queryKey: ['messages', env.chatId] });
      }
    }

    // РЎРїРёСЃРѕРє С‡Р°С‚РѕРІ РїР°С‚С‡РёРј Р±РµР· РїРѕР»РЅРѕРіРѕ refetch: РїСЂРµРІСЊСЋ, РІСЂРµРјСЏ, РЅРµРїСЂРѕС‡РёС‚Р°РЅРЅС‹Рµ.
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

    // РєРІРёС‚Р°РЅС†РёСЏ РЅРµ С‚СЂРµР±СѓРµС‚ РєР»СЋС‡Р°: СЃРµСЂРІРµСЂРЅС‹Рµ Рё E2E-С‡Р°С‚С‹ РґРѕСЃС‚Р°РІР»СЏСЋС‚СЃСЏ РѕРґРёРЅР°РєРѕРІРѕ
    if (env.senderUserId && meId && env.senderUserId !== meId) {
      // РўРёС…РѕРµ В«РґРёРЅВ» Рё Р»С‘РіРєР°СЏ РІРёР±СЂР°С†РёСЏ РґР»СЏ РІС…РѕРґСЏС‰РёС…, РєСЂРѕРјРµ РїСЂРёРіР»СѓС€С‘РЅРЅС‹С… С‡Р°С‚РѕРІ.
      if (!useStore.getState().mutedChats.includes(env.chatId)) {
        const mutedUser = useStore
          .getState()
          .mutedUsers.includes(String(env.senderUsername ?? '').toLowerCase());
        if (!mutedUser) {
          soundsRef.current.receive();
          hapticsRef.current.receive();
        }
        if (activeId !== env.chatId) {
          // Уведомление внутри приложения — только если этот чат не открыт.
          const meName = useStore.getState().me?.username ?? '';
          const chat =
            queryClient.getQueryData<any>(['chat', env.chatId]) ??
            findCachedChat(meName, env.chatId) ??
            ({ id: env.chatId, type: 'direct', encryption: 'server', title: '', members: [] } as any);
          let text = '';
          try {
            const vm = await decryptEnvelopeAuto(env as never, chat as never, meName);
            text = String(vm.text ?? '').trim();
          } catch {
            text = '';
          }
          const title =
            chat?.type === 'direct'
              ? String(env.senderUsername || chat?.title || 'Сообщение')
              : String(chat?.title || env.senderUsername || 'Сообщение');
          useStore.getState().pushInApp({
            kind: 'message',
            chatId: env.chatId,
            messageId: env.id,
            title,
            body: text || (env.kind === 'text' ? 'Новое сообщение' : 'Вложение'),
          });
        }
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

  // РќР°РІРёРіР°С†РёРѕРЅРЅР°СЏ С‚РµРјР°: С„РѕРЅ РїСЂРѕР·СЂР°С‡РЅС‹Р№, С‡С‚РѕР±С‹ РµРґРёРЅСЃС‚РІРµРЅРЅС‹Рј СЃР»РѕРµРј Р±С‹Р» <body>.
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
      // РђРєС†РµРЅС‚РЅР°СЏ РїР°Р»РёС‚СЂР° С…СЂР°РЅРёС‚СЃСЏ РѕС‚РґРµР»СЊРЅРѕ РѕС‚ С‚РµРјС‹; РЅРµРёР·РІРµСЃС‚РЅРѕРµ Р·РЅР°С‡РµРЅРёРµ РёРіРЅРѕСЂРёСЂСѓРµРј.
      const savedAccent = await kv.get('sg:accent');
      if (savedAccent && savedAccent in ACCENTS) useStore.getState().setAccent(savedAccent as AccentName);
      // РЇР·С‹Рє РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ Р±РµСЂС‘Рј Р»РѕРєР°Р»СЊРЅС‹Р№; СЃРµСЂРІРµСЂРЅС‹Рµ РЅР°СЃС‚СЂРѕР№РєРё РїСЂРёРјРµРЅСЏС‚СЃСЏ РЅРёР¶Рµ.
      const savedLocale = await kv.get('sg:locale');
      if (savedLocale) useStore.getState().setLocale(savedLocale);
      const s = await initSession();
      // РЎРЅР°С‡Р°Р»Р° РїРѕРґРЅРёРјР°РµРј Р»РѕРєР°Р»СЊРЅС‹Р№ РєСЌС€: РёРЅС‚РµСЂС„РµР№СЃ РґРѕР»Р¶РµРЅ СЂРёСЃРѕРІР°С‚СЊСЃСЏ СЃСЂР°Р·Сѓ,
      // Р±РµР· РѕР¶РёРґР°РЅРёСЏ СЃРµС‚Рё. Р—Р°С‚РµРј СѓР¶Рµ РґРѕРіСЂСѓР¶Р°РµРј СЃРµСЂРІРµСЂРЅС‹Рµ РґР°РЅРЅС‹Рµ РІ С„РѕРЅРµ.
      await loadCaches(s?.username ?? null).catch(() => undefined);
      useStore.getState().setSession(s);      // РџСЂРѕС„РёР»СЊ РёР· РєСЌС€Р° РґРѕСЃС‚СѓРїРµРЅ СЃСЂР°Р·Сѓ: Р±РµР· РЅРµРіРѕ СЃРїРёСЃРєРё С‡Р°С‚РѕРІ Рё РЅР°СЃС‚СЂРѕР№РєРё
      // РѕСЃС‚Р°РІР°Р»РёСЃСЊ Р±С‹ РїСѓСЃС‚С‹РјРё РґРѕ РѕС‚РІРµС‚Р° СЃРµСЂРІРµСЂР°.
      const cachedMe = getCachedMe();
      if (s && cachedMe) useStore.getState().setMe(cachedMe);
      // РџСЂРёРіР»СѓС€С‘РЅРЅС‹Рµ С‡Р°С‚С‹ Р¶РёРІСѓС‚ Р»РѕРєР°Р»СЊРЅРѕ Рё РЅРµ Р·Р°РІРёСЃСЏС‚ РѕС‚ СЃРµСЂРІРµСЂР°.
      void useStore.getState().hydrateMuted();
      void useStore.getState().hydrateMutedUsers();
      // Р’РђР–РќРћ: РїСЂРёР»РѕР¶РµРЅРёРµ РіРѕС‚РѕРІРѕ Рє СЂР°Р±РѕС‚Рµ СЃСЂР°Р·Сѓ РїРѕСЃР»Рµ С‡С‚РµРЅРёСЏ Р»РѕРєР°Р»СЊРЅРѕР№ СЃРµСЃСЃРёРё.
      // РЎРµС‚СЊ (api.me, refresh) РґРѕРіСЂСѓР¶Р°РµС‚СЃСЏ РІ С„РѕРЅРµ вЂ” Р±РµР· РёРЅС‚РµСЂРЅРµС‚Р° Р·Р°РїСѓСЃРє РЅРµ Р±Р»РѕРєРёСЂСѓРµС‚СЃСЏ.
      useStore.getState().setReady(true);
      setReady(true);
      void loadProfileCaches();
      // Ленты чатов — в память заранее, чтобы открытие чата не показывало скелетоны.
      void preloadMessageCaches();
      initPreferenceSync();

      if (s) {
        void (async () => {
          try {
            const u = await api.me();
            useStore.getState().setMe(u);
            // РќР°СЃС‚СЂРѕР№РєРё СЃ СЃРµСЂРІРµСЂР° РїСЂРёРјРµРЅСЏРµРј Р±РµР· РѕС‚РїСЂР°РІРєРё РѕР±СЂР°С‚РЅРѕ.
            applyServerPreferences(u);
          } catch (meError) {
            // РїСЂРѕС‚СѓС…С€РёР№ access вЂ” РїСЂРѕР±СѓРµРј refresh
            try {
              const s2 = getSession();
              if (!s2) throw new Error('no-session');
              const r = await api.refresh(s2.refreshToken);
              await setSession({ ...s2, accessToken: r.accessToken, refreshToken: r.refreshToken, accessExp: Date.now() + r.expiresIn * 1000 });
              const u2 = await api.me();
              useStore.getState().setMe(u2);
              applyServerPreferences(u2);
            } catch (refreshError) {
              // РќРРљРћР“Р”Рђ РЅРµ СЃР±СЂР°СЃС‹РІР°РµРј СЃРµСЃСЃРёСЋ Р°РІС‚РѕРјР°С‚РёС‡РµСЃРєРё: Р±РµР· РёРЅС‚РµСЂРЅРµС‚Р°
              // РїРѕР»СЊР·РѕРІР°С‚РµР»СЊ РїСЂРѕРґРѕР»Р¶Р°РµС‚ РѕР±С‰Р°С‚СЊСЃСЏ С‡РµСЂРµР· РїРѕРґРєР»СЋС‡С‘РЅРЅС‹Р№ РјРѕРґСѓР»СЊ.
              // Р’С‹С…РѕРґ РёР· Р°РєРєР°СѓРЅС‚Р° вЂ” С‚РѕР»СЊРєРѕ РІСЂСѓС‡РЅСѓСЋ РІ РЅР°СЃС‚СЂРѕР№РєР°С….
              void refreshError;
            }
          }
        })();
      }
    })();
  }, []);

  useEffect(() => {
    if (!sessionState) return undefined;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void initPush({
      deviceId: sessionState.deviceId,
      userId: sessionState.userId,
      accessToken: sessionState.accessToken,
    } as never)
      .then((stop) => {
        if (cancelled) stop?.();
        else cleanup = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [sessionState?.userId, sessionState?.deviceId]);

  useEffect(() => {
    if (!ready) return;
    const inAuth = segments.length === 0 || segments[0] === 'auth' || segments[0] === '(auth)';
    const isJoin = segments[0] === 'join';
    const hasSession = Boolean(sessionState) || getSession() !== null;
    const nextPath = typeof params.next === 'string' && params.next.startsWith('/') ? params.next : '/chats';

    // РћРґРёРЅ РїРµСЂРµС…РѕРґ Р·Р° СЂР°Р·: РїРѕРІС‚РѕСЂРЅС‹Р№ replace РІРѕ РІСЂРµРјСЏ Р°РЅРёРјР°С†РёРё РЅР°С‚РёРІРЅРѕРіРѕ
    // СЃС‚РµРєР° РјРѕРі РїСЂРёРІРµСЃС‚Рё Рє Р·Р°РІРёСЃР°РЅРёСЋ РёРЅС‚РµСЂС„РµР№СЃР° РїРѕСЃР»Рµ РІС…РѕРґР°/СЂРµРіРёСЃС‚СЂР°С†РёРё.
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
        {/* РњРѕРґСѓР»СЊ РІРѕСЃСЃС‚Р°РЅР°РІР»РёРІР°РµС‚СЃСЏ СЃР°Рј РїСЂРё Р·Р°РїСѓСЃРєРµ; РЅР° СЌРєСЂР°РЅРµ Р»РѕРіРёРЅР° РЅРµ СЃРєР°РЅРёСЂСѓРµС‚. */}
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
                <Stack.Screen name="join/[token]" options={{ animation: 'slide_from_bottom', gestureEnabled: true, fullScreenGestureEnabled: true }} />
              </Stack>
              {!ready ? <FullSkeleton /> : null}
              <ModuleAutoBanner />
              <InAppNotifications />
              <ToastHost />
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
        <Text style={{ color: theme.textPrimary, fontSize: 22, fontWeight: '800', letterSpacing: 0.3 }}>Kinto</Text>
        <Text style={{ color: theme.textSecondary, fontSize: 12.5, fontWeight: '600' }}>{APP_VERSION_LABEL}</Text>
        <View style={{ marginTop: 8 }}>
          <ActivityIndicator color={theme.accent} />
        </View>
        <Text style={{ color: theme.textDisabled, fontSize: 11 }}>РџСЂРѕРІРµСЂСЏРµРј СЃРµСЃСЃРёСЋвЂ¦</Text>
      </MotiView>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
});
