import { create } from 'zustand';
import { kv } from '../crypto/storage';
import { saveChatPreview, type ChatPreview } from '../data/cache';
import type { Chat, SearchHistoryEntry, User } from '../data/api';
import type { AccentName } from '../theme/theme';

export type ThemeName = 'dark' | 'light' | 'system';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  message: string;
  actionLabel?: string;
  action?: () => void;
  durationMs?: number;
}

/** Плавающее уведомление внутри приложения (сообщение или системное). */
export interface InAppNotice {
  id: string;
  kind: 'message' | 'system';
  chatId?: string;
  messageId?: string;
  title: string;
  body: string;
  createdAt: number;
}

interface SessionSummary {
  userId: string;
  username: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  accessExp: number;
}

interface AppState {
  themeName: ThemeName;
  setThemeName: (t: ThemeName) => void;
  accentName: AccentName;
  setAccent: (name: AccentName) => void;
  /** Язык интерфейса (синхронизируется через /me). */
  locale: string;
  setLocale: (locale: string) => void;
  transportOnline: boolean;
  setTransportOnline: (v: boolean) => void;
  /**
   * Известно ли реальное состояние WebSocket. В первые секунды после запуска
   * до открытия/ошибки сокета транспорт «неизвестен» — тогда отправка даёт
   * HTTP короткое окно и уходит в mesh, а не висит 12 с.
   */
  transportKnown: boolean;
  setTransportKnown: (v: boolean) => void;
  /** Пришли ли входящие данные через mesh хотя бы раз за сессию. */
  meshIncomingActive: boolean;
  setMeshIncomingActive: (v: boolean) => void;
  transportDirectPeer: boolean;
  setTransportDirectPeer: (v: boolean) => void;
  transportModule: { gateway: boolean; model: string } | null;
  setTransportModule: (m: { gateway: boolean; model: string } | null) => void;
  /** Есть ли путь к серверам через mesh-шлюз. */
  transportGateway: boolean;
  setTransportGateway: (v: boolean) => void;
  /** Пользователи, видимые в mesh (profile presence). */
  meshPeers: Record<string, { userId: string; username: string; publicId?: string; lastSeen: number }>;
  setMeshPeer: (peer: { userId: string; username: string; publicId?: string }) => void;
  /** Найденные рядом носимые модули (для предложения подключения). */
  nearbyModules: { id: string; name: string; rssi: number; seenAt: number }[];
  setNearbyModules: (list: { id: string; name: string; rssi: number }[]) => void;
  pushEvent: { kind: string; payload: any } | null;
  setPushEvent: (e: { kind: string; payload: any } | null) => void;
  session: SessionSummary | null;
  setSession: (s: SessionSummary | null) => void;
  ready: boolean;
  setReady: (v: boolean) => void;
  me: User | null;
  setMe: (u: User | null) => void;
  activeChat: Chat | null;
  setActiveChat: (c: Chat | null) => void;
  typingByChat: Record<string, { username: string; at: number }>;
  setTyping: (chatId: string, username: string) => void;
  /** Чаты без звука и без бейджа непрочитанных. */
  mutedChats: string[];
  toggleMuted: (chatId: string) => void;
  hydrateMuted: () => Promise<void>;
  /** Пользователи, от которых не показываем звук/вибрацию. */
  mutedUsers: string[];
  toggleMutedUser: (username: string) => void;
  hydrateMutedUsers: () => Promise<void>;
  /** Серверная история поиска (последние 20); персист и синк — в preferences.ts. */
  searchHistory: SearchHistoryEntry[];
  setSearchHistory: (entries: SearchHistoryEntry[]) => void;
  toasts: Toast[];
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  /** In-app уведомления: показываются, только если чат сейчас не открыт. */
  inApp: InAppNotice[];
  pushInApp: (n: Omit<InAppNotice, 'id' | 'createdAt'>) => void;
  dismissInApp: (id: string) => void;
  dismissAllInApp: () => void;
  /** Расшифрованные превью последних сообщений для списка чатов. */
  chatPreviews: Record<string, ChatPreview>;
  hydrateChatPreviews: (previews: Record<string, ChatPreview>) => void;
  setChatPreview: (chatId: string, preview: ChatPreview) => void;
}

