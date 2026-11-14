/**
 * Экран «Чаты»: единый Telegram-подобный список, богатый поиск с фильтрами,
 * история запросов, архив, мультивыбор и контекстное меню.
 *
 * Все данные — реальные: пользователи ищутся через /users/search, группы и
 * каналы — через серверный поиск, сообщения — по последним 40 сообщениям
 * каждого чата (клиентская расшифровка). Фейковых строк нет.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,

  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import { MotiView } from 'moti';
import { useTheme } from '../../src/theme/useTheme';
import { useIsWide } from '../../src/theme/useIsWide';
import * as api from '../../src/data/api';
import type { Chat } from '../../src/data/api';
import {
  useArchivedChats,
  useChats,
  useChannels,
  useMe,
  useMySubscriptions,
  useSearchUsers,
  useStats,
  humanError,
  prefetchChat,
} from '../../src/data/queries';
import { loadChatMessages, searchMessagesAcrossChats, type MessageSearchHit } from '../../src/data/messaging';
import { saveMessages } from '../../src/data/cache';
import { Avatar } from '../../src/components/Avatar';
import { EmptyState } from '../../src/components/EmptyState';
import { SkeletonChatList } from '../../src/components/skeletons/Skeleton';
import { HeaderCreateMenu } from '../../src/components/HeaderCreateMenu';
import { ModuleStatusPill } from '../../src/components/ModuleStatusPill';
import { ConnectionPill, useConnectionPhase } from '../../src/components/ConnectionStatus';
import { kv } from '../../src/crypto/storage';
import { PressableScale } from '../../src/components/chat/PressableScale';
import { ChatContextMenu } from '../../src/components/chat/ChatContextMenu';
import { SelectionToolbar } from '../../src/components/chat/SelectionToolbar';
import { ConfirmDialog } from '../../src/components/chat/ConfirmDialog';
import { FlashList } from '@shopify/flash-list';
import { prefetchTopChats } from '../../src/storage/messages';
import { motion } from '../../src/theme/motion';
import { useHaptics } from '../../src/components/useHaptics';
import { useReducedMotion } from '../../src/components/useReducedMotion';
import { useStore } from '../../src/state/useStore';
import { hasNetworkAccess } from '../../src/data/access';
import { onReadAllRequest } from '../../src/state/chatEvents';
import { dbGet, dbSet } from '../../src/data/db';
import { useSearchGroupsSafe, type GroupSearchItem } from '../../src/components/chatinfo/ManageData';
import { hasRight, visibilityLabel, normalizeVisibility } from '../../src/components/chatinfo/ManageTypes';

/* ------------------------------------------------------------------ утилиты */

const HISTORY_KEY = 'sg:search-history';
const HISTORY_LIMIT = 8;

/** Скрытие панели поиска при скролле списка: порог и шаг, чтобы не дёргалось. */
const SEARCH_HIDE_AFTER = 100;
const SEARCH_HIDE_DELTA = 8;
const SEARCH_SCROLL_THROTTLE_MS = 80;

const timeAgo = (iso: string): string => {
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return '';
  const min = Math.floor((Date.now() - d) / 60_000);
  if (min < 1) return 'сейчас';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч`;
  if (h < 48) return 'вчера';
  const dd = new Date(d);
  return `${dd.getDate()}.${dd.getMonth() + 1}`;
};

const activityOf = (c: Chat): number => {
  const raw = c.lastMessage?.createdAt || c.updatedAt || c.createdAt;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
};

const titleOf = (chat: Chat, myUsername: string): string => {
  if (chat.type !== 'direct') return chat.title;
  const peer = chat.members.find((m) => m.username !== myUsername);
  return peer?.displayName || peer?.username || chat.title;
};

const peerOf = (chat: Chat, myUsername: string) =>
  chat.type === 'direct' ? chat.members.find((m) => m.username !== myUsername) : undefined;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * История поиска: записи-результаты (человек/чат/группа/канал/сообщение),
 * чтобы панель показывала аватар и открывала тот же экран.
 * Основное хранилище — useStore.searchHistory (синхронизируется через
 * preferences). Старый localStorage `sg:search-history` читаем как fallback.
 */
// 'query' хранится как type='chat' с id-префиксом: так запись проходит
// серверную валидацию SearchHistoryEntry и синхронизируется через preferences.
type SearchHistoryType = 'user' | 'chat' | 'group' | 'channel' | 'message';

interface SearchHistoryEntry {
  type: SearchHistoryType;
  id: string;
  title: string;
  subtitle?: string;
  username?: string;
  avatar?: api.AvatarInfo | null;
  /** Метка времени: число (мс) в новом формате, ISO-строка — в старом. */
  at: number | string;
}

const entryTime = (at: number | string): number => {
  if (typeof at === 'number') return at;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : 0;
};

const isHistoryEntry = (value: unknown): value is SearchHistoryEntry => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.type === 'string' && typeof v.id === 'string' && typeof v.title === 'string';
};

const readLegacyHistory = (): SearchHistoryEntry[] => {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const items: SearchHistoryEntry[] = [];
    for (const item of parsed) {
      if (typeof item === 'string' && item.trim()) {
        // Совсем старый формат — просто строки запросов.
        items.push({
          type: 'chat',
          id: `query:${item.trim().toLowerCase()}`,
          title: item.trim(),
          subtitle: 'Поисковый запрос',
          at: new Date(0).toISOString(),
        });
      } else if (isHistoryEntry(item)) {
        items.push(item);
      }
    }
    return items.slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
};

const writeHistory = (items: SearchHistoryEntry[]): void => {
  try {
    const raw = items.length ? JSON.stringify(items) : '';
    if (typeof localStorage !== 'undefined') {
      if (!items.length) localStorage.removeItem(HISTORY_KEY);
      else localStorage.setItem(HISTORY_KEY, raw);
    }
    // На native localStorage нет: история должна переживать перезапуск.
    if (raw) void kv.set(HISTORY_KEY, raw).catch(() => undefined);
    else void kv.remove(HISTORY_KEY).catch(() => undefined);
  } catch {
    /* приватный режим / квота — просто не сохраняем */
  }
};

/** Записать историю в store; метод появляется от параллельного агента. */
const syncHistoryToStore = (items: SearchHistoryEntry[]): void => {
  try {
    const fn = (useStore.getState() as unknown as { setSearchHistory?: (v: SearchHistoryEntry[]) => void }).setSearchHistory;
    if (typeof fn === 'function') fn(items);
  } catch {
    /* store ещё без searchHistory — остаётся localStorage */
  }
};

const historyTypeLabel: Record<SearchHistoryType, string> = {
  user: 'Человек',
  chat: 'Чат',
  group: 'Группа',
  channel: 'Канал',
  message: 'Сообщение',
};

const infoUrlOf = (g: GroupSearchItem): string => {
  const qs = [
    `title=${encodeURIComponent(g.title)}`,
    `type=${encodeURIComponent(g.type)}`,
    `visibility=${encodeURIComponent(g.visibility)}`,
    `members=${encodeURIComponent(String(g.membersCount ?? 0))}`,
    g.description ? `description=${encodeURIComponent(g.description)}` : '',
  ]
    .filter(Boolean)
    .join('&');
  return `/chat/${g.id}/info?${qs}`;
};

/* -------------------------------------------------------------- типы строк */

type ChatListRow = { kind: 'section'; title: string; count?: number } | { kind: 'chat'; chat: Chat };

interface SearchUser {
  id: string;
  username: string;
  displayName: string;
  avatar?: api.AvatarInfo | null;
  nodeOnline?: boolean;
  moduleOnline?: boolean;
}

type SearchRow =
  | { kind: 'section'; title: string; count: number }
  | { kind: 'chat'; chat: Chat }
  | { kind: 'user'; user: SearchUser; mutual: number }
  | { kind: 'group'; group: GroupSearchItem }
  | { kind: 'message'; hit: MessageSearchHit };

type SearchFilter = 'all' | 'people' | 'chats' | 'groups' | 'channels' | 'messages';

const FILTERS: { key: SearchFilter; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'all', label: 'Все', icon: 'apps' },
  { key: 'people', label: 'Люди', icon: 'people' },
  { key: 'chats', label: 'Чаты', icon: 'chatbubbles' },
  { key: 'groups', label: 'Группы', icon: 'people-circle' },
  { key: 'channels', label: 'Каналы', icon: 'megaphone' },
  { key: 'messages', label: 'Сообщения', icon: 'chatbox-ellipses' },
];

/** Стабильный ключ основного списка чатов. */
function chatListKey(r: ChatListRow, i: number): string {
  return r.kind === 'section' ? `s${i}-${r.title}` : r.chat.id;
}
const rowKey = (r: SearchRow): string => {
  if (r.kind === 'section') return `s:${r.title}`;
  if (r.kind === 'chat') return `c:${r.chat.id}`;
  if (r.kind === 'user') return `u:${r.user.id}:${r.user.username}`;
  if (r.kind === 'group') return `g:${r.group.id}`;
  return `m:${r.hit.chatId}:${r.hit.message.id}`;
};

/* ---------------------------------------------------- поиск по сообщениям */

/**
 * Поиск сообщений по чатам с прогрессом. `searchMessagesAcrossChats` сам
 * обрабатывает один чат за вызов, поэтому вызываем его порциями — так видно,
 * сколько чатов уже проверено, и можно отменить устаревший запрос.
 */
function useMessageSearch(chats: Chat[], query: string, myUsername: string, enabled = true) {
  const [state, setState] = useState<{ loading: boolean; progress: number; hits: MessageSearchHit[] }>({
    loading: false,
    progress: 0,
    hits: [],
  });

  useEffect(() => {
    const q = query.trim();
    if (!enabled || q.length < 2 || !chats.length) {
      setState({ loading: false, progress: 0, hits: [] });
      return;
    }

    let cancelled = false;
    // Сразу показываем прогресс: между вводом и стартом расшифровки нет «пустоты».
    setState({ loading: true, progress: 0, hits: [] });
    const timer = setTimeout(() => {
      void (async () => {
        // не разрастаемся бесконечно: самые активные чаты уже сверху
        const list = [...chats].sort((a, b) => activityOf(b) - activityOf(a)).slice(0, 60);
        const acc: MessageSearchHit[] = [];
        for (let i = 0; i < list.length; i += 1) {
          if (cancelled) return;
          try {
            const part = await searchMessagesAcrossChats([list[i]], q, myUsername, 40);
            acc.push(...part);
          } catch {
            /* один чат не расшифровался — продолжаем */
          }
          if (cancelled) return;
          const sorted = [...acc].sort(
            (a, b) => new Date(b.message.createdAt).getTime() - new Date(a.message.createdAt).getTime(),
          );
          setState({ loading: true, progress: (i + 1) / list.length, hits: sorted });
        }
        if (!cancelled) {
          const sorted = [...acc].sort(
            (a, b) => new Date(b.message.createdAt).getTime() - new Date(a.message.createdAt).getTime(),
          );
          setState({ loading: false, progress: 1, hits: sorted });
        }
      })();
    }, 380);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [chats, query, myUsername, enabled]);

  return state;
}

/* ------------------------------------------------------------- подсветка */

function Highlight({
  text,
  query,
  color,
  accent,
  accentSoft,
  numberOfLines = 2,
}: {
  text: string;
  query: string;
  color: string;
  accent: string;
  accentSoft: string;
  numberOfLines?: number;
}) {
  const q = query.trim();
  if (!q) {
    return (
      <Text style={{ color }} numberOfLines={numberOfLines}>
        {text}
      </Text>
    );
  }
  const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, 'ig'));
  return (
    <Text style={{ color }} numberOfLines={numberOfLines}>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <Text key={i} style={{ backgroundColor: accentSoft, color: accent, fontWeight: '700' }}>
            {part}
          </Text>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </Text>
  );
}

/* ------------------------------------------------------------- свайп-ряд */

const ACTION_WIDTH = 76;
const ACTIONS_WIDTH = ACTION_WIDTH * 3;

const SWIPE_SPRING = {
  damping: motion.softSpring.damping,
  stiffness: motion.softSpring.stiffness,
  mass: motion.softSpring.mass,
};

/** Ряд чата со свайпом влево: закрепить, без звука, удалить. Только смартфон. */
function SwipeChatRow(props: {
  chat: Chat;
  title: string;
  myUsername: string;
  unread: number;
  pinned: boolean;
  muted: boolean;
  open: boolean;
  onOpenChange: (id: string | null) => void;
  onTogglePin: () => void;
  onToggleMute: () => void;
  onDelete: () => void;
  onOpen: () => void;
  onMenu: () => void;
  /** Начался горизонтальный свайп — отменяем отложенное закрытие. */
  onSwipeStart?: () => void;
  /** Свайп завершён (release/terminate). */
  onSwipeEnd?: () => void;
}) {
  const { chat, title, myUsername, unread, pinned, muted, open, onOpenChange, onTogglePin, onToggleMute, onDelete, onOpen, onMenu, onSwipeStart, onSwipeEnd } = props;
  const theme = useTheme();
  const haptics = useHaptics();
  const reduced = useReducedMotion();
  const swipeRef = useRef<Swipeable>(null);
  const idRef = useRef(chat.id);

  const close = useCallback(() => {
    swipeRef.current?.close();
  }, []);

  useEffect(() => {
    if (open) swipeRef.current?.openRight();
    else swipeRef.current?.close();
  }, [open]);

  // Смена закрепления переносит ряд в другую секцию: закрываем свайп,
  // чтобы открытые действия не «переезжали» вместе с чатом.
  const pinnedRef = useRef(pinned);
  useEffect(() => {
    if (pinnedRef.current === pinned) return;
    pinnedRef.current = pinned;
    close();
    onOpenChange(null);
  }, [pinned, close, onOpenChange]);

  const runAction = (fn: () => void) => {
    haptics.tap();
    fn();
    close();
    onOpenChange(null);
  };

  const leave = (chat.type === 'group' || chat.type === 'channel') && chat.myRole !== 'owner';
  const dangerLabel = leave ? 'Выйти' : 'Удалить';
  const dangerA11y = leave ? `Выйти из чата ${title}` : `Удалить чат ${title}`;

  return (
    <Swipeable
      ref={swipeRef}
      friction={2}
      rightThreshold={ACTIONS_WIDTH * 0.3}
      overshootRight={false}
      renderRightActions={() => (
        <View style={styles.swipeActions}>
          <Pressable
            onPress={() => runAction(onTogglePin)}
            accessibilityRole="button"
            accessibilityLabel={pinned ? 'Открепить чат' : 'Закрепить чат'}
            style={({ pressed }) => [styles.swipeAction, { backgroundColor: theme.accentSoft, opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name={pinned ? 'pin-outline' : 'pin'} size={18} color={theme.accent} />
            <Text style={{ color: theme.accent, fontSize: 10.5, fontWeight: '600', marginTop: 3 }}>
              {pinned ? 'Открепить' : 'Закрепить'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => runAction(onToggleMute)}
            accessibilityRole="button"
            accessibilityLabel={muted ? 'Включить звук' : 'Без звука'}
            style={({ pressed }) => [styles.swipeAction, { backgroundColor: theme.surfacePressed, opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name={muted ? 'volume-high-outline' : 'notifications-off-outline'} size={18} color={theme.textSecondary} />
            <Text style={{ color: theme.textSecondary, fontSize: 10.5, fontWeight: '600', marginTop: 3 }}>
              {muted ? 'Со звуком' : 'Без звука'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => runAction(onDelete)}
            accessibilityRole="button"
            accessibilityLabel={dangerA11y}
            style={({ pressed }) => [styles.swipeAction, { backgroundColor: theme.dangerSoft, opacity: pressed ? 0.7 : 1 }]}
          >
            <Ionicons name={leave ? 'exit-outline' : 'trash-outline'} size={18} color={theme.danger} />
            <Text style={{ color: theme.danger, fontSize: 10.5, fontWeight: '600', marginTop: 3 }}>{dangerLabel}</Text>
          </Pressable>
        </View>
      )}
      onSwipeableWillOpen={() => {
        if (Platform.OS !== 'web') {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        }
        haptics.tap();
        onSwipeStart?.();
        onOpenChange(chat.id);
      }}
      onSwipeableWillClose={() => {
        onOpenChange(null);
        onSwipeEnd?.();
      }}
      containerStyle={styles.swipeWrap}
    >
      <ChatRow
        chat={chat}
        title={title}
        myUsername={myUsername}
        unread={unread}
        pinned={pinned}
        muted={muted}
        onOpen={onOpen}
        onMenu={onMenu}
      />
    </Swipeable>
  );
}

/* --------------------------------------------------------------- экран */

export default function ChatsScreen() {
  const theme = useTheme();
  const wide = useIsWide();
  const me = useMe();
  const chats = useChats();
  const archivedQ = useArchivedChats();
  const subs = useMySubscriptions();
  const channels = useChannels('');
  const stats = useStats();
  const qc = useQueryClient();
  const haptics = useHaptics();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();

  /* -------------------------------------- скрытие поиска при скролле вниз */
  const searchAnim = useRef(new Animated.Value(0)).current; // 0 — видно, 1 — скрыто
  const searchHiddenRef = useRef(false);
  const [searchHeight, setSearchHeight] = useState(44);
  const [searchHidden, setSearchHidden] = useState(false);
  const listScrollYRef = useRef(0);
  const lastScrollTickRef = useRef(0);

  const setSearchHiddenAnimated = useCallback(
    (hidden: boolean) => {
      if (searchHiddenRef.current === hidden) return;
      searchHiddenRef.current = hidden;
      setSearchHidden(hidden);
      Animated.timing(searchAnim, {
        toValue: hidden ? 1 : 0,
        duration: hidden ? 180 : 220,
        easing: Easing.out(Easing.quad),
        // Высота не поддерживается native driver — анимируем на JS.
        useNativeDriver: false,
      }).start();
    },
    [searchAnim],
  );

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [filter, setFilter] = useState<SearchFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [history, setHistory] = useState<SearchHistoryEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [busyUser, setBusyUser] = useState('');
  const [pinned, setPinned] = useState<Record<string, boolean>>({});
  const [chatPage, setChatPage] = useState(30);
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const swipingRef = useRef(false);
  const swipeCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelSwipeClose = useCallback(() => {
    if (swipeCloseTimer.current) {
      clearTimeout(swipeCloseTimer.current);
      swipeCloseTimer.current = null;
    }
  }, []);
  const scheduleSwipeClose = useCallback(() => {
    if (!openRowId) return;
    cancelSwipeClose();
    swipeCloseTimer.current = setTimeout(() => setOpenRowId(null), 300);
  }, [openRowId, cancelSwipeClose]);
  useEffect(() => () => cancelSwipeClose(), [cancelSwipeClose]);
  const onSwipeStartRow = useCallback(() => {
    swipingRef.current = true;
    cancelSwipeClose();
  }, [cancelSwipeClose]);
  const onSwipeEndRow = useCallback(() => {
    swipingRef.current = false;
  }, []);
  const [readingAll, setReadingAll] = useState(false);
  const [menuChat, setMenuChat] = useState<Chat | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ ids: string[]; title: string; message: string; mode: 'delete' | 'leave' | 'mixed' } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const mutedChats = useStore((s) => s.mutedChats);
  const toggleMuted = useStore((s) => s.toggleMuted);
  // Поле появится в store от параллельного агента — читаем безопасно.
  const storeHistory = useStore((s) => (s as unknown as { searchHistory?: SearchHistoryEntry[] }).searchHistory);
  const myUsername = useStore((s) => s.me?.username) ?? api.getSession()?.username ?? '';
  const connectionPhase = useConnectionPhase();
  const mutedSet = useMemo(() => new Set(mutedChats), [mutedChats]);

  const searchRef = useRef<TextInput | null>(null);
  const searchHostRef = useRef<View | null>(null);
  const searchRectRef = useRef({ x: 0, y: 0, w: 999, h: 220 });
  const openRowRef = useRef<(row: SearchRow) => void>(() => undefined);
  const historyRef = useRef<SearchHistoryEntry[]>([]);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const blurSearch = useCallback(() => {
    searchRef.current?.blur();
    Keyboard.dismiss();
    setSearchFocused(false);
  }, []);

  const measureSearch = useCallback(() => {
    searchHostRef.current?.measureInWindow((x, y, w, h) => {
      searchRectRef.current = { x, y, w, h };
    });
  }, []);

  // На native тап вне окна поиска закрывает клавиатуру. Панель истории
  // (пустой запрос, ниже поля) не считается «вне», чтобы выбор не срывался.
  const onScreenTouch = useCallback(
    (event: { nativeEvent?: { pageX?: number; pageY?: number } }) => {
      if (!searchFocused) return;
      const pageX = Number(event?.nativeEvent?.pageX ?? 0);
      const pageY = Number(event?.nativeEvent?.pageY ?? 0);
      if (pageX <= 0 || pageY <= 0) return;
      const { x, y, w, h } = searchRectRef.current;
      const inside = pageX >= x - 4 && pageX <= x + w + 4 && pageY >= y - 4 && pageY <= y + h + 4;
      if (inside) return;
      if (!search.trim() && pageY > y + h) return;
      blurSearch();
    },
    [searchFocused, search, blurSearch],
  );

  // На web надёжнее обычный mousedown: target вне окна поиска.
  useEffect(() => {
    if (Platform.OS !== 'web' || !searchFocused || typeof document === 'undefined') return undefined;
    const onDown = (event: MouseEvent) => {
      const target = event.target as (HTMLElement & { closest?: (s: string) => Element | null }) | null;
      if (target?.closest?.('#sg-chats-search')) return;
      blurSearch();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [searchFocused, blurSearch]);

  /* ------------------------------------------------------------- загрузка */

  useEffect(() => {
    void (async () => {
      const saved = await dbGet('pinned_chats').catch(() => null);
      if (saved) {
        try {
          setPinned(JSON.parse(saved));
        } catch {
          /* ignore */
        }
      }
    })().catch(() => undefined);
    setHistory(readLegacyHistory());
    // Native: история лежит в kv (AsyncStorage), читаем асинхронно.
    void kv
      .get(HISTORY_KEY)
      .then((raw) => {
        if (!raw) return;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            const items = parsed.filter(isHistoryEntry).slice(0, HISTORY_LIMIT);
            if (items.length) {
              setHistory(items);
              historyRef.current = items;
            }
          }
        } catch {
          /* ignore */
        }
      })
      .catch(() => undefined);
    return () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  useEffect(() => {
    if (me.data) useStore.getState().setMe(me.data);
  }, [me.data?.id]);

  // Серверная история (preferences) приоритетнее локального legacy-кэша.
  useEffect(() => {
    if (Array.isArray(storeHistory) && storeHistory.length) {
      setHistory(storeHistory.slice(0, HISTORY_LIMIT));
    }
  }, [storeHistory]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  // Ctrl/Cmd+K из GlobalHotkeys — фокус на поиск (web).
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const focusSearch = () => {
      try {
        const host = document.getElementById('sg-chats-search');
        const input = host?.querySelector('input') as HTMLInputElement | null;
        input?.focus();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('sg-focus-search', focusSearch);
    return () => window.removeEventListener('sg-focus-search', focusSearch);
  }, []);

  // Debounce поиска: 280 мс, минимум 2 символа.
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setDebounced('');
      return;
    }
    const t = setTimeout(() => setDebounced(q), 280);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setSelectedKey(null);
  }, [debounced, filter]);

  /* --------------------------------------------------------------- данные */

  const activeChats = useMemo(() => (chats.data ?? []).filter((c) => !c.archived), [chats.data]);

  /** Единый список: активные чаты + подписки-каналы, которых нет в listChats. */
  const allChats = useMemo(() => {
    const map = new Map<string, Chat>();
    activeChats.forEach((c) => map.set(c.id, c));
    (subs.data ?? []).forEach((c) => {
      if (!c.archived && !map.has(c.id)) map.set(c.id, c);
    });
    // Пустой direct-чат, созданный собеседником, не показываем: он появится,
    // как только тот напишет первое сообщение.
    return [...map.values()].filter((c) => {
      if (c.type !== 'direct') return true;
      if (c.lastMessage || (c.lastSeq ?? 0) > 0) return true;
      if (!c.ownerUsername) return true;
      return c.ownerUsername === myUsername;
    });
  }, [activeChats, subs.data, myUsername]);

  /* ------------- фоновый прогрев: 8 прочитанных + 8 непрочитанных -------- */
  const preloadedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const targets = allChats
      .filter((chat) => chat.lastMessage && !preloadedRef.current.has(chat.id))
      .slice(0, Math.min(8, Math.max(4, chatPage)));
    if (!targets.length) return undefined;

    const timer = setTimeout(() => {
      void (async () => {
        for (const chat of targets) {
          if (cancelled) return;
          preloadedRef.current.add(chat.id);
          try {
            // 24 последних сообщений достаточно, чтобы получить 8 read + 8 unread.
            const list = await loadChatMessages(chat, myUsername, 24);
            if (cancelled) return;
            const lastRead = Number(chat.lastReadSeq ?? 0);
            const read = list.filter((m) => Number(m.seq) > 0 && Number(m.seq) <= lastRead).slice(-8);
            const unread = list.filter((m) => Number(m.seq) > lastRead).slice(-8);
            const keep = [...read, ...unread];
            if (keep.length) {
              saveMessages(chat.id, keep);
              const last = keep[keep.length - 1];
              if (last) {
                useStore.getState().setChatPreview(chat.id, {
                  id: last.id,
                  text: String(last.text ?? ''),
                  kind: last.kind,
                  mine: Boolean(last.mine),
                  at: last.createdAt,
                });
              }
            }
          } catch {
            /* прогрев не критичен: кэш останется прежним */
          }
          if (!cancelled) await new Promise((resolve) => setTimeout(resolve, 300));
        }
      })();
    }, 5000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [allChats, myUsername, chatPage]);

  const activeIds = useMemo(() => new Set(allChats.map((c) => c.id)), [allChats]);

  const archivedChats = useMemo(() => {
    const list = (archivedQ.data ?? []).filter((c) => !activeIds.has(c.id));
    return [...list].sort((a, b) => activityOf(b) - activityOf(a));
  }, [archivedQ.data, activeIds]);

  const searchableChats = useMemo(() => {
    const map = new Map<string, Chat>();
    [...activeChats, ...archivedChats].forEach((c) => map.set(c.id, c));
    return [...map.values()];
  }, [activeChats, archivedChats]);

  /** Все известные чаты (включая архив) — для массовых действий. */
  const everyChat = useMemo(() => {
    const map = new Map<string, Chat>();
    [...allChats, ...archivedChats].forEach((c) => map.set(c.id, c));
    return [...map.values()];
  }, [allChats, archivedChats]);

  const isPinned = useCallback((id: string) => Boolean(pinned[id]), [pinned]);

  /* --------------------------------------------------------------- поиск */

  const activeQuery = debounced.length >= 2 ? debounced : '';
  // Пользователь может искать «@username» — сервер ждёт имя без собаки.
  const needle = activeQuery.replace(/^@+/, '');
  const usersQ = useSearchUsers(needle);
  const groupsSafe = useSearchGroupsSafe(needle);
  const channelsQ = useChannels(needle);
  const messageSearch = useMessageSearch(searchableChats, needle, myUsername, filter === 'messages');

  const localIds = useMemo(() => new Set(searchableChats.map((c) => c.id)), [searchableChats]);

  const localChatHits = useMemo(() => {
    if (!activeQuery || !needle) return [];
    const q = needle.toLowerCase();
    return [...searchableChats]
      .filter((c) => {
        if (titleOf(c, myUsername).toLowerCase().includes(q)) return true;
        if (c.type !== 'direct' && c.title.toLowerCase().includes(q)) return true;
        return c.members.some(
          (m) => m.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
        );
      })
      .sort((a, b) => activityOf(b) - activityOf(a));
  }, [activeQuery, needle, searchableChats, myUsername]);

  const users = useMemo(
    () => (usersQ.data ?? []).filter((u) => u.username !== myUsername),
    [usersQ.data, myUsername],
  );

  // Пользователи, видимые напрямую через mesh (presence), — работают без сервера.
  const meshPeers = useStore((s) => s.meshPeers);
  const meshUsers = useMemo<SearchUser[]>(() => {
    if (!activeQuery || !needle) return [];
    const q = needle.toLowerCase();
    const known = new Set(users.map((u) => u.username.toLowerCase()));
    return Object.values(meshPeers)
      .filter((peer) => peer.username && !known.has(peer.username.toLowerCase()))
      .filter((peer) => peer.username.toLowerCase().includes(q))
      .map((peer) => ({
        id: peer.userId,
        username: peer.username,
        displayName: peer.username,
        avatar: null,
        moduleOnline: true,
      }));
  }, [activeQuery, needle, meshPeers, users]);
  const people = useMemo(() => [...users, ...meshUsers], [users, meshUsers]);

  const groupHits = useMemo(() => {
    if (!activeQuery || !needle) return [];
    return groupsSafe.groups.filter((g) => g.type === 'group' && !localIds.has(g.id));
  }, [activeQuery, needle, groupsSafe.groups, localIds]);

  const channelHits = useMemo<GroupSearchItem[]>(() => {
    if (!activeQuery || !needle) return [];
    const q = needle.toLowerCase();
    const map = new Map<string, GroupSearchItem>();
    // Серверный поиск групп может вернуть и каналы.
    groupsSafe.groups
      .filter((g) => g.type === 'channel' && g.title.toLowerCase().includes(q) && !localIds.has(g.id))
      .forEach((g) => map.set(g.id, g));
    (channelsQ.data ?? [])
      .filter((c) => c.title.toLowerCase().includes(q) && !localIds.has(c.id) && !map.has(c.id))
      .forEach((c) =>
        map.set(c.id, {
          id: c.id,
          title: c.title,
          type: 'channel',
          visibility: normalizeVisibility(c.visibility),
          description: c.description ?? '',
          membersCount: c.subscribers ?? 0,
          joined: Boolean(c.subscribed),
        }),
      );
    return [...map.values()];
  }, [activeQuery, needle, groupsSafe.groups, channelsQ.data, localIds]);

  const messageHits = messageSearch.hits;

  const counts = useMemo(
    () => ({
      people: people.length,
      chats: localChatHits.length,
      groups: groupHits.length,
      channels: channelHits.length,
      messages: messageHits.length,
    }),
    [people.length, localChatHits.length, groupHits.length, channelHits.length, messageHits.length],
  );

  const total = counts.people + counts.chats + counts.groups + counts.channels + counts.messages;

  // Ошибки поисковых запросов показываем рядом со строкой поиска.
  const queryError = usersQ.error
    ? humanError(usersQ.error)
    : channelsQ.error
      ? humanError(channelsQ.error)
      : chats.error
        ? humanError(chats.error)
        : '';

  const pendingDebounce = search.trim().length >= 2 && debounced !== search.trim();
  const searching =
    pendingDebounce ||
    Boolean(activeQuery && (usersQ.isLoading || usersQ.isFetching || groupsSafe.loading || channelsQ.isLoading || channelsQ.isFetching)) ||
    messageSearch.loading;

  /** Секции результатов с учётом активного фильтра. */
  const searchRows = useMemo<SearchRow[]>(() => {
    const rows: SearchRow[] = [];
    const allow = (f: SearchFilter) => filter === 'all' || filter === f;

    if (allow('chats') && localChatHits.length) {
      rows.push({ kind: 'section', title: 'Мои чаты', count: localChatHits.length });
      localChatHits.forEach((chat) => rows.push({ kind: 'chat', chat }));
    }
    if (allow('people') && people.length) {
      rows.push({ kind: 'section', title: 'Люди', count: people.length });
      people.forEach((user) => {
        const mutual = searchableChats.filter(
          (c) => c.type !== 'direct' && c.members.some((m) => m.username === user.username),
        ).length;
        rows.push({ kind: 'user', user, mutual });
      });
    }
    if (allow('groups') && groupHits.length) {
      rows.push({ kind: 'section', title: 'Группы', count: groupHits.length });
      groupHits.forEach((group) => rows.push({ kind: 'group', group }));
    }
    if (allow('channels') && channelHits.length) {
      rows.push({ kind: 'section', title: 'Каналы', count: channelHits.length });
      channelHits.forEach((group) => rows.push({ kind: 'group', group }));
    }
    if (allow('messages') && messageHits.length) {
      rows.push({ kind: 'section', title: 'Сообщения', count: messageHits.length });
      messageHits.forEach((hit) => rows.push({ kind: 'message', hit }));
    }
    return rows;
  }, [filter, localChatHits, people, groupHits, channelHits, messageHits, searchableChats]);

  const selectableRows = useMemo(() => searchRows.filter((r) => r.kind !== 'section'), [searchRows]);

  /* --------------------------------------------------------- действия чата */

  const persistPinned = (next: Record<string, boolean>) => {
    void dbSet('pinned_chats', JSON.stringify(next)).catch(() => undefined);
  };

  const togglePin = useCallback((id: string) => {
    haptics.tap();
    // Закрепление переносит чат в другую секцию — закрываем открытый свайп-ряд,
    // иначе кнопки pin/mute/delete остаются висеть на новом месте.
    setOpenRowId(null);
    setPinned((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      persistPinned(next);
      return next;
    });
  }, [haptics]);

  const openChat = useCallback((c: Chat) => {
    router.push(`/chat/${c.id}` as never);
  }, []);

  /** Сохранить историю и продублировать в store (серверная синхронизация). */
  const persistHistory = useCallback((next: SearchHistoryEntry[]) => {
    const limited = next.slice(0, HISTORY_LIMIT);
    historyRef.current = limited;
    setHistory(limited);
    writeHistory(limited);
    syncHistoryToStore(limited);
  }, []);

  /** Дедуп по type+id, новые сверху, не больше 8 записей. */
  const rememberEntry = useCallback(
    (entry: SearchHistoryEntry) => {
      const prev = historyRef.current;
      const next = [entry, ...prev.filter((x) => !(x.type === entry.type && x.id === entry.id))];
      persistHistory(next);
    },
    [persistHistory],
  );

  const rememberQuery = useCallback(
    (raw: string) => {
      const q = raw.trim();
      if (q.length < 2) return;
      rememberEntry({
        type: 'chat',
        id: `query:${q.toLowerCase()}`,
        title: q,
        subtitle: 'Поисковый запрос',
        at: new Date().toISOString(),
      });
    },
    [rememberEntry],
  );

  const openDirect = useCallback(
    async (user: { id: string; username: string; displayName: string; avatar?: api.AvatarInfo | null }) => {
      setError('');
      rememberEntry({
        type: 'user',
        id: user.id,
        title: user.displayName || user.username,
        subtitle: `@${user.username}`,
        username: user.username,
        avatar: user.avatar ?? null,
        at: new Date().toISOString(),
      });
      try {
        const existing = everyChat.find(
          (c) => c.type === 'direct' && c.members.some((m) => m.username === user.username),
        );
        if (existing) {
          openChat(existing);
          return;
        }
        setBusyUser(user.id);
        const created = await api.api.createChat({ type: 'direct', username: user.username });
        await qc.invalidateQueries({ queryKey: ['chats'] });
        openChat(created);
      } catch (e) {
        setError(humanError(e));
      } finally {
        setBusyUser('');
      }
    },
    [everyChat, openChat, qc, rememberEntry],
  );

  const openGroup = useCallback(
    (g: GroupSearchItem) => {
      rememberEntry({
        type: g.type === 'channel' ? 'channel' : 'group',
        id: g.id,
        title: g.title,
        subtitle: `${g.type === 'channel' ? 'Канал' : 'Группа'} · ${g.membersCount} участников`,
        at: new Date().toISOString(),
      });
      const joined = g.joined || activeIds.has(g.id);
      if (joined) {
        router.push(`/chat/${g.id}` as never);
        return;
      }
      router.push(infoUrlOf(g) as never);
    },
    [activeIds, rememberEntry],
  );

  const removeChats = useCallback(
    async (ids: string[]) => {
      setError('');
      try {
        const byId = new Map(everyChat.map((c) => [c.id, c]));
        await Promise.all(
          ids.map((id) => {
            const chat = byId.get(id);
            const leave = chat && (chat.type === 'group' || chat.type === 'channel') && chat.myRole !== 'owner';
            return leave ? api.api.leaveChat(id) : api.api.deleteChat(id);
          }),
        );
        setPinned((prev) => {
          if (!ids.some((id) => id in prev)) return prev;
          const next = { ...prev };
          ids.forEach((id) => delete next[id]);
          persistPinned(next);
          return next;
        });
        setOpenRowId((cur) => (cur && ids.includes(cur) ? null : cur));
        await qc.invalidateQueries({ queryKey: ['chats'] });
      } catch (e) {
        setError(humanError(e));
      }
    },
    [everyChat, qc],
  );

  const requestDelete = useCallback((chats: Chat[], fallbackTitle: string) => {
    const ids = chats.map((c) => c.id);
    if (!ids.length) return;
    const mode: 'delete' | 'leave' | 'mixed' = chats.every(
      (c) => (c.type === 'group' || c.type === 'channel') && c.myRole !== 'owner',
    )
      ? 'leave'
      : chats.every((c) => c.type === 'direct' || c.myRole === 'owner')
        ? 'delete'
        : 'mixed';
    const title = chats.length === 1 ? titleOf(chats[0], myUsername) : fallbackTitle;
    const message =
      chats.length > 1
        ? mode === 'leave'
          ? `Выйти из ${chats.length} чатов? Вы перестанете получать сообщения.`
          : `Удалить ${chats.length} чатов? Несколько чатов могут быть покинуты.`
        : mode === 'leave'
          ? `Выйти из чата «${title}»? Вы перестанете получать сообщения.`
          : `Удалить чат «${title}»? История переписки будет удалена.`;
    setConfirm({ ids, title, message, mode });
  }, [myUsername]);

  const markRead = useCallback(
    async (chat: Chat) => {
      setError('');
      try {
        await api.api.markRead(chat.id, chat.lastSeq);
        await qc.invalidateQueries({ queryKey: ['chats'] });
      } catch (e) {
        setError(humanError(e));
      }
    },
    [qc],
  );

  const setArchived = useCallback(
    async (chat: Chat, archived: boolean) => {
      setError('');
      try {
        await api.api.setChatArchived(chat.id, archived);
        await qc.invalidateQueries({ queryKey: ['chats'] });
        await qc.invalidateQueries({ queryKey: ['chats', 'archived'] });
      } catch (e) {
        setError(humanError(e));
      }
    },
    [qc],
  );

  const leaveSelection = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const startSelect = useCallback((chat: Chat) => {
    setSelecting(true);
    setSelected(new Set([chat.id]));
    setMenuChat(null);
    setOpenRowId(null);
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const unreadChats = activeChats.filter((c) => (c.unread ?? 0) > 0);

  const readAll = useCallback(async () => {
    if (!unreadChats.length || readingAll) return;
    haptics.tap();
    setReadingAll(true);
    setError('');
    try {
      await Promise.all(unreadChats.map((c) => api.api.markRead(c.id, c.lastSeq)));
      await qc.invalidateQueries({ queryKey: ['chats'] });
    } catch (e) {
      setError(humanError(e));
    } finally {
      setReadingAll(false);
    }
  }, [unreadChats, readingAll, haptics, qc]);

  const readAllRef = useRef(readAll);
  readAllRef.current = readAll;
  useEffect(() => onReadAllRequest(() => void readAllRef.current()), []);

  /* ------------------------------------------------------ открытие результата */

  const openSearchRow = useCallback(
    (row: SearchRow) => {
      if (row.kind === 'section') return;
      if (row.kind === 'chat') {
        const peer = peerOf(row.chat, myUsername);
        rememberEntry({
          type: 'chat',
          id: row.chat.id,
          title: titleOf(row.chat, myUsername),
          subtitle: row.chat.type === 'direct' ? 'Чат' : 'Группа',
          avatar: peer?.avatar ?? null,
          at: new Date().toISOString(),
        });
        openChat(row.chat);
        return;
      }
      if (row.kind === 'user') {
        void openDirect(row.user);
        return;
      }
      if (row.kind === 'group') {
        openGroup(row.group);
        return;
      }
      rememberEntry({
        type: 'message',
        // Составной id: чат + сообщение, чтобы открыть то же место переписки.
        id: `${row.hit.chatId}::${row.hit.message.id}`,
        title: row.hit.chatTitle,
        subtitle: `Сообщение · @${row.hit.message.senderUsername}`,
        at: new Date().toISOString(),
      });
      router.push(`/chat/${row.hit.chatId}?msg=${encodeURIComponent(row.hit.message.id)}` as never);
    },
    [myUsername, openChat, openDirect, openGroup, rememberEntry],
  );
  openRowRef.current = openSearchRow;

  /** Открыть запись из панели истории — тот же экран, что и результат поиска. */
  const openHistoryEntry = useCallback(
    (entry: SearchHistoryEntry) => {
      if (entry.id.startsWith('query:')) {
        setSearch(entry.title);
        setDebounced(entry.title);
        setFilter('all');
        return;
      }
      if (entry.type === 'user' && entry.username) {
        void openDirect({ id: entry.id, username: entry.username, displayName: entry.title, avatar: entry.avatar });
        return;
      }
      if (entry.type === 'message') {
        const [chatId, messageId] = entry.id.split('::');
        if (chatId && messageId) {
          router.push(`/chat/${chatId}?msg=${encodeURIComponent(messageId)}` as never);
        }
        return;
      }
      if (entry.type === 'group' || entry.type === 'channel') {
        if (activeIds.has(entry.id)) {
          router.push(`/chat/${entry.id}` as never);
        } else {
          router.push(`/chat/${entry.id}/info?title=${encodeURIComponent(entry.title)}` as never);
        }
        return;
      }
      router.push(`/chat/${entry.id}` as never);
    },
    [activeIds, openDirect],
  );

  const moveSelection = useCallback(
    (dir: 1 | -1) => {
      if (!selectableRows.length) return;
      const idx = selectableRows.findIndex((r) => rowKey(r) === selectedKey);
      const nextIndex = idx < 0 ? (dir > 0 ? 0 : selectableRows.length - 1) : (idx + dir + selectableRows.length) % selectableRows.length;
      setSelectedKey(rowKey(selectableRows[nextIndex]));
    },
    [selectableRows, selectedKey],
  );

  const clearSearch = useCallback(() => {
    setSearch('');
    setDebounced('');
    setSelectedKey(null);
    setFilter('all');
    try {
      const host = document.getElementById('sg-chats-search');
      const input = host?.querySelector('input') as HTMLInputElement | null;
      input?.focus();
    } catch {
      /* native */
    }
  }, []);

  /* -------------------------------------------------------------- клавиатура */

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menuChat) {
          setMenuChat(null);
          return;
        }
        if (confirm) {
          setConfirm(null);
          return;
        }
        if (selecting) {
          leaveSelection();
          return;
        }
        if (searchFocused && search.trim()) {
          e.preventDefault();
          clearSearch();
          return;
        }
        setSelectedKey(null);
        if (searchFocused) searchRef.current?.blur();
        return;
      }
      if (!searchFocused || selecting || menuChat) return;
      if (!search.trim()) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedKey) {
          const row = selectableRows.find((r) => rowKey(r) === selectedKey);
          if (row) openRowRef.current(row);
        } else if (selectableRows[0]) {
          openRowRef.current(selectableRows[0]);
        } else {
          rememberQuery(search);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    menuChat,
    confirm,
    selecting,
    leaveSelection,
    searchFocused,
    search,
    clearSearch,
    moveSelection,
    selectedKey,
    selectableRows,
    rememberQuery,
  ]);

  /* ------------------------------------------------------- делегирование UI */

  const onPressChatRow = useCallback(
    (row: ChatListRow) => {
      if (row.kind === 'chat') openChat(row.chat);
    },
    [openChat],
  );

  /* -------------------------------------------------------------- сортировка */

  /**
   * Скролл списка чатов: прячем панель поиска при движении вниз (>100px),
   * возвращаем при движении вверх. Порог + троттлинг: setState не на каждый пиксель.
   */
  const onChatsListScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (openRowId) setOpenRowId(null);
      const y = Math.max(0, e.nativeEvent.contentOffset.y);
      const now = Date.now();
      if (now - lastScrollTickRef.current < SEARCH_SCROLL_THROTTLE_MS) return;
      lastScrollTickRef.current = now;
      const dy = y - listScrollYRef.current;
      listScrollYRef.current = y;
      // Пока поиск в фокусе или уже есть запрос — панель не прячем.
      if (searchFocused || search.trim()) {
        setSearchHiddenAnimated(false);
        return;
      }
      if (!searchHiddenRef.current) {
        if (y > SEARCH_HIDE_AFTER && dy > SEARCH_HIDE_DELTA) setSearchHiddenAnimated(true);
      } else if (dy < -SEARCH_HIDE_DELTA || y < 60) {
        setSearchHiddenAnimated(false);
      }
    },
    [openRowId, searchFocused, search, setSearchHiddenAnimated],
  );

  const chatRows = useMemo<ChatListRow[]>(() => {
    const sorted = [...allChats].sort((a, b) => activityOf(b) - activityOf(a));
    const pinnedList = sorted.filter((c) => isPinned(c.id));
    const restAll = sorted.filter((c) => !isPinned(c.id));
    // Телеграм-подобная пагинация: сначала 30 строк, остальное по скроллу.
    const rest = restAll.slice(0, Math.max(0, chatPage - pinnedList.length));
    const rows: ChatListRow[] = [];
    if (pinnedList.length) {
      rows.push({ kind: 'section', title: 'Закреплённые', count: pinnedList.length });
      pinnedList.forEach((chat) => rows.push({ kind: 'chat', chat }));
    }
    if (rest.length) {
      rest.forEach((chat) => rows.push({ kind: 'chat', chat }));
    }
    return rows;
  }, [allChats, isPinned, chatPage]);

  const noChats = allChats.length === 0 && archivedChats.length === 0;
  const queryTooShort = Boolean(search.trim()) && search.trim().replace(/^@+/, '').length < 2;
  const queryActive = search.trim().length >= 2;
  const noResults = Boolean(activeQuery) && !searching && total === 0;

  /** Pull-to-refresh: принудительно обновляем всё, что влияет на список и поиск. */
  const refreshAll = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.allSettled([
        chats.refetch(),
        archivedQ.refetch(),
        subs.refetch(),
        me.refetch(),
        stats.refetch(),
        qc.invalidateQueries({ queryKey: ['groups'] }),
        qc.invalidateQueries({ queryKey: ['users'] }),
        qc.invalidateQueries({ queryKey: ['channels'] }),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [archivedQ, chats, me, qc, refreshing, stats, subs]);

  // Панель истории — только когда поиск в фокусе и строка пустая.
  const historyOpen = searchFocused && !search.trim() && history.length > 0;

  /* ------------------------------------------------------------------ рендер */

  // Стабильный renderItem: строки не пересоздаются на каждый рендер экрана.
  const chatListExtraData = useMemo(
    () => ({ wide, selecting, selected, openRowId, pinned, mutedSet, myUsername, theme, reduced }),
    [wide, selecting, selected, openRowId, pinned, mutedSet, myUsername, theme, reduced],
  );
  useEffect(() => {
    const ids = allChats.slice(0, 5).map((chat) => chat?.id).filter((id) => Boolean(id));
    if (ids.length) void prefetchTopChats(ids);
  }, [allChats]);

  const renderChatRowRef = useRef<(info: { item: ChatListRow; index: number }) => React.ReactElement | null>(() => null);
  renderChatRowRef.current = ({ item, index }) => {
              if (item.kind === 'section') {
                return (
                  <MotiView
                    from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 6 }}
                    animate={{ opacity: 1, translateY: 0 }}
                    transition={
                      reduced
                        ? { type: 'timing', duration: 0 }
                        : { ...motion.softSpring, delay: Math.min(index, 8) * motion.staggerStepMs }
                    }
                  >
                    <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>{item.title}</Text>
                  </MotiView>
                );
              }
              const chat = item.chat;
              const content = wide || selecting ? (
                <View style={styles.staticRow}>
                  <ChatRow
                    chat={chat}
                    title={titleOf(chat, myUsername)}
                    myUsername={myUsername}
                    unread={chat.unread}
                    pinned={isPinned(chat.id)}
                    muted={mutedSet.has(chat.id)}
                    selecting={selecting}
                    selected={selected.has(chat.id)}
                    onToggleSelect={() => toggleSelect(chat.id)}
                    onMenu={() => setMenuChat(chat)}
                    onOpen={() => {
                      if (selecting) toggleSelect(chat.id);
                      else void onPressChatRow(item);
                    }}
                  />
                </View>
              ) : (
                <SwipeChatRow
                  chat={chat}
                  title={titleOf(chat, myUsername)}
                  myUsername={myUsername}
                  unread={chat.unread}
                  pinned={isPinned(chat.id)}
                  muted={mutedSet.has(chat.id)}
                  open={openRowId === chat.id}
                  onOpenChange={setOpenRowId}
                  onTogglePin={() => togglePin(chat.id)}
                  onToggleMute={() => toggleMuted(chat.id)}
                  onDelete={() => requestDelete([chat], titleOf(chat, myUsername))}
                  onOpen={() => void onPressChatRow(item)}
                  onMenu={() => setMenuChat(chat)}
                  onSwipeStart={onSwipeStartRow}
                  onSwipeEnd={onSwipeEndRow}
                />
              );

              return (
                <MotiView
                  from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10 }}
                  animate={{ opacity: 1, translateY: 0 }}
                  transition={
                    reduced
                      ? { type: 'timing', duration: 0 }
                      : { ...motion.softSpring, delay: Math.min(index, 12) * motion.staggerStepMs }
                  }
                >
                  {content}
                </MotiView>
              );
  };
  const renderChatRow = useCallback(
    (info: { item: ChatListRow; index: number }) => renderChatRowRef.current(info),
    [],
  );
  return (
    <View style={{ flex: 1 }} onTouchStart={onScreenTouch}>
      <View style={styles.header}>
        <MotiView
          from={reduced ? { opacity: 0 } : { opacity: 0, translateY: -8 }}
          animate={{ opacity: 1, translateY: 0 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
          style={{ flex: 1 }}
        >
          <Text style={{ color: theme.textPrimary, fontWeight: '800', fontSize: theme.fontXl }}>Чаты</Text>
        </MotiView>
        <MotiView
          key={connectionPhase ?? 'module-status'}
          from={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ type: 'timing', duration: 200 }}
        >
          {connectionPhase === 'mesh' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <ConnectionPill phase="mesh" />
              <ModuleStatusPill />
            </View>
          ) : connectionPhase ? (
            <ConnectionPill phase={connectionPhase} />
          ) : (
            <ModuleStatusPill />
          )}
        </MotiView>
        <MotiView
          from={reduced ? { opacity: 0 } : { opacity: 0, translateY: -6, scale: 0.96 }}
          animate={{ opacity: 1, translateY: 0, scale: 1 }}
          transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay: motion.staggerStepMs }}
        >
          <HeaderCreateMenu />
        </MotiView>
      </View>

      {selecting ? (
        <View style={{ marginBottom: 10 }}>
          <SelectionToolbar
            count={selected.size}
            onCancel={leaveSelection}
            onRead={() => {
              haptics.tap();
              void (async () => {
                const list = everyChat.filter((c) => selected.has(c.id));
                await Promise.all(list.map((c) => api.api.markRead(c.id, c.lastSeq))).catch((e) => setError(humanError(e)));
                await qc.invalidateQueries({ queryKey: ['chats'] });
                leaveSelection();
              })();
            }}
            onMute={() => {
              haptics.tap();
              selected.forEach((id) => {
                if (!mutedSet.has(id)) toggleMuted(id);
              });
              leaveSelection();
            }}
            onArchive={() => {
              haptics.tap();
              void (async () => {
                const list = everyChat.filter((c) => selected.has(c.id));
                try {
                  await Promise.all(list.map((c) => api.api.setChatArchived(c.id, true)));
                  await qc.invalidateQueries({ queryKey: ['chats'] });
                  await qc.invalidateQueries({ queryKey: ['chats', 'archived'] });
                } catch (e) {
                  setError(humanError(e));
                }
                leaveSelection();
              })();
            }}
            onDelete={() => {
              const ids = [...selected];
              if (ids.length) requestDelete(ids.map((id) => everyChat.find((c) => c.id === id)).filter((c): c is Chat => Boolean(c)), '');
            }}
          />
        </View>
      ) : (
        <Animated.View
          pointerEvents={searchHidden ? 'none' : 'auto'}
          style={{
            height: searchAnim.interpolate({ inputRange: [0, 1], outputRange: [searchHeight, 0] }),
            opacity: searchAnim.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 0.2, 0] }),
            transform: [{ translateY: searchAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -8] }) }],
          }}
        >
          <View
            ref={searchHostRef}
            nativeID="sg-chats-search"
            style={{ position: 'relative', zIndex: 40, paddingBottom: 12 }}
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              if (h > 0 && Math.abs(h - searchHeight) > 0.5) setSearchHeight(h);
              measureSearch();
            }}
          >
            <SearchField
              ref={searchRef}
              value={search}
              onChange={(t) => {
                setSearch(t);
                setFilter('all');
              }}
              onClear={clearSearch}
              onFocus={() => {
                if (blurTimer.current) clearTimeout(blurTimer.current);
                setSearchFocused(true);
                setSearchHiddenAnimated(false);
              }}
              onBlur={() => {
                // Небольшая задержка: тап по записи истории успевает сработать.
                if (blurTimer.current) clearTimeout(blurTimer.current);
                blurTimer.current = setTimeout(() => setSearchFocused(false), 160);
              }}
              onSubmit={() => {
                if (selectedKey) {
                  const row = selectableRows.find((r) => rowKey(r) === selectedKey);
                  if (row) openSearchRow(row);
                } else {
                  rememberQuery(search);
                }
              }}
              placeholder="Поиск людей, чатов, групп, каналов, сообщений"
            />
            {historyOpen ? (
              <SearchHistoryPanel
                theme={theme}
                wide={wide}
                history={history}
                onOpen={(entry) => {
                  setSearchFocused(false);
                  openHistoryEntry(entry);
                }}
                onRemove={(entry) => {
                  persistHistory(historyRef.current.filter((x) => !(x.type === entry.type && x.id === entry.id)));
                }}
                onClear={() => persistHistory([])}
              />
            ) : null}
          </View>
        </Animated.View>
      )}

      {error || queryError ? (
        <Text style={{ color: theme.danger, marginTop: 8, fontSize: 13 }}>{error || queryError}</Text>
      ) : null}

      {search.trim() ? (
        <SearchResults
          theme={theme}
          reduced={reduced}
          search={search}
          activeQuery={activeQuery}
          queryTooShort={queryTooShort}
          searching={searching}
          noResults={noResults}
          total={total}
          rows={searchRows}
          counts={counts}
          filter={filter}
          onFilter={setFilter}
          selectedKey={selectedKey}
          onOpenRow={openSearchRow}
          onOpenChat={(chat) => {
            const peer = peerOf(chat, myUsername);
            rememberEntry({
              type: 'chat',
              id: chat.id,
              title: titleOf(chat, myUsername),
              subtitle: chat.type === 'direct' ? 'Чат' : 'Группа',
              avatar: peer?.avatar ?? null,
              at: new Date().toISOString(),
            });
            openChat(chat);
          }}
          myUsername={myUsername}
          pinned={pinned}
          mutedSet={mutedSet}
          busyUser={busyUser}
          messageLoading={messageSearch.loading}
          messageProgress={messageSearch.progress}
          onCreate={() => router.push('/compose?mode=direct' as never)}
          onMenuChat={setMenuChat}
          onTogglePin={togglePin}
          onToggleMute={toggleMuted}
        />
      ) : chats.isLoading ? (
        <SkeletonChatList rows={8} />
      ) : noChats ? (
        <View style={{ flex: 1 }}>
          <EmptyState
            icon="chatbubbles-outline"
            title="Пока нет чатов"
            subtitle="Найдите человека или канал через поиск либо создайте первый чат."
            actionLabel="Создать чат"
            onAction={() => router.push('/compose?mode=direct' as never)}
          />
          <OnboardingCard />
        </View>
      ) : (
        <>
          <FlashList
            data={chatRows}
            keyExtractor={chatListKey}
            onEndReached={() => setChatPage((n) => n + 30)}
            onEndReachedThreshold={0.6}
            keyboardShouldPersistTaps="handled"
            onRefresh={() => void refreshAll()}
            refreshing={refreshing}
            onScrollBeginDrag={() => {
              if (!swipingRef.current) setOpenRowId(null);
            }}
            onScroll={onChatsListScroll}
            scrollEventThrottle={32}
            estimatedItemSize={86}
            drawDistance={900}
            contentContainerStyle={{
              // Док плавающий: резервируем высоту капсулы + safe-area + 24px воздуха,
              // чтобы последний чат не уходил под кнопки.
              paddingBottom: Math.max(130, 60 + 12 + Math.max(0, insets.bottom) + 24),
            }}
            ListFooterComponent={
              archivedChats.length ? (
                <ArchiveSection
                  theme={theme}
                  reduced={reduced}
                  open={archiveOpen}
                  onToggle={() => setArchiveOpen((v) => !v)}
                  chats={archivedChats}
                  myUsername={myUsername}
                  mutedSet={mutedSet}
                  pinned={pinned}
                  onOpen={(chat) => openChat(chat)}
                  onMenu={setMenuChat}
                />
              ) : null
            }
            extraData={chatListExtraData}
            renderItem={renderChatRow}

          />
        </>
      )}

      <ChatContextMenu
        visible={Boolean(menuChat)}
        title={menuChat ? titleOf(menuChat, myUsername) : ''}
        pinned={menuChat ? isPinned(menuChat.id) : false}
        muted={menuChat ? mutedSet.has(menuChat.id) : false}
        archived={Boolean(menuChat?.archived)}
        unread={menuChat?.unread ?? 0}
        canMarkRead={Boolean(menuChat && (menuChat.unread ?? 0) > 0)}
        onClose={() => setMenuChat(null)}
        onTogglePin={() => menuChat && togglePin(menuChat.id)}
        onToggleMute={() => menuChat && toggleMuted(menuChat.id)}
        onMarkRead={() => menuChat && void markRead(menuChat)}
        onArchive={() => menuChat && void setArchived(menuChat, !menuChat.archived)}
        onSelect={() => menuChat && startSelect(menuChat)}
        onDelete={() => {
          if (!menuChat) return;
          requestDelete([menuChat], titleOf(menuChat, myUsername));
        }}
      />

      <ConfirmDialog
        visible={Boolean(confirm)}
        title={
          confirm
            ? confirm.ids.length > 1
              ? confirm.mode === 'leave' ? 'Выйти из чатов?' : 'Удалить/покинуть чаты?'
              : confirm.mode === 'leave' ? 'Выйти из чата?' : 'Удалить чат?'
            : ''
        }
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.mode === 'leave' ? 'Выйти' : confirm?.mode === 'mixed' ? 'Продолжить' : 'Удалить'}
        busy={deleting}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          const ids = confirm.ids;
          setDeleting(true);
          void (async () => {
            await removeChats(ids);
            setDeleting(false);
            setConfirm(null);
            if (selecting) leaveSelection();
          })();
        }}
      />
    </View>
  );
}

/* ----------------------------------------------------------- поле поиска */

const SearchField = React.forwardRef<
  TextInput,
  {
    value: string;
    onChange: (t: string) => void;
    onClear: () => void;
    onFocus: () => void;
    onBlur: () => void;
    onSubmit: () => void;
    placeholder: string;
  }
>(function SearchField({ value, onChange, onClear, onFocus, onBlur, onSubmit, placeholder }, ref) {
  const theme = useTheme();
  return (
    <View style={[styles.searchWrap, { borderColor: theme.line, backgroundColor: 'transparent' }]}>
      <Ionicons name="search" size={18} color={theme.textDisabled} />
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        onSubmitEditing={onSubmit}
        placeholder={placeholder}
        placeholderTextColor={theme.textDisabled}
        accessibilityLabel="Поиск людей, чатов, групп, каналов и сообщений"
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.searchInput, { color: theme.textPrimary }]}
      />
      {value ? (
        <Pressable onPress={onClear} accessibilityRole="button" accessibilityLabel="Очистить поиск" style={styles.searchClear}>
          <Ionicons name="close-circle" size={18} color={theme.textDisabled} />
        </Pressable>
      ) : null}
    </View>
  );
});

/* ------------------------------------------------------- история/подсказки */

/**
 * Выпадающая стеклянная панель истории под строкой поиска.
 * Показывается только при пустом запросе и фокусе на инпуте.
 */
function SearchHistoryPanel({
  theme,
  wide,
  history,
  onOpen,
  onRemove,
  onClear,
}: {
  theme: ReturnType<typeof useTheme>;
  wide: boolean;
  history: SearchHistoryEntry[];
  onOpen: (entry: SearchHistoryEntry) => void;
  onRemove: (entry: SearchHistoryEntry) => void;
  onClear: () => void;
}) {
  const reduced = useReducedMotion();
  return (
    <MotiView
      from={reduced ? { opacity: 0 } : { opacity: 0, translateY: -6, scale: 0.99 }}
      animate={{ opacity: 1, translateY: 0, scale: 1 }}
      transition={reduced ? { type: 'timing', duration: 0 } : motion.quick}
      style={[
        styles.historyPanel,
        {
          maxHeight: wide ? 380 : 300,
          backgroundColor: theme.glass,
          borderColor: theme.glassBorder,
          ...(Platform.OS === 'web'
            ? ({ backdropFilter: 'blur(18px) saturate(1.4)', WebkitBackdropFilter: 'blur(18px) saturate(1.4)' } as object)
            : null),
        },
        theme.shadow,
      ]}
    >
      <View style={styles.historyHead}>
        <Ionicons name="time-outline" size={13} color={theme.textSecondary} />
        <Text style={{ color: theme.textSecondary, fontSize: 11, fontWeight: '800', letterSpacing: 0.6, flex: 1 }}>
          ИСТОРИЯ ПОИСКА
        </Text>
        <Pressable onPress={onClear} accessibilityRole="button" accessibilityLabel="Очистить всё историю поиска" hitSlop={6}>
          <Text style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700' }}>Очистить всё</Text>
        </Pressable>
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled showsVerticalScrollIndicator={false}>
        {history.map((entry) => {
          const at = entryTime(entry.at);
          const subtitle = entry.subtitle || historyTypeLabel[entry.type] || '';
          return (
            <Pressable
              key={`${entry.type}:${entry.id}`}
              onPress={() => onOpen(entry)}
              accessibilityRole="button"
              accessibilityLabel={`Открыть ${entry.title}`}
              style={({ pressed }) => [
                styles.historyRow,
                { backgroundColor: pressed ? theme.surfacePressed : 'transparent' },
              ]}
            >
              <Avatar name={entry.title} size={34} avatar={entry.avatar ?? null} hasModule={false} hasNode={false} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
                  {entry.title}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 11.5 }} numberOfLines={1}>
                  {subtitle}
                </Text>
              </View>
              <Text style={{ color: theme.textDisabled, fontSize: 10.5, fontVariant: ['tabular-nums'] as never }}>
                {at > 0 ? timeAgo(new Date(at).toISOString()) : ''}
              </Text>
              <Pressable
                onPress={() => onRemove(entry)}
                accessibilityRole="button"
                accessibilityLabel={`Удалить «${entry.title}» из истории`}
                hitSlop={8}
                style={({ pressed }) => [styles.historyRemove, { opacity: pressed ? 0.55 : 1 }]}
              >
                <Ionicons name="close" size={13} color={theme.textDisabled} />
              </Pressable>
            </Pressable>
          );
        })}
      </ScrollView>
    </MotiView>
  );
}

/* ------------------------------------------------------- результаты поиска */

function FilterTabs({
  theme,
  filter,
  counts,
  total,
  onFilter,
}: {
  theme: ReturnType<typeof useTheme>;
  filter: SearchFilter;
  counts: Record<string, number>;
  total: number;
  onFilter: (f: SearchFilter) => void;
}) {
  const reduced = useReducedMotion();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // На web ScrollView растягивается по высоте (flexGrow:1) и уводит
      // результаты поиска вниз — фиксируем высоту ленты фильтров.
      style={{ flexGrow: 0, flexShrink: 0 }}
      contentContainerStyle={{ gap: 6, paddingVertical: 6 }}
      keyboardShouldPersistTaps="handled"
    >
      {FILTERS.map((f) => {
        const count = f.key === 'all' ? total : counts[f.key] ?? 0;
        const active = filter === f.key;
        return (
          <MotiView
            key={f.key}
            animate={{ scale: active && !reduced ? 1.02 : 1 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.pressSpring}
          >
            <Pressable
              onPress={() => onFilter(f.key)}
              accessibilityRole="button"
              accessibilityLabel={`${f.label}: ${count} результатов`}
              accessibilityState={{ selected: active }}
              style={({ pressed }) => [
                styles.filterTab,
                {
                  backgroundColor: active
                    ? theme.accent
                    : pressed
                      ? theme.surfacePressed
                      : Platform.OS === 'web'
                        ? theme.glass
                        : theme.surface,
                  borderColor: active ? theme.accent : theme.glassBorder,
                  ...(Platform.OS === 'web' && !active
                    ? ({ backdropFilter: 'blur(12px)' } as object)
                    : null),
                },
              ]}
            >
              <Ionicons name={f.icon} size={13} color={active ? theme.onAccent : theme.textSecondary} />
              <Text style={{ color: active ? theme.onAccent : theme.textSecondary, fontSize: 11.5, fontWeight: '700' }}>
                {f.label}
              </Text>
              {count > 0 ? (
                <View
                  style={[
                    styles.filterCount,
                    { backgroundColor: active ? 'rgba(0,0,0,0.16)' : theme.accentSoft },
                  ]}
                >
                  <Text style={{ color: active ? theme.onAccent : theme.accent, fontSize: 10, fontWeight: '800' }}>{count}</Text>
                </View>
              ) : null}
            </Pressable>
          </MotiView>
        );
      })}
    </ScrollView>
  );
}

function SearchResults({
  theme,
  reduced,
  search,
  activeQuery,
  queryTooShort,
  searching,
  noResults,
  total,
  rows,
  counts,
  filter,
  onFilter,
  selectedKey,
  onOpenRow,
  onOpenChat,
  myUsername,
  pinned,
  mutedSet,
  busyUser,
  messageLoading,
  messageProgress,
  onCreate,
  onMenuChat,
  onTogglePin,
  onToggleMute,
}: {
  theme: ReturnType<typeof useTheme>;
  reduced: boolean;
  search: string;
  activeQuery: string;
  queryTooShort: boolean;
  searching: boolean;
  noResults: boolean;
  total: number;
  rows: SearchRow[];
  counts: Record<string, number>;
  filter: SearchFilter;
  onFilter: (f: SearchFilter) => void;
  selectedKey: string | null;
  onOpenRow: (row: SearchRow) => void;
  onOpenChat: (chat: Chat) => void;
  myUsername: string;
  pinned: Record<string, boolean>;
  mutedSet: Set<string>;
  busyUser: string;
  messageLoading: boolean;
  messageProgress: number;
  onCreate: () => void;
  onMenuChat: (chat: Chat) => void;
  onTogglePin: (id: string) => void;
  onToggleMute: (id: string) => void;
}) {
  if (queryTooShort) {
    return (
      <View style={{ flex: 1 }}>
        <View style={[styles.hintCard, { backgroundColor: theme.surface, borderColor: theme.line }]}>
          <Ionicons name="text-outline" size={18} color={theme.accent} />
          <Text style={{ color: theme.textSecondary, fontSize: 13 }}>
            Введите минимум 2 символа — иначе результатов слишком много.
          </Text>
        </View>
      </View>
    );
  }

  if (searching && total === 0) {
    return (
      <View style={{ flex: 1 }}>
        <FilterTabs theme={theme} filter={filter} counts={counts} total={total} onFilter={onFilter} />
        <SearchSkeleton theme={theme} />
      </View>
    );
  }

  if (noResults) {
    const canSearchMessages = filter === 'all';
    return (
      <View style={{ flex: 1 }}>
        <FilterTabs theme={theme} filter={filter} counts={counts} total={total} onFilter={onFilter} />
        <EmptyState
          icon="search-outline"
          title={canSearchMessages ? 'Среди чатов и людей не найдено' : 'Ничего не найдено'}
          subtitle={
            canSearchMessages
              ? `«${search.trim()}» может встречаться в сообщениях. Запустите поиск по тексту переписки.`
              : `По запросу «${search.trim()}» совпадений нет. Попробуйте @username или создайте чат.`
          }
          actionLabel={canSearchMessages ? 'Искать в сообщениях' : 'Создать чат'}
          onAction={canSearchMessages ? () => onFilter('messages') : onCreate}
        />
      </View>
    );
  }

  // В выбранной категории пусто, но в других есть совпадения.
  if (rows.length === 0) {
    return (
      <View style={{ flex: 1 }}>
        <FilterTabs theme={theme} filter={filter} counts={counts} total={total} onFilter={onFilter} />
        {searching ? (
          <SearchSkeleton theme={theme} />
        ) : (
          <View style={{ flex: 1 }}>
            <View style={[styles.hintCard, { backgroundColor: theme.surface, borderColor: theme.line }]}>
              <Ionicons name="filter-outline" size={18} color={theme.accent} />
              <Text style={{ color: theme.textSecondary, fontSize: 13, flex: 1 }}>
                В этой категории совпадений нет.
              </Text>
            </View>
            <Pressable
              onPress={() => onFilter('all')}
              accessibilityRole="button"
              accessibilityLabel="Показать все результаты"
              style={({ pressed }) => [
                styles.hintCard,
                { backgroundColor: pressed ? theme.surfacePressed : theme.accentSoft, borderColor: theme.accent },
              ]}
            >
              <Ionicons name="albums-outline" size={18} color={theme.accent} />
              <Text style={{ color: theme.accent, fontSize: 13, fontWeight: '700' }}>
                Показать все результаты ({total})
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FilterTabs theme={theme} filter={filter} counts={counts} total={total} onFilter={onFilter} />
      <FlashList
        data={rows}
        keyExtractor={(r, i) => `${rowKey(r)}-${i}`}
        keyboardShouldPersistTaps="handled"
        estimatedItemSize={72}
        contentContainerStyle={{ paddingBottom: 130 }}
        renderItem={({ item, index }) => {
          if (item.kind === 'section') {
            return (
              <View>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6 }}>
                  <Text style={[styles.sectionTitle, { color: theme.textSecondary }]}>
                    {item.title} · {item.count}
                  </Text>
                  {item.title === 'Сообщения' && messageLoading ? (
                    <Text style={{ color: theme.accent, fontSize: 10.5, fontWeight: '700' }}>
                      ищем… {Math.round(messageProgress * 100)}%
                    </Text>
                  ) : null}
                </View>
                {item.title === 'Сообщения' && messageLoading ? (
                  <View style={[styles.progressTrack, { backgroundColor: theme.accentSoft }]}>
                    <View
                      style={[
                        styles.progressFill,
                        { backgroundColor: theme.accent, width: `${Math.max(4, Math.round(messageProgress * 100))}%` },
                      ]}
                    />
                  </View>
                ) : null}
              </View>
            );
          }

          let content: React.ReactNode;
          if (item.kind === 'chat') {
            content = (
              <ChatRow
                chat={item.chat}
                title={titleOf(item.chat, myUsername)}
                myUsername={myUsername}
                unread={item.chat.unread}
                pinned={Boolean(pinned[item.chat.id])}
                muted={mutedSet.has(item.chat.id)}
                onOpen={() => onOpenChat(item.chat)}
                onMenu={() => onMenuChat(item.chat)}
              />
            );
          } else if (item.kind === 'user') {
            content = (
              <UserRow
                user={item.user}
                mutual={item.mutual}
                busy={busyUser === item.user.id}
                onPress={() => onOpenRow(item)}
              />
            );
          } else if (item.kind === 'group') {
            content = <GroupRow group={item.group} onPress={() => onOpenRow(item)} />;
          } else {
            content = (
              <MessageRow
                hit={item.hit}
                query={search.replace(/^@+/, '')}
                theme={theme}
                onPress={() => onOpenRow(item)}
              />
            );
          }

          const selected = selectedKey === rowKey(item);
          return (
            <MotiView
              from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 8 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={
                reduced
                  ? { type: 'timing', duration: 0 }
                  : { ...motion.softSpring, delay: Math.min(index, 10) * motion.staggerStepMs }
              }
              style={[
                styles.searchRowWrap,
                selected
                  ? { backgroundColor: theme.accentSoft, borderColor: theme.accent }
                  : { backgroundColor: 'transparent', borderColor: 'transparent' },
              ]}
            >
              {content}
            </MotiView>
          );
        }}
      />
    </View>
  );
}

function SearchSkeleton({ theme }: { theme: ReturnType<typeof useTheme> }) {
  return (
    <View style={{ gap: 8, marginTop: 6 }} accessibilityLabel="Загрузка результатов">
      {[0, 1, 2, 3, 4].map((i) => (
        <View
          key={i}
          style={[styles.skeletonRow, { backgroundColor: theme.surface, borderColor: theme.line }]}
        >
          <View style={[styles.skeletonAvatar, { backgroundColor: theme.surfacePressed }]} />
          <View style={{ flex: 1, gap: 7 }}>
            <View style={{ height: 11, width: `${58 + (i % 3) * 10}%`, borderRadius: 6, backgroundColor: theme.surfacePressed }} />
            <View style={{ height: 9, width: `${34 + (i % 2) * 16}%`, borderRadius: 6, backgroundColor: theme.line }} />
          </View>
        </View>
      ))}
    </View>
  );
}

/* ---------------------------------------------------------------- ряды */

function ChatRow({
  chat,
  title,
  myUsername,
  unread,
  pinned,
  muted,
  selecting = false,
  selected = false,
  onToggleSelect,
  onMenu,
  onOpen,
}: {
  chat: Chat;
  title: string;
  myUsername: string;
  unread: number;
  pinned: boolean;
  muted: boolean;
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onMenu?: () => void;
  onOpen: () => void;
}) {
  const theme = useTheme();
  const qc = useQueryClient();
  // Тёплый старт: наведение/нажатие заранее подтягивает метаданные и историю.
  const warmUp = React.useCallback(() => {
    void prefetchChat(qc, chat);
  }, [qc, chat]);
  const peer = peerOf(chat, myUsername);
  const localPreview = useStore((s) => s.chatPreviews[chat.id]);
  const last = chat.lastMessage as
    | (NonNullable<Chat['lastMessage']> & { text?: string; delivered?: boolean; read?: boolean })
    | null;
  // Расшифрованный текст последнего сообщения берём из локального превью:
  // сервер отдаёт только метаданные (kind/sender/time).
  const freshPreview =
    localPreview &&
    (!last ||
      localPreview.id === last.id ||
      new Date(localPreview.at).getTime() >= new Date(last.createdAt).getTime())
      ? localPreview
      : null;
  const who = freshPreview?.mine || last?.senderUsername === myUsername ? 'Вы: ' : '';
  const previewText = freshPreview?.text || (typeof last?.text === 'string' ? last.text : '');
  const mediaKind = freshPreview?.kind ?? last?.kind ?? '';
  const body = previewText
    ? previewText
    : last || freshPreview
      ? mediaKind === 'text' || !mediaKind
        ? 'Сообщение'
        : 'Медиа'
      : chat.type === 'channel'
        ? 'нет постов'
        : 'нет сообщений';
  const preview = `${who}${body}`;
  const timeStr = last ? timeAgo(last.createdAt) : '';
  const pendingRequests = chat.pendingRequests ?? 0;
  const showRequests = pendingRequests > 0 && hasRight(chat, myUsername, 'manageRequests');
  const online = Boolean(peer?.nodeOnline || peer?.moduleOnline);
  const showChecks =
    Boolean(last && last.senderUsername === myUsername) &&
    (typeof last?.delivered === 'boolean' || typeof last?.read === 'boolean');

  const handleOpen = () => {
    onOpen();
  };

  const webMenu =
    Platform.OS === 'web' && onMenu
      ? ({
          onContextMenu: (e: { preventDefault?: () => void }) => {
            e.preventDefault?.();
            onMenu();
          },
        } as object)
      : {};

  return (
    <PressableScale
      pressedScale={0.985}
      onHoverIn={warmUp}
      onPress={() => {
        if (selecting) onToggleSelect?.();
        else handleOpen();
      }}
      onLongPress={() => {
        if (selecting) onToggleSelect?.();
        else onMenu?.();
      }}
      delayLongPress={320}
      accessibilityRole="button"
      accessibilityLabel={`${selecting ? (selected ? 'Снять выбор с ' : 'Выбрать ') : 'Открыть '}${title}${
        unread ? `, непрочитанных ${unread}` : ''
      }${muted ? ', без звука' : ''}`}
      style={({ pressed }) => [
        styles.row,
        {
          // Фон всегда непрозрачный: иначе при нажатии/закреплении сквозь него
          // просвечивают кнопки свайпа (эффект «мигающего» свайпа).
          backgroundColor: pressed ? theme.surfacePressed : selected || pinned ? theme.surfaceElevated : theme.surface,
          borderColor: selected ? theme.accent : pinned ? theme.accentSoft : pressed ? theme.surfacePressed : theme.line,
        },
      ]}
      {...(webMenu as {})}
    >
      {selecting ? (
        <View
          style={[
            styles.checkbox,
            {
              backgroundColor: selected ? theme.accent : 'transparent',
              borderColor: selected ? theme.accent : theme.textDisabled,
            },
          ]}
        >
          {selected ? <Ionicons name="checkmark" size={14} color={theme.onAccent} /> : null}
        </View>
      ) : null}

      <View style={{ width: 48, height: 48 }}>
        <Avatar
          name={title}
          size={48}
          hasModule={false}
          hasNode={false}
          nodeOnline={peer?.nodeOnline}
          moduleOnline={peer?.moduleOnline}
          avatar={peer?.avatar ?? chat.avatar ?? null}
        />
        {chat.type !== 'direct' ? (
          <View style={[styles.typeBadge, { backgroundColor: theme.accent, borderColor: theme.background }]}>
            <Ionicons name={chat.type === 'channel' ? 'megaphone' : 'people'} size={12} color={theme.onAccent} />
          </View>
        ) : online ? (
          <View style={[styles.onlineDot, { backgroundColor: theme.success, borderColor: theme.background }]} />
        ) : null}
      </View>

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 }}>
            {pinned ? <Ionicons name="pin" size={12} color={theme.accent} /> : null}
            {chat.encryption === 'e2e' ? <Ionicons name="lock-closed" size={12} color={theme.accent} /> : null}
            <Text style={{ color: theme.textPrimary, fontWeight: '600', fontSize: 15, flexShrink: 1 }} numberOfLines={1}>
              {title}
            </Text>
            {muted ? <Ionicons name="notifications-off" size={12} color={theme.textDisabled} /> : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            {showChecks ? (
              <Ionicons
                name={last?.read ? 'checkmark-done' : 'checkmark'}
                size={13}
                color={last?.read ? theme.accent : theme.textDisabled}
              />
            ) : null}
            <Text style={{ color: theme.textDisabled, fontSize: 11, fontVariant: ['tabular-nums'] as never }}>{timeStr}</Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
          <Text
            style={{ color: theme.textSecondary, fontSize: 13, marginTop: 2, flexShrink: 1 }}
            numberOfLines={1}
          >
            {preview}
          </Text>
          {showRequests ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 3,
                backgroundColor: theme.warningSoft,
                borderRadius: 999,
                paddingHorizontal: 7,
                paddingVertical: 1,
              }}
            >
              <Ionicons name="mail-unread" size={10} color={theme.warning} />
              <Text style={{ color: theme.warning, fontSize: 10.5, fontWeight: '700' }}>{pendingRequests} заявок</Text>
            </View>
          ) : null}
          {unread > 0 ? (
            <View
              style={{
                backgroundColor: muted ? theme.surfacePressed : theme.accent,
                borderRadius: 999,
                paddingHorizontal: 7,
                paddingVertical: 1,
                minWidth: 20,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: muted ? theme.textSecondary : theme.onAccent, fontSize: 11, fontWeight: '700' }}>{unread}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </PressableScale>
  );
}

function GroupRow({ group, onPress }: { group: GroupSearchItem; onPress: () => void }) {
  const theme = useTheme();
  const vis = normalizeVisibility(group.visibility);
  const isChannel = group.type === 'channel';
  return (
    <PressableScale
      pressedScale={0.985}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${isChannel ? 'Канал' : 'Группа'} ${group.title}, ${visibilityLabel(vis, isChannel ? 'channel' : 'group')}, ${group.membersCount} участников`}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.surfacePressed : theme.surface, borderColor: theme.line },
      ]}
    >
      <Avatar name={group.title} size={48} hasModule={false} hasNode={false} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: theme.textPrimary, fontWeight: '600', fontSize: 15 }} numberOfLines={1}>
          {group.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 }}>
          <Ionicons
            name={vis === 'private' ? 'key-outline' : vis === 'closed' ? 'shield-half-outline' : 'globe-outline'}
            size={11}
            color={theme.textSecondary}
          />
          <Text style={{ color: theme.textSecondary, fontSize: 12 }} numberOfLines={1}>
            {visibilityLabel(vis, isChannel ? 'channel' : 'group')} · {group.membersCount} участников
          </Text>
        </View>
      </View>
      <View
        style={{
          backgroundColor: group.joined ? theme.accentSoft : theme.surfacePressed,
          borderRadius: 999,
          paddingHorizontal: 9,
          paddingVertical: 4,
        }}
      >
        <Text style={{ color: group.joined ? theme.accent : theme.textSecondary, fontSize: 10.5, fontWeight: '700' }}>
          {group.joined ? 'Открыть' : isChannel ? 'Подписаться' : 'Вступить'}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={theme.textDisabled} />
    </PressableScale>
  );
}