export const useStore = create<AppState>((set, get) => ({
  themeName: 'system',
  setThemeName: (themeName) => {
    set({ themeName });
    void kv.set('sg:theme', themeName);
  },
  accentName: 'orange',
  setAccent: (accentName) => {
    set({ accentName });
    void kv.set('sg:accent', accentName);
  },
  locale: 'ru',
  setLocale: (locale) => {
    set({ locale });
    // Дублируем в kv для совместимости и мгновенного старта до ответа сервера.
    void kv.set('sg:locale', locale).catch(() => undefined);
  },
  transportOnline: false,
  setTransportOnline: (transportOnline) => set({ transportOnline }),
  transportKnown: false,
  setTransportKnown: (transportKnown) => set({ transportKnown }),
  meshIncomingActive: false,
  setMeshIncomingActive: (meshIncomingActive) => set({ meshIncomingActive }),
  transportDirectPeer: false,
  setTransportDirectPeer: (transportDirectPeer) => set({ transportDirectPeer }),
  transportModule: null,
  setTransportModule: (transportModule) => set({ transportModule }),
  transportGateway: false,
  setTransportGateway: (transportGateway) => set({ transportGateway }),
  meshPeers: {},
  setMeshPeer: (peer) => {
    if (!peer?.username) return;
    set({ meshPeers: { ...get().meshPeers, [peer.username.toLowerCase()]: { ...peer, lastSeen: Date.now() } } });
  },
  nearbyModules: [],
  setNearbyModules: (list) =>
    set({
      nearbyModules: (Array.isArray(list) ? list : []).map((item) => ({ ...item, seenAt: Date.now() })),
    }),
  pushEvent: null,
  setPushEvent: (pushEvent) => set({ pushEvent }),
  session: null,
  setSession: (session) => set({ session }),
  ready: false,
  setReady: (ready) => set({ ready }),
  me: null,
  setMe: (me) => set({ me }),
  activeChat: null,
  setActiveChat: (activeChat) => set({ activeChat }),
  typingByChat: {},
  setTyping: (chatId, username) =>
    set({ typingByChat: { ...get().typingByChat, [chatId]: { username, at: Date.now() } } }),
  mutedChats: [],
  toggleMuted: (chatId) => {
    const prev = get().mutedChats;
    const next = prev.includes(chatId) ? prev.filter((id) => id !== chatId) : [...prev, chatId];
    set({ mutedChats: next });
    // Персистим в kv; ошибки хранилища не должны ломать UI.
    void kv.set('sg:muted-chats', JSON.stringify(next)).catch(() => undefined);
  },
  hydrateMuted: async () => {
    try {
      const raw = await kv.get('sg:muted-chats');
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        set({ mutedChats: parsed.filter((id): id is string => typeof id === 'string') });
      }
    } catch {
      /* повреждённое значение игнорируем */
    }
  },
  mutedUsers: [],
  toggleMutedUser: (username) => {
    const name = username.trim().toLowerCase();
    if (!name) return;
    const prev = get().mutedUsers;
    const next = prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name];
    set({ mutedUsers: next });
    void kv.set('sg:muted-users', JSON.stringify(next)).catch(() => undefined);
  },
  hydrateMutedUsers: async () => {
    try {
      const raw = await kv.get('sg:muted-users');
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        set({ mutedUsers: parsed.filter((name): name is string => typeof name === 'string') });
      }
    } catch {
      /* повреждённое значение игнорируем */
    }
  },
  searchHistory: [],
  // Только set: запись в kv и отправку на сервер делает preferences.ts.
  setSearchHistory: (searchHistory) => set({ searchHistory }),
  toasts: [],
  pushToast: (t) => {
    const id = `t-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    // Новые уведомления сверху, одновременно не больше четырёх.
    // Авто-скрытие и паузу таймера ведёт ToastHost (reduced-motion friendly).
    set({ toasts: [{ ...t, id }, ...get().toasts].slice(0, 4) });
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  inApp: [],
  pushInApp: (notice) => {
    // Одна карточка на чат: новое сообщение заменяет предыдущее.
    const id = `n-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const rest = notice.chatId
      ? get().inApp.filter((item) => item.chatId !== notice.chatId)
      : get().inApp;
    set({ inApp: [{ ...notice, id, createdAt: Date.now() }, ...rest].slice(0, 3) });
  },
  dismissInApp: (id) => set({ inApp: get().inApp.filter((n) => n.id !== id) }),
  dismissAllInApp: () => set({ inApp: [] }),
  chatPreviews: {},
  hydrateChatPreviews: (chatPreviews) => set({ chatPreviews }),
  setChatPreview: (chatId, preview) => {
    set({ chatPreviews: { ...get().chatPreviews, [chatId]: preview } });
    saveChatPreview(get().me?.username, chatId, preview);
  },
}));

setTimeout(() => void kv.get('sg:theme').then?.((v: string | null) => {
  // инициализация темы подхватывается в RootLayout — здесь только типы
  void v;
}), 0);