function UserRow({
  user,
  mutual,
  busy,
  onPress,
}: {
  user: SearchUser;
  mutual: number;
  busy: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const online = Boolean(user.nodeOnline || user.moduleOnline);
  return (
    <PressableScale
      pressedScale={0.985}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Написать ${user.displayName}, @${user.username}`}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.surfacePressed : theme.surface, borderColor: theme.line },
      ]}
    >
      <View style={{ width: 48, height: 48 }}>
        <Avatar
          name={user.displayName || user.username}
          size={48}
          hasModule={false}
          hasNode={false}
          nodeOnline={user.nodeOnline}
          moduleOnline={user.moduleOnline}
          avatar={user.avatar}
        />
        {online ? <View style={[styles.onlineDot, { backgroundColor: theme.success, borderColor: theme.background }]} /> : null}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: theme.textPrimary, fontWeight: '600', fontSize: 15 }} numberOfLines={1}>
          {user.displayName || user.username}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <Text style={{ color: theme.textSecondary, fontSize: 12.5 }} numberOfLines={1}>
            @{user.username}
          </Text>
          {online ? <Text style={{ color: theme.success, fontSize: 11, fontWeight: '700' }}>онлайн</Text> : null}
          {mutual > 0 ? (
            <Text style={{ color: theme.textDisabled, fontSize: 11.5 }} numberOfLines={1}>
              · {mutual} общих групп
            </Text>
          ) : null}
        </View>
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
          backgroundColor: theme.accentSoft,
          borderRadius: 999,
          paddingHorizontal: 10,
          paddingVertical: 5,
          opacity: busy ? 0.5 : 1,
        }}
      >
        <Ionicons name={busy ? 'time-outline' : 'chatbubble-outline'} size={12} color={theme.accent} />
        <Text style={{ color: theme.accent, fontSize: 11, fontWeight: '700' }}>{busy ? 'Открываем' : 'Написать'}</Text>
      </View>
    </PressableScale>
  );
}

function MessageRow({
  hit,
  query,
  theme,
  onPress,
}: {
  hit: MessageSearchHit;
  query: string;
  theme: ReturnType<typeof useTheme>;
  onPress: () => void;
}) {
  const message = hit.message;
  const text = message.text?.trim() || (message.file?.name ? `Файл: ${message.file.name}` : 'Медиа-сообщение');
  return (
    <PressableScale
      pressedScale={0.985}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Сообщение в ${hit.chatTitle} от ${message.senderUsername}`}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.surfacePressed : theme.surface, borderColor: theme.line },
      ]}
    >
      <Avatar name={hit.chatTitle} size={48} hasModule={false} hasNode={false} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Text style={{ color: theme.textPrimary, fontWeight: '600', fontSize: 14 }} numberOfLines={1}>
            {hit.chatTitle}
          </Text>
          <Text style={{ color: theme.textDisabled, fontSize: 11 }}>{timeAgo(message.createdAt)}</Text>
        </View>
        <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
          {message.mine ? 'Вы' : `@${message.senderUsername}`}
        </Text>
        <Highlight
          text={text}
          query={query}
          color={theme.textSecondary}
          accent={theme.accent}
          accentSoft={theme.accentSoft}
          numberOfLines={2}
        />
      </View>
    </PressableScale>
  );
}

/* --------------------------------------------------------------- архив */

function ArchiveSection({
  theme,
  reduced,
  open,
  onToggle,
  chats,
  myUsername,
  mutedSet,
  pinned,
  onOpen,
  onMenu,
}: {
  theme: ReturnType<typeof useTheme>;
  reduced: boolean;
  open: boolean;
  onToggle: () => void;
  chats: Chat[];
  myUsername: string;
  mutedSet: Set<string>;
  pinned: Record<string, boolean>;
  onOpen: (chat: Chat) => void;
  onMenu: (chat: Chat) => void;
}) {
  return (
    <View style={{ marginTop: 16 }}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`${open ? 'Свернуть' : 'Развернуть'} архив, ${chats.length} чатов`}
        style={({ pressed }) => [
          styles.archiveHead,
          { backgroundColor: pressed ? theme.surfacePressed : theme.surface, borderColor: theme.line },
        ]}
      >
        <Ionicons name="archive-outline" size={17} color={theme.textSecondary} />
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '800', letterSpacing: 0.6, flex: 1 }}>
          АРХИВ · {chats.length}
        </Text>
        <MotiView animate={{ rotate: open ? '90deg' : '0deg' }} transition={reduced ? { type: 'timing', duration: 0 } : motion.quick}>
          <Ionicons name="chevron-forward" size={16} color={theme.textDisabled} />
        </MotiView>
      </Pressable>
      {open ? (
        <View style={{ gap: 6, marginTop: 6 }}>
          {chats.map((chat) => (
            <ChatRow
              key={chat.id}
              chat={chat}
              title={titleOf(chat, myUsername)}
              myUsername={myUsername}
              unread={chat.unread}
              pinned={Boolean(pinned[chat.id])}
              muted={mutedSet.has(chat.id)}
              onOpen={() => onOpen(chat)}
              onMenu={() => onMenu(chat)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/* ---------------------------------------------------------- онбординг */

function OnboardingCard() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const networkAccess = useStore((s) => hasNetworkAccess(s.me));
  const allItems = [
    { key: 'chat', icon: 'chatbubbles-outline' as const, title: 'Чат', text: 'Начните переписку', href: '/compose?mode=direct' },
    { key: 'node', icon: 'server-outline' as const, title: 'Узел', text: 'Своё хранилище', href: '/nodes' },
    { key: 'module', icon: 'hardware-chip-outline' as const, title: 'Модуль', text: 'ESP32 по BLE', href: '/modules' },
  ];
  const items = allItems.filter((item) => item.key !== 'node' || networkAccess);
  return (
    <MotiView
      from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 12 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={{ type: 'timing', duration: reduced ? 0 : 240, delay: reduced ? 0 : 80 }}
      style={[
        styles.onboarding,
        {
          backgroundColor: theme.glass,
          borderColor: theme.glassBorder,
          ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(14px)' } as object) : null),
        },
      ]}
    >
      <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: 13.5, marginBottom: 8 }}>С чего начать</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {items.map((item) => (
          <Pressable
            key={item.key}
            onPress={() => router.push(item.href as never)}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}: ${item.text}`}
            style={({ pressed }) => [
              styles.onboardingTile,
              { backgroundColor: theme.surface, borderColor: theme.line, opacity: pressed ? 0.75 : 1 },
            ]}
          >
            <Ionicons name={item.icon} size={18} color={theme.accent} />
            <Text style={{ color: theme.textPrimary, fontSize: 12, fontWeight: '600', marginTop: 4 }}>{item.title}</Text>
            <Text style={{ color: theme.textSecondary, fontSize: 10.5, marginTop: 1, textAlign: 'center' }}>{item.text}</Text>
          </Pressable>
        ))}
      </View>
    </MotiView>
  );
}

/* --------------------------------------------------------------- стили */

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  sectionTitle: {
    fontSize: 11,
    marginTop: 14,
    marginBottom: 6,
    paddingHorizontal: 6,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 16,
    borderWidth: 1,
    minHeight: 68,
  },
  staticRow: { marginBottom: 6 },
  swipeWrap: { marginBottom: 6, borderRadius: 16, overflow: 'hidden', position: 'relative' },
  swipeActions: {
    width: ACTIONS_WIDTH,
    flexDirection: 'row',
    height: '100%',
    borderRadius: 16,
    overflow: 'hidden',
  },
  swipeAction: { width: ACTION_WIDTH, height: '100%', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  onboarding: { marginHorizontal: 24, marginBottom: 24, padding: 14, borderRadius: 18, borderWidth: 1 },
  onboardingTile: { flex: 1, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 6, borderRadius: 14, borderWidth: 1, minHeight: 76 },
  typeBadge: {
    position: 'absolute',
    left: -2,
    bottom: -2,
    width: 18,
    height: 18,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  onlineDot: {
    position: 'absolute',
    right: 1,
    bottom: 1,
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 2,
  },
  checkbox: { width: 22, height: 22, borderRadius: 999, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    minHeight: 44,
    gap: 8,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 15 },
  searchClear: { padding: 4 },
  historyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    maxWidth: 180,
  },
  historyPanel: {
    position: 'absolute',
    top: 50,
    left: 0,
    right: 0,
    borderWidth: 1,
    borderRadius: 16,
    padding: 6,
    zIndex: 60,
    elevation: 12,
    overflow: 'hidden',
  },
  historyHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 6,
    paddingTop: 3,
    paddingBottom: 5,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 7,
    minHeight: 46,
  },
  historyRemove: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  filterTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    minHeight: 27,
  },
  filterCount: { borderRadius: 999, paddingHorizontal: 4, minWidth: 15, alignItems: 'center' },
  hintCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginTop: 6,
  },
  progressTrack: { height: 3, borderRadius: 999, marginHorizontal: 6, marginBottom: 6, overflow: 'hidden' },
  progressFill: { height: 3, borderRadius: 999 },
  searchRowWrap: { borderWidth: 1, borderRadius: 17, marginBottom: 6, padding: 1 },
  skeletonRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16, borderWidth: 1, minHeight: 68 },
  skeletonAvatar: { width: 48, height: 48, borderRadius: 999 },
  archiveHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 42,
  },
});
