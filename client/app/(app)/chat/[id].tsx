import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../../src/theme/useTheme';
import { useIsWide } from '../../../src/theme/useIsWide';
import { MessageBubble, type BubbleGroup, type QuotedMessage } from '../../../src/components/MessageBubble';
import type { PickedFile } from '../../../src/components/file';
import { SkeletonMessages } from '../../../src/components/skeletons/Skeleton';
import { EmptyState } from '../../../src/components/EmptyState';
import { motion } from '../../../src/theme/motion';
import { useReducedMotion } from '../../../src/components/useReducedMotion';
import { ChatHeader, type ChatChannel } from '../../../src/components/chat/ChatHeader';
import { NetworkBanner } from '../../../src/components/chat/NetworkBanner';
import { ChatMenu } from '../../../src/components/chat/ChatMenu';
import { ChatSearchBar } from '../../../src/components/chat/ChatSearchBar';
import { PinnedBanner } from '../../../src/components/chat/PinnedBanner';
import { ReplyBar } from '../../../src/components/chat/ReplyBar';
import { TypingIndicator } from '../../../src/components/chat/TypingIndicator';
import { ScrollToBottom } from '../../../src/components/chat/ScrollToBottom';
import { findCachedChat, getCachedMessages, loadCachedMessages, saveMessages } from '../../../src/data/cache';
import { MessageActionSheet } from '../../../src/components/chat/MessageActionSheet';
import { ReactionPicker } from '../../../src/components/chat/ReactionPicker';
import { AttachmentsGallery } from '../../../src/components/chat/AttachmentsGallery';
import { CommentsSheet, type CommentsPost } from '../../../src/components/chat/CommentsSheet';
import { MediaAlbum } from '../../../src/components/chat/MediaAlbum';
import { SecretBanner } from '../../../src/components/chat/SecretBanner';
import { AttachmentMenu } from '../../../src/components/chat/AttachmentMenu';
import { VoiceRecorder } from '../../../src/components/chat/VoiceRecorder';
import { useChatMessages, humanError, useDeleteMessage } from '../../../src/data/queries';
import { useQueryClient } from '@tanstack/react-query';
import {
  attachAndSendWithProgress,
  decryptEnvelopeAuto,
  sendMessage,
  type ViewMessage,
} from '../../../src/data/messaging';
import { loadChatKey, topUpAllKeys } from '../../../src/data/chatkit';
import { storage } from '../../../src/crypto/core';
import * as api from '../../../src/data/api';
import { useStore } from '../../../src/state/useStore';
import { useSounds } from '../../../src/components/useSounds';
import { useHaptics } from '../../../src/components/useHaptics';
import { CONNECTION_LABEL, useConnectionPhase } from '../../../src/components/ConnectionStatus';

/** Chat + новые поля контракта (data-слой реализует параллельно). */
type ChatExt = api.Chat & {
  encryption?: 'server' | 'e2e';
  pinnedMessage?: { id: string; senderUsername: string; createdAt: string; kind: string } | null;
};

type ViewMessageExt = ViewMessage & {
  replyTo?: string | null;
  edited?: boolean;
  reactions?: { emoji: string; count: number; mine: boolean }[];
  scheme?: 'server' | 'e2e';
  /** Число комментариев под постом канала (контракт data-слоя). */
  commentsCount?: number;
  /** Просмотры поста канала (контракт data-слоя). */
  viewsCount?: number;
  /** Пост опубликован от имени канала. */
  asChannel?: boolean;
};

/** Строка ленты: одиночное сообщение или альбом из подряд идущих фото. */
type Row = { m: ViewMessage; group: BubbleGroup; album?: ViewMessage[] };

/** Активная/неудачная загрузка медиа: отмена и повтор из состояния экрана. */
type UploadHandle = { controller: AbortController; retry: () => void };

const LOC_CLIENT_PREFIX = 'loc-';
function makeClientId(): string {
  return `${LOC_CLIENT_PREFIX}${Math.random().toString(16).slice(2, 10)}-${Date.now()}`;
}

/** Максимальная высота многострочного ввода. */
const INPUT_MAX = 120;

export default function ChatScreen() {
  const router = useRouter();
  const theme = useTheme();
  const wide = useIsWide();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; search?: string; msg?: string }>();
  const { id } = params;
  const chatId = String(id);

  const session = useStore((s) => s.session);
  const myUsername = session?.username ?? '';
  const transportOnline = useStore((s) => s.transportOnline);
  const transportGateway = useStore((s) => s.transportGateway);
  const transportModule = useStore((s) => s.transportModule);
  const transportDirect = useStore((s) => s.transportDirectPeer);
  const pushEvent = useStore((s) => s.pushEvent);
  const pushToast = useStore((s) => s.pushToast);
  const sounds = useSounds();
  const haptics = useHaptics();
  const connectionPhase = useConnectionPhase();
  const typingEntry = useStore(
    (s) => (s as unknown as { typingByChat?: Record<string, { username: string; at: number }> }).typingByChat?.[chatId],
  );

  // Чат сразу берём из локального кэша (личный/группа/канал), чтобы экран
  // открывался из памяти, а серверное обновление шло в фоне.
  const [chat, setChat] = useState<ChatExt | null>(
    () => (findCachedChat(myUsername, chatId) as ChatExt | null) ?? null,
  );
  const [cachedMessages, setCachedMessages] = useState<ViewMessage[]>(
    () => (getCachedMessages(chatId) as ViewMessage[] | null) ?? [],
  );
  const [rawKey, setRawKey] = useState<Uint8Array | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [inputHeight, setInputHeight] = useState(42);
  const [replyTo, setReplyTo] = useState<ViewMessage | null>(null);
  const [editing, setEditing] = useState<ViewMessage | null>(null);
  const [sheetMessage, setSheetMessage] = useState<ViewMessage | null>(null);
  const [reactionTarget, setReactionTarget] = useState<ViewMessage | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(-1);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [commentsPost, setCommentsPost] = useState<CommentsPost | null>(null);
  const [creatingSecret, setCreatingSecret] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadReady, setUnreadReady] = useState(false);
  const [flashIds, setFlashIds] = useState<Record<string, true>>({});
  const [typingVisible, setTypingVisible] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [dropBusy, setDropBusy] = useState(false);
  const [asChannel, setAsChannel] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  /** Локально учтённые просмотры (после markMessageView). */
  const [viewCounts, setViewCounts] = useState<Record<string, number>>({});
  /** Оверлей приватности секретного чата. */
  const [secretShield, setSecretShield] = useState(false);
  /** Клавиатура открыта: композер не должен добивать safe-area снизу. */
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  /* ---------------- оптимистичные сообщения и пагинация истории ---------------- */
  const [optimistic, setOptimistic] = useState<Record<string, ViewMessage>>({});
  const [older, setOlder] = useState<ViewMessage[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [netAttempts, setNetAttempts] = useState(0);

  const uploadsRef = useRef(new Map<string, UploadHandle>());
  const uploadCleanupRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const loadingOlderRef = useRef(false);
  const contentHeightRef = useRef(0);
  const prependAnchorRef = useRef<{ height: number; offset: number } | null>(null);
  const initialPagedRef = useRef(false);
  /**
   * Скролл к концу нужен только когда он действительно запрошен
   * (первое открытие, отправка, новое входящее), а не на каждый layout.
   */
  const pendingScrollRef = useRef(false);
  const userScrolledRef = useRef(false);
  const firstUnreadIndexRef = useRef(0);
  const unreadSeenRef = useRef<Set<string>>(new Set());
  const messageIndexRef = useRef<Map<string, number>>(new Map());
  const unreadCountRef = useRef(0);
  unreadCountRef.current = unreadCount;

  const listRef = useRef<FlatList<Row> | null>(null);
  const inputRef = useRef<TextInput | null>(null);
  const avatarRef = useRef<View | null>(null);
  const dragRootRef = useRef<View | null>(null);

  const scrollY = useRef(new Animated.Value(0)).current;
  const headerCollapse = useRef(new Animated.Value(0)).current;
  const sendScale = useRef(new Animated.Value(1)).current;
  const headerCollapsedRef = useRef(false);
  const lastScrollYRef = useRef(0);
  const atBottomRef = useRef(true);
  const prevIdsRef = useRef<Set<string> | null>(null);
  const initialScrollRef = useRef(false);
  const serverAdjustedRef = useRef(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingSentAtRef = useRef(0);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Сообщения, по которым просмотр уже отправлен — защита от спама. */
  const viewMarkedRef = useRef<Set<string>>(new Set());

  /* ------------------------------------- открытие поиска из /chat/<id>?search=1 */
  useEffect(() => {
    if (String(params.search ?? '') === '1') setSearchOpen(true);
  }, [params.search]);

  /* --------------------------------------------------------- данные чата */
  const placeholderChat = useMemo(
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
      }) as unknown as api.Chat,
    [chatId],
  );
  const chatQuery = useChatMessages(chatId ? (chat ?? placeholderChat) : null);
  const deleteMsg = useDeleteMessage(chatId);

  const queryMessages = chatQuery.data as ViewMessage[] | undefined;
  // Пока сети нет/идёт запрос — показываем сохранённую ленту, а не скелетон.
  const data = useMemo<ViewMessage[]>(() => {
    if (queryMessages && queryMessages.length > 0) return queryMessages;
    if (chatQuery.isFetchedAfterMount && queryMessages) return [];
    return cachedMessages;
  }, [queryMessages, cachedMessages, chatQuery.isFetchedAfterMount]);

  /* ---------------------------------------------- оптимистичные сообщения */
  const upsertOptimistic = useCallback((message: ViewMessage) => {
    setOptimistic((prev) => {
      const current = prev[message.id];
      // Не теряем локальное превью при замене оптимистичного сообщения серверным.
      const merged =
        current?.localPreview && !message.localPreview
          ? { ...message, localPreview: current.localPreview }
          : message;
      return { ...prev, [message.id]: merged };
    });
  }, []);

  const patchOptimistic = useCallback((id: string, patch: Partial<ViewMessage>) => {
    setOptimistic((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
  }, []);

  const removeOptimistic = useCallback((id: string) => {
    setOptimistic((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  /**
   * Склейка истории: older (пагинация) + серверные data + локальные optimistic.
   * Дубликаты убираются по clientId (сервер вернул то же сообщение) и по id.
   */
  const allMessages = useMemo<ViewMessage[]>(() => {
    const seen = new Set<string>();
    const out: ViewMessage[] = [];
    for (const m of [...older, ...data]) {
      const key = m.clientId ? `c:${m.clientId}` : `i:${m.id}`;
      if (seen.has(key) || seen.has(`i:${m.id}`)) continue;
      seen.add(key);
      seen.add(`i:${m.id}`);
      if (m.clientId) seen.add(`c:${m.clientId}`);
      out.push(m);
    }
    const pending = Object.values(optimistic)
      .filter((m) => {
        const key = m.clientId ? `c:${m.clientId}` : `i:${m.id}`;
        return !seen.has(key) && !seen.has(`i:${m.id}`) && !(m.clientId && seen.has(`c:${m.clientId}`));
      })
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return [...out, ...pending];
  }, [older, data, optimistic]);

  // Сохраняем ленту на диск: 40 прочитанных + 40 непрочитанных, не больше.
  useEffect(() => {
    if (!chatId || !allMessages.length) return;
    const lastRead = Number(chat?.lastReadSeq ?? 0);
    const read = allMessages.filter((m) => Number(m.seq) > 0 && Number(m.seq) <= lastRead).slice(-40);
    const unread = allMessages.filter((m) => Number(m.seq) > lastRead).slice(-40);
    const keep = read.length || unread.length ? [...read, ...unread] : allMessages.slice(-80);
    saveMessages(chatId, keep);
    const last = allMessages[allMessages.length - 1];
    if (last && (last.text || last.kind !== 'text')) {
      useStore.getState().setChatPreview(chatId, {
        id: last.id,
        text: String(last.text ?? ''),
        kind: last.kind,
        mine: Boolean(last.mine),
        at: last.createdAt,
      });
    }
  }, [chatId, allMessages, chat?.lastReadSeq]);

  useEffect(() => {
    messageIndexRef.current = new Map(allMessages.map((m, index) => [m.id, index]));
  }, [allMessages]);

  // Сервер подтвердил сообщение (появился clientId) — убираем оптимистичную копию.
  // Важно: только реально сохранённые сервером сообщения (seq>0), иначе
  // локальный кэш/очередь ошибочно считались бы подтверждением.
  useEffect(() => {
    const arrived = new Set<string>();
    for (const m of queryMessages ?? []) {
      if (!m || m.pending || m.failed || !(Number(m.seq) > 0)) continue;
      if (String(m.id).startsWith('loc-')) continue;
      if (m.clientId) arrived.add(m.clientId);
      arrived.add(m.id);
    }
    if (!arrived.size) return;
    setOptimistic((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const m = next[key];
        if (arrived.has(key) || arrived.has(m.id) || (m.clientId ? arrived.has(m.clientId) : false)) {
          delete next[key];
          changed = true;
          const timer = uploadCleanupRef.current.get(key);
          if (timer) {
            clearTimeout(timer);
            uploadCleanupRef.current.delete(key);
          }
          uploadsRef.current.delete(key);
        }
      }
      return changed ? next : prev;
    });
  }, [queryMessages]);

  // Смена чата: чистим локальные сообщения, пагинацию и незавершённые загрузки.
  useEffect(() => {
    setOptimistic({});
    setOlder([]);
    setHasMore(true);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    initialPagedRef.current = false;
    initialScrollRef.current = false;
    serverAdjustedRef.current = false;
    userScrolledRef.current = false;
    pendingScrollRef.current = false;
    prevIdsRef.current = null;
    prependAnchorRef.current = null;
    lastScrollYRef.current = 0;
    atBottomRef.current = true;
    setAtBottom(true);
    setNewCount(0);
    setUnreadCount(0);
    setUnreadReady(false);
    firstUnreadIndexRef.current = 0;
    unreadSeenRef.current = new Set();
    headerCollapsedRef.current = false;
    headerCollapse.setValue(0);
    scrollY.setValue(0);
    for (const timer of uploadCleanupRef.current.values()) clearTimeout(timer);
    uploadCleanupRef.current.clear();
    for (const handle of uploadsRef.current.values()) handle.controller.abort();
    uploadsRef.current.clear();
    viewMarkedRef.current.clear();
    setViewCounts({});
    setAsChannel(false);
    setSecretShield(false);
    // Лента из кэша для нового чата: память + постоянное хранилище.
    setCachedMessages((getCachedMessages(chatId) as ViewMessage[] | null) ?? []);
    let alive = true;
    void loadCachedMessages(chatId).then((list) => {
      if (alive && Array.isArray(list) && list.length) setCachedMessages(list as ViewMessage[]);
    });
    return () => {
      alive = false;
    };
  }, [chatId, headerCollapse, scrollY]);

  // Активный чат: по нему не показываем in-app уведомления и не растим unread.
  useEffect(() => {
    if (chat) useStore.getState().setActiveChat(chat);
    return () => {
      if (useStore.getState().activeChat?.id === chatId) useStore.getState().setActiveChat(null);
    };
  }, [chat?.id, chatId]);

  // Клавиатура: следим, чтобы композер не уезжал под неё и не «прыгал».
  useEffect(() => {
    if (Platform.OS === 'web') return undefined;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (event) => {
      setKeyboardOpen(true);
      setKeyboardHeight(Platform.OS === 'ios' ? Math.max(0, event.endCoordinates?.height ?? 0) : 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardOpen(false);
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Первая загрузка отдаёт 60 сообщений: если их меньше — старше уже нет.
  useEffect(() => {
    if (initialPagedRef.current || chatQuery.isLoading || !chat) return;
    initialPagedRef.current = true;
    setHasMore(data.length >= 60);
  }, [chatQuery.isLoading, chat, data.length]);

  const scheduleOptimisticCleanup = useCallback((clientId: string, delay = 30_000) => {
    const existing = uploadCleanupRef.current.get(clientId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      uploadCleanupRef.current.delete(clientId);
      uploadsRef.current.delete(clientId);
      removeOptimistic(clientId);
    }, delay);
    uploadCleanupRef.current.set(clientId, timer);
  }, [removeOptimistic]);

  // Отмечаем чат прочитанным при просмотре/после отправки: иначе счётчик
  // непрочитанных в списке и доке включает собственные сообщения.
  const qc = useQueryClient();
  const lastSeq = data.length ? data[data.length - 1]?.seq ?? 0 : 0;
  useEffect(() => {
    if (!chat || !unreadReady || !Number.isFinite(lastSeq) || lastSeq <= 0) return;
    // В группах/каналах не отмечаем всё прочитанным сразу: ждём, пока
    // пользователь доскроллит и счётчик непрочитанных обнулится.
    if (unreadCount > 0) return;
    void api.api
      .markRead(chatId, lastSeq)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ['chats'] });
      })
      .catch(() => undefined);
  }, [chat, unreadReady, unreadCount, chatId, lastSeq, qc]);

  useEffect(() => {
    let alive = true;
    void api.api
      .getChat(chatId)
      .then((c) => {
        if (alive) setChat(c as ChatExt);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [chatId]);

  const peer = chat?.members.find((m) => m.username !== myUsername);
  const title = chat
    ? chat.type === 'channel'
      ? chat.title
      : peer?.displayName || peer?.username || chat.title
    : '';
  const isE2e = (chat as ChatExt | null)?.encryption === 'e2e';
  /** Канал: под постами доступно обсуждение. */
  const isChannel = chat?.type === 'channel';
  const secret = isE2e;
  const pinned = (chat as ChatExt | null)?.pinnedMessage ?? null;
  /** Серверный чат не требует локального ключа; E2E — требует. */
  const canCompose = Boolean(chat) && (!isE2e || Boolean(rawKey));

  /** Роли участников: цвет имени в пузыре и права на посты от имени канала. */
  const rolesByUsername = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of chat?.members ?? []) map.set(member.username, member.role);
    return map;
  }, [chat]);

  const myRole = useMemo(() => {
    if (!chat) return null;
    return chat.myRole ?? rolesByUsername.get(myUsername) ?? null;
  }, [chat, rolesByUsername, myUsername]);

  /** Owner/admin/mod с правом publish могут писать в канал от его имени. */
  const canPostAsChannel = useMemo(() => {
    if (!chat || chat.type !== 'channel') return false;
    if (myRole === 'owner') return true;
    if (myRole === 'admin') return chat.permissions?.admin?.publish !== false;
    if (myRole === 'moderator') return Boolean(chat.permissions?.moderator?.publish);
    return false;
  }, [chat, myRole]);

  // Для stable onViewableItemsChanged (ref, чтобы не пересоздавать колбэк).
  const isChannelRef = useRef(isChannel);
  isChannelRef.current = isChannel;
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  /* --------------------------------------- просмотры постов канала */
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;
  const onViewableItemsChanged = useRef((info: { viewableItems: Array<{ item: Row }> }) => {
    // Непрочитанные: уменьшаем счётчик по мере появления сообщений на экране.
    if (unreadCountRef.current > 0) {
      let readNow = 0;
      for (const viewable of info.viewableItems) {
        const row = viewable.item;
        if (!row) continue;
        const messages = row.album ?? [row.m];
        for (const m of messages) {
          if (!m?.id || m.mine || m.pending) continue;
          const index = messageIndexRef.current.get(m.id);
          if (index == null || index < firstUnreadIndexRef.current) continue;
          if (unreadSeenRef.current.has(m.id)) continue;
          unreadSeenRef.current.add(m.id);
          readNow += 1;
        }
      }
      if (readNow > 0) {
        setUnreadCount((current) => Math.max(0, current - readNow));
      }
    }
    if (!isChannelRef.current) return;
    for (const viewable of info.viewableItems) {
      const row = viewable.item;
      if (!row) continue;
      const messages = row.album ?? [row.m];
      for (const m of messages) {
        if (!m?.id || m.mine || m.pending || m.id.startsWith(LOC_CLIENT_PREFIX)) continue;
        if (viewMarkedRef.current.has(m.id)) continue;
        const mark = (api.api as unknown as {
          markMessageView?: (chatId: string, messageId: string) => Promise<unknown>;
        }).markMessageView;
        if (typeof mark !== 'function') continue;
        // Один просмотр на сообщение за сессию — без спама запросами.
        viewMarkedRef.current.add(m.id);
        const base = Number((m as ViewMessageExt).viewsCount ?? 0);
        Promise.resolve(mark(chatIdRef.current, m.id))
          .then(() => {
            setViewCounts((prev) => ({ ...prev, [m.id]: prev[m.id] ?? base + 1 }));
          })
          .catch(() => undefined);
      }
    }
  }).current;

  /* ------------------------------- защита секретного чата от скриншотов */
  useEffect(() => {
    if (!secret) {
      setSecretShield(false);
      return undefined;
    }
    // Native: expo-screen-capture не подключён — намеренный no-op.
    if (Platform.OS !== 'web' || typeof document === 'undefined' || typeof window === 'undefined') return undefined;
    const hide = () => setSecretShield(true);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hide();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', hide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', hide);
    };
  }, [secret]);

  const channel: ChatChannel = useMemo(() => {
    if (transportOnline) return 'internet';
    if (transportDirect) return 'directLink';
    if (transportModule?.gateway) return 'module';
    return 'waiting';
  }, [transportOnline, transportDirect, transportModule]);

  const linkMode: 'internet' | 'gateway' | 'mesh' | undefined = transportOnline
    ? 'internet'
    : transportGateway
      ? 'gateway'
      : transportModule
        ? 'mesh'
        : undefined;

  // Счётчик попыток переподключения: тикает только в режиме ожидания сети.
  useEffect(() => {
    if (channel !== 'waiting') {
      setNetAttempts(0);
      return undefined;
    }
    setNetAttempts((n) => n + 1);
    const t = setInterval(() => setNetAttempts((n) => n + 1), 3000);
    return () => clearInterval(t);
  }, [channel]);

  /* ----------------------------------------------------------- ключи чата */
  useEffect(() => {
    // Ждём загрузки чата: для серверного шифрования локальный ключ не нужен.
    if (!chat) return undefined;
    if (chat.encryption !== 'e2e') {
      setRawKey(null);
      setStatus('');
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      const keys = await storage.loadKeys();
      if (!keys || cancelled) return;
      let key: Uint8Array | null = null;
      for (let attempt = 0; !key && attempt < 4 && !cancelled; attempt += 1) {
        key = await loadChatKey(chatId, keys);
        if (!key) await new Promise((r) => setTimeout(r, 2500));
      }
      if (cancelled) return;
      if (key) setRawKey(key);
      else setStatus('Ключ чата ещё не получен — собеседник должен передать его.');
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [chatId, chat?.encryption]);

  useEffect(() => {
    if (!rawKey) return;
    const t = setInterval(() => void topUpAllKeys(chatId, rawKey), 20_000);
    void topUpAllKeys(chatId, rawKey);
    return () => clearInterval(t);
  }, [chatId, rawKey]);

  /* ----------------------------------------------- пуш о новом сообщении */
  useEffect(() => {
    if (!pushEvent || pushEvent.kind !== 'message') return;
    const env = pushEvent.payload as api.Envelope;
    if (env.chatId !== chatId) return;
    void (async () => {
      // Схему расшифровки выбирает data-слой (server/e2e) — здесь просто обновляем.
      await chatQuery.refetch();
      if (env.senderUserId && env.senderUserId !== session?.userId) {
        // Звук и вибрацию входящих играет RealtimeBridge (глобально, с учётом mute),
        // здесь только квитанция — иначе получался двойной «дин».
        await api.api.postReceipt(chatId, env.id).catch(() => undefined);
      }
    })().catch(() => undefined);
  }, [(pushEvent?.payload as unknown as { id?: string })?.id]);

  /* -------------------------------------------------- группировка строк */
  const rows = useMemo<Row[]>(() => {
    const near = (a?: ViewMessage, b?: ViewMessage) =>
      !!a &&
      !!b &&
      a.senderUsername === b.senderUsername &&
      Math.abs(new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) < 5 * 60_000;
    const isImage = (m: ViewMessage) => {
      if (m.kind !== 'media') return false;
      const mime = (m.file?.mime ?? '').toLowerCase();
      return Boolean(m.localPreview) || mime.startsWith('image/');
    };
    const out: Row[] = [];
    let i = 0;
    while (i < allMessages.length) {
      const m = allMessages[i];
      // Альбом: ≥2 подряд идущих фото одного отправителя в окне 5 минут.
      if (isImage(m)) {
        const album: ViewMessage[] = [m];
        let j = i + 1;
        while (j < allMessages.length) {
          const next = allMessages[j];
          if (!isImage(next)) break;
          if (next.senderUsername !== m.senderUsername) break;
          if (Math.abs(new Date(next.createdAt).getTime() - new Date(m.createdAt).getTime()) >= 5 * 60_000) break;
          album.push(next);
          j += 1;
        }
        if (album.length >= 2) {
          out.push({ m, group: 'single', album });
          i = j;
          continue;
        }
      }
      const first = !near(allMessages[i - 1], m);
      const last = !near(allMessages[i + 1], m);
      const group: BubbleGroup = first && last ? 'single' : first ? 'first' : last ? 'last' : 'middle';
      out.push({ m, group });
      i += 1;
    }
    return out;
  }, [allMessages]);

  /* ------------------------------------------- пагинация истории вверх */
  const oldestSeq = useMemo(() => {
    const seqs = [...older, ...data]
      .map((m) => m.seq)
      .filter((seq) => Number.isFinite(seq) && seq > 0);
    return seqs.length ? Math.min(...seqs) : 0;
  }, [older, data]);

  const loadOlder = useCallback(async () => {
    if (!chat || loadingOlderRef.current || !hasMore) return;
    if (!oldestSeq || oldestSeq <= 1) {
      setHasMore(false);
      return;
    }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    // Якорь для сохранения позиции: высота и offset до подстановки старых сообщений.
    const anchor = { height: contentHeightRef.current, offset: lastScrollYRef.current };
    try {
      const envs = await api.api.listMessages(chatId, { before: oldestSeq, limit: 40 });
      const decrypted: ViewMessage[] = [];
      for (const env of envs) {
        try {
          // Без квитанций и topUp: пагинация не должна менять состояние чата.
          decrypted.push(await decryptEnvelopeAuto(env, chat, myUsername));
        } catch {
          /* отдельный конверт не расшифровался — пропускаем */
        }
      }
      decrypted.sort((a, b) => a.seq - b.seq);
      if (decrypted.length < 40) setHasMore(false);
      const existing = new Set([...data, ...older].map((m) => m.id));
      const add = decrypted.filter((m) => !existing.has(m.id));
      if (add.length) {
        prependAnchorRef.current = anchor;
        setOlder((prev) => {
          const seen = new Set([...data, ...prev].map((m) => m.id));
          const fresh = decrypted.filter((m) => !seen.has(m.id));
          return fresh.length ? [...fresh, ...prev] : prev;
        });
      } else if (decrypted.length) {
        // Сервер вернул только уже известные сообщения — старше двигаться некуда.
        setHasMore(false);
      }
    } catch {
      /* сеть/узел недоступны: попробуем при следующем скролле к верху */
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [chat, chatId, myUsername, hasMore, oldestSeq, data, older]);

  /* ------------------------------------------------------------- поиск */
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const searchActive = searchOpen && normalizedQuery.length > 0;
  const matchedRows = useMemo(
    () =>
      normalizedQuery
        ? allMessages
            .filter((m) => (m.text ?? '').toLowerCase().includes(normalizedQuery))
            .map((m): Row => ({ m, group: 'single' }))
        : [],
    [allMessages, normalizedQuery],
  );
  const visibleRows = useMemo<Row[]>(
    () => (searchActive ? matchedRows.map((r) => ({ m: r.m, group: 'single' as BubbleGroup })) : rows),
    [searchActive, matchedRows, rows],
  );

  useEffect(() => {
    setMatchIndex(normalizedQuery ? 0 : -1);
  }, [normalizedQuery]);

  /* --------------------------------------------------- таймер «печатает» */
  useEffect(() => {
    if (!typingEntry) {
      setTypingVisible(false);
      return undefined;
    }
    // Переключаем видимость только когда запись действительно «свежая» (< 4 сек),
    // чтобы не перерисовывать весь экран каждую секунду.
    const check = () => setTypingVisible(Date.now() - typingEntry.at < 4000);
    check();
    const t = setInterval(check, 1000);
    return () => clearInterval(t);
  }, [typingEntry]);
  const typingUsername = typingEntry && typingVisible ? typingEntry.username : null;

  /* ------------------------------------------------------- вспышка новых */
  useEffect(() => {
    const ids = new Set(data.map((m) => m.id));
    if (prevIdsRef.current && data.length) {
      const added = data.filter((m) => !prevIdsRef.current?.has(m.id));
      const incoming = added.filter((m) => !m.mine);
      if (incoming.length) {
        setFlashIds((prev) => {
          const next = { ...prev };
          for (const m of incoming) next[m.id] = true;
          return next;
        });
        if (!atBottomRef.current) setNewCount((c) => c + incoming.length);
        // Скролл к концу выполнит onContentSizeChange после раскладки —
        // без таймеров и без «прыжка» на промежуточных рендерах.
        else pendingScrollRef.current = true;
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlashIds({}), 1600);
      }
    }
    prevIdsRef.current = ids;
  }, [chatQuery.data]);

  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    // Не оставляем «висящие» загрузки и таймеры очистки при уходе с экрана.
    for (const timer of uploadCleanupRef.current.values()) clearTimeout(timer);
    uploadCleanupRef.current.clear();
    for (const handle of uploadsRef.current.values()) handle.controller.abort();
    uploadsRef.current.clear();
  }, []);

  /* --------------------------------------------------------- автоскролл */
  const scrollToEnd = useCallback((animated = true) => {
    listRef.current?.scrollToEnd({ animated });
  }, []);

  useEffect(() => {
    if (!chat || initialScrollRef.current || allMessages.length === 0) return;
    initialScrollRef.current = true;
    const totalUnread = Math.max(0, Math.min(Number(chat.unread ?? 0), allMessages.length));
    const firstUnread = Math.max(0, allMessages.length - totalUnread);
    firstUnreadIndexRef.current = firstUnread;
    unreadSeenRef.current = new Set();
    setUnreadCount(totalUnread);
    setUnreadReady(true);

    if (totalUnread > 0) {
      pendingScrollRef.current = false;
      const target = Math.max(0, firstUnread - 1);
      const timers = [250, 650, 1100].map((delay) =>
        setTimeout(() => {
          if (userScrolledRef.current) return;
          listRef.current?.scrollToIndex({ index: target, animated: false, viewPosition: 0.85 });
        }, delay),
      );
      return () => timers.forEach(clearTimeout);
    }

    pendingScrollRef.current = true;
    const timers = [200, 600, 1100].map((delay) =>
      setTimeout(() => {
        if (userScrolledRef.current) return;
        pendingScrollRef.current = false;
        scrollToEnd(false);
      }, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [chat, allMessages.length, scrollToEnd]);

  // Когда с сервера пришла полная лента, ещё раз встаём на последнее
  // прочитанное: кэш мог содержать только 8+8 сообщений.
  useEffect(() => {
    if (!chat || !chatQuery.isFetchedAfterMount || serverAdjustedRef.current || userScrolledRef.current) return undefined;
    serverAdjustedRef.current = true;
    const unread = Math.max(0, Math.min(Number(chat.unread ?? 0), allMessages.length));
    if (unread <= 0) {
      const t = setTimeout(() => {
        if (!userScrolledRef.current) scrollToEnd(false);
      }, 350);
      return () => clearTimeout(t);
    }
    const index = Math.max(0, allMessages.length - unread - 1);
    const t = setTimeout(() => {
      if (userScrolledRef.current) return;
      listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.85 });
    }, 300);
    return () => clearTimeout(t);
  }, [chat, chatQuery.isFetchedAfterMount, allMessages.length]);

  function setHeaderCollapsed(next: boolean) {
    if (headerCollapsedRef.current === next) return;
    headerCollapsedRef.current = next;
    if (reduced) {
      headerCollapse.setValue(next ? 1 : 0);
      return;
    }
    Animated.spring(headerCollapse, {
      toValue: next ? 1 : 0,
      damping: motion.softSpring.damping,
      stiffness: motion.softSpring.stiffness,
      mass: motion.softSpring.mass,
      useNativeDriver: false,
    }).start();
  }

  function onScroll(e: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const y = contentOffset.y;
    scrollY.setValue(y);

    const bottom = contentSize.height - (y + layoutMeasurement.height) < 90;

    // Направление скролла: вниз — компактная шапка, вверх — полная (Telegram-style).
    // У самого низа шапку не схлопываем: её анимация меняет высоту списка и
    // вызывает «качели» при мелких колебаниях offset.
    const prevY = lastScrollYRef.current;
    lastScrollYRef.current = y;
    if (bottom) {
      if (headerCollapsedRef.current) setHeaderCollapsed(false);
    } else if (y <= 4) setHeaderCollapsed(false);
    else if (y > prevY + 0.5 && y > 24) setHeaderCollapsed(true);
    else if (y < prevY - 0.5) setHeaderCollapsed(false);

    if (bottom !== atBottomRef.current) {
      atBottomRef.current = bottom;
      setAtBottom(bottom);
      if (bottom) {
        setNewCount(0);
        setUnreadCount(0);
      }
    }

    // Список не inverted: верх = старые сообщения, догружаем историю заранее.
    if (!searchActive && y < 90 && !bottom) void loadOlder();
  }

  /* ------------------------------------------- прокрутка к сообщению/индексу */
  const scrollToIndexSafe = useCallback(
    (index: number) => {
      if (index < 0 || index >= visibleRows.length) return;
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.45 });
    },
    [visibleRows.length],
  );

  function scrollToMessage(messageId: string) {
    const index = visibleRows.findIndex((r) => r.m.id === messageId || Boolean(r.album?.some((a) => a.id === messageId)));
    if (index >= 0) {
      scrollToIndexSafe(index);
      return;
    }
    if (searchActive) {
      setSearchOpen(false);
      setSearchQuery('');
      setTimeout(() => {
        const indexInAll = rows.findIndex((r) => r.m.id === messageId || Boolean(r.album?.some((a) => a.id === messageId)));
        if (indexInAll >= 0 && indexInAll < rows.length) {
          listRef.current?.scrollToIndex({ index: indexInAll, animated: true, viewPosition: 0.45 });
        }
      }, 160);
    }
  }

  function goMatch(delta: number) {
    if (!matchedRows.length) return;
    const next = ((matchIndex < 0 ? 0 : matchIndex) + delta + matchedRows.length) % matchedRows.length;
    setMatchIndex(next);
    scrollToIndexSafe(next);
  }

  useEffect(() => {
    if (!searchActive) return undefined;
    const t = setTimeout(() => scrollToIndexSafe(0), 120);
    return () => clearTimeout(t);
  }, [normalizedQuery, searchActive, scrollToIndexSafe]);

  /* ---------------- переход к сообщению из in-app уведомления (?msg=id) --- */
  const targetMsgId = String(params.msg ?? '');
  const msgJumpRef = useRef('');
  useEffect(() => {
    if (!targetMsgId || msgJumpRef.current === targetMsgId || !allMessages.length) return undefined;
    const index = visibleRows.findIndex(
      (row) => row.m.id === targetMsgId || Boolean(row.album?.some((m) => m.id === targetMsgId)),
    );
    if (index < 0) return undefined;
    msgJumpRef.current = targetMsgId;
    const t = setTimeout(() => {
      scrollToIndexSafe(index);
      setFlashIds((prev) => ({ ...prev, [targetMsgId]: true }));
    }, 280);
    return () => clearTimeout(t);
  }, [targetMsgId, allMessages.length, visibleRows, scrollToIndexSafe]);

  /* ------------------------------------------------------------- отправка */

  /** Пружинное нажатие кнопки отправки: сжатие 0.9 с лёгким overshoot. */
  function pressSend(pressed: boolean) {
    if (reduced) {
      sendScale.setValue(pressed ? 0.9 : 1);
      return;
    }
    Animated.spring(sendScale, {
      toValue: pressed ? 0.9 : 1,
      damping: motion.pressSpring.damping,
      stiffness: motion.pressSpring.stiffness,
      mass: motion.pressSpring.mass,
      useNativeDriver: true,
    }).start();
  }

  async function onSend() {
    const body = text.trim();
    // Оптимистичный текст не блокируем на время чужой медиа-загрузки.
    if (!canCompose || !body || (sending && editing)) return;

    if (editing) {
      setSending(true);
      setError('');
      try {
        const mod = (await import('../../../src/data/messaging')) as unknown as {
          editMessage?: (chatId: string, messageId: string, payload: { text: string }, myUsername: string) => Promise<unknown>;
        };
        if (typeof mod.editMessage !== 'function') throw new Error('Редактирование пока недоступно');
        await mod.editMessage(chatId, editing.id, { text: body }, myUsername);
        setEditing(null);
        setText('');
        inputRef.current?.clear();
        setInputHeight(42);
        await chatQuery.refetch();
        pushToast({ kind: 'success', message: 'Сообщение изменено' });
      } catch (e: unknown) {
        setError(humanError(e));
        pushToast({ kind: 'error', message: humanError(e) });
      } finally {
        setSending(false);
      }
      return;
    }

    /* --- текст: сразу локальный пузырь, сеть — потом --- */
    const clientId = makeClientId();
    const replyId = replyTo?.id;
    const postAsChannel = asChannel && canPostAsChannel;
    const optimisticMessage: ViewMessage = {
      id: clientId,
      clientId,
      seq: Number.MAX_SAFE_INTEGER,
      senderUsername: myUsername,
      mine: true,
      createdAt: new Date().toISOString(),
      kind: 'text',
      text: body,
      replyTo: replyId ?? null,
      scheme: isE2e ? 'e2e' : 'server',
      reactions: [],
      delivered: false,
      failed: false,
      pending: true,
      asChannel: postAsChannel,
    };
    upsertOptimistic(optimisticMessage);
    setText('');
    inputRef.current?.clear();
    setInputHeight(42);
    setReplyTo(null);
    atBottomRef.current = true;
    setAtBottom(true);
    setNewCount(0);
    pendingScrollRef.current = true;
    try {
      sounds.send();
      // Короткий тактильный отклик на отправку (web — 12 мс, native — light impact).
      haptics.send();
    } catch {
      /* звук не критичен */
    }

    setError('');
    const sendText = async () => {
      try {
        const vm = await sendMessage(chatId, { text: body }, 'text', myUsername, { replyTo: replyId, clientId, asChannel: postAsChannel });
        upsertOptimistic({ ...vm, clientId: vm.clientId ?? clientId, uploadStage: null });
        // Убираем локальную копию только после подтверждённой доставки.
        // Сообщение в очереди (delivered=false) остаётся в ленте до отправки.
        if (vm.delivered) scheduleOptimisticCleanup(clientId);
        // Сообщение уже отправлено: сбой фонового обновления ленты не должен
        // помечать пузырь как ошибочный.
        if (!vm.failed) await chatQuery.refetch().catch(() => undefined);
        else haptics.error();
      } catch (e: unknown) {
        patchOptimistic(clientId, { pending: false, failed: true });
        setError(humanError(e));
        haptics.error();
        sounds.error();
      }
    };
    // Повтор текста переиспользует тот же clientId: сервер не создаст дубль.
    const retryText = () => {
      const controller = new AbortController();
      uploadsRef.current.set(clientId, { controller, retry: retryText });
      patchOptimistic(clientId, { pending: true, failed: false });
      void sendText();
    };
    uploadsRef.current.set(clientId, { controller: new AbortController(), retry: retryText });
    // Не ждём сеть: локальный пузырь уже в ленте, остальное — фоном.
    void sendText();
  }

  /* --- медиа: превью → сжатие → шифрование → загрузка с прогрессом --- */
  function performMediaUpload(
    clientId: string,
    file: PickedFile,
    replyId: string | undefined,
    controller: AbortController,
    postAsChannel: boolean,
  ) {
    setSending(true);
    setError('');
    void (async () => {
      try {
        const vm = await attachAndSendWithProgress(
          chatId,
          file,
          myUsername,
          { clientId, replyTo: replyId, signal: controller.signal, asChannel: postAsChannel },
          {
            onPreview: (dataUri) => patchOptimistic(clientId, { localPreview: dataUri }),
            onStage: (stage) => patchOptimistic(clientId, { uploadStage: stage, pending: true, failed: false }),
            onProgress: (progress) => patchOptimistic(clientId, { uploadProgress: progress }),
          },
        );
        upsertOptimistic({ ...vm, clientId: vm.clientId ?? clientId, uploadStage: null, uploadProgress: 1 });
        atBottomRef.current = true;
        setAtBottom(true);
        setNewCount(0);
        pendingScrollRef.current = true;
        if (!vm.failed) {
          try {
            sounds.send();
            haptics.send();
          } catch {
            /* звук не критичен */
          }
          await chatQuery.refetch().catch(() => undefined);
        } else {
          patchOptimistic(clientId, { pending: false, failed: true, uploadStage: null, uploadProgress: 0 });
          haptics.error();
          sounds.error();
        }
        if (vm.delivered) scheduleOptimisticCleanup(clientId);
      } catch (e: unknown) {
        if (controller.signal.aborted) {
          removeOptimistic(clientId);
          uploadsRef.current.delete(clientId);
          return;
        }
        const msg = humanError(e);
        patchOptimistic(clientId, { pending: false, failed: true, uploadStage: null, uploadProgress: 0 });
        setError(msg);
        haptics.error();
        sounds.error();
        pushToast({ kind: 'error', message: msg });
      } finally {
        setSending(false);
        setDropBusy(false);
      }
    })();
  }

  function startMediaUpload(file: PickedFile, replyId?: string) {
    const clientId = makeClientId();
    const postAsChannel = asChannel && canPostAsChannel;
    const optimisticMessage: ViewMessage = {
      id: clientId,
      clientId,
      seq: Number.MAX_SAFE_INTEGER,
      senderUsername: myUsername,
      mine: true,
      createdAt: new Date().toISOString(),
      kind: 'media',
      file: { id: '', key: '', name: file.name, mime: file.mime, size: file.bytes.length },
      replyTo: replyId ?? null,
      scheme: isE2e ? 'e2e' : 'server',
      reactions: [],
      uploadStage: 'compress',
      uploadProgress: 0,
      delivered: false,
      failed: false,
      pending: true,
      asChannel: postAsChannel,
    };
    upsertOptimistic(optimisticMessage);
    setReplyTo(null);
    atBottomRef.current = true;
    setAtBottom(true);
    setNewCount(0);
    pendingScrollRef.current = true;

    const controller = new AbortController();
    const retry = () => {
      const next = new AbortController();
      uploadsRef.current.set(clientId, { controller: next, retry });
      patchOptimistic(clientId, { pending: true, failed: false, uploadStage: 'compress', uploadProgress: 0 });
      performMediaUpload(clientId, file, replyId, next, postAsChannel);
    };
    uploadsRef.current.set(clientId, { controller, retry });
    performMediaUpload(clientId, file, replyId, controller, postAsChannel);
  }

  function retryUpload(clientId: string) {
    uploadsRef.current.get(clientId)?.retry();
  }

  function cancelUpload(clientId: string) {
    uploadsRef.current.get(clientId)?.controller.abort();
    uploadsRef.current.delete(clientId);
    const timer = uploadCleanupRef.current.get(clientId);
    if (timer) {
      clearTimeout(timer);
      uploadCleanupRef.current.delete(clientId);
    }
    removeOptimistic(clientId);
  }

  function onAttach(file: PickedFile) {
    if (!canCompose) {
      setError(isE2e ? 'Ключ чата ещё не получен — медиа отправить нельзя.' : 'Чат ещё загружается — попробуйте через мгновение.');
      return;
    }
    const proceed = () => startMediaUpload(file, replyTo?.id);
    if (channel !== 'internet') {
      Alert.alert('Медиа только через интернет', 'Медиа будет отправлено, когда появится интернет. Продолжить?', [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Продолжить', onPress: proceed },
      ]);
      return;
    }
    proceed();
  }

  /* -------------------------------------------- drag&drop файлов (только web) */
  const onAttachRef = useRef(onAttach);
  onAttachRef.current = onAttach;

  useEffect(() => {
    if (Platform.OS !== 'web') return undefined;
    const node = dragRootRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== 'function') return undefined;

    let depth = 0;
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      depth += 1;
      setDragActive(true);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragActive(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      void (async () => {
        try {
          const buffer = await file.arrayBuffer();
          setDropBusy(true);
          onAttachRef.current({
            name: file.name || 'file',
            mime: file.type || 'application/octet-stream',
            bytes: new Uint8Array(buffer),
          });
        } catch {
          pushToast({ kind: 'error', message: 'Не удалось прочитать перетаскиваемый файл' });
        }
      })();
    };

    node.addEventListener('dragenter', onDragEnter);
    node.addEventListener('dragover', onDragOver);
    node.addEventListener('dragleave', onDragLeave);
    node.addEventListener('drop', onDrop);
    return () => {
      node.removeEventListener('dragenter', onDragEnter);
      node.removeEventListener('dragover', onDragOver);
      node.removeEventListener('dragleave', onDragLeave);
      node.removeEventListener('drop', onDrop);
    };
  }, [pushToast]);

  // Индикатор загрузки перетаскиваемого файла гаснет, когда отправка завершилась.
  useEffect(() => {
    if (!dropBusy || sending) return undefined;
    const t = setTimeout(() => setDropBusy(false), 600);
    return () => clearTimeout(t);
  }, [dropBusy, sending]);

  /* --------------------------------------------------------------- typing */
  useEffect(() => {
    if (!text.trim() || editing || !canCompose) return undefined;
    const nowMs = Date.now();
    const wait = Math.max(1500, 3000 - (nowMs - typingSentAtRef.current));
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      typingSentAtRef.current = Date.now();
      const p = (api.api as unknown as { typing?: (id: string) => Promise<unknown> }).typing?.(chatId);
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    }, wait);
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [text, chatId, editing, canCompose]);

  /* ------------------------------------------------------------- действия */
  async function copyText(value: string) {
    setSheetMessage(null);
    if (!value) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(value);
      } else {
        const { Clipboard } = await import('react-native');
        Clipboard.setString(value);
      }
      pushToast({ kind: 'success', message: 'Скопировано' });
    } catch {
      pushToast({ kind: 'error', message: 'Не удалось скопировать' });
    }
  }

  function startReply(m: ViewMessage) {
    setSheetMessage(null);
    setEditing(null);
    setReplyTo(m);
    setTimeout(() => inputRef.current?.focus(), 60);
  }

  function startEdit(m: ViewMessage) {
    setSheetMessage(null);
    setReplyTo(null);
    setEditing(m);
    setText(m.text ?? '');
    setInputHeight(42);
    setTimeout(() => inputRef.current?.focus(), 60);
  }

  function cancelReplyOrEdit() {
    setReplyTo(null);
    if (editing) {
      setEditing(null);
      setText('');
      setInputHeight(42);
    }
  }

  async function reactTo(m: ViewMessage, emoji: string) {
    setSheetMessage(null);
    try {
      const action = (api.api as unknown as { setReaction?: (chatId: string, messageId: string, emoji: string) => Promise<unknown> }).setReaction;
      if (!action) throw new Error('Реакции пока недоступны');
      await action(chatId, m.id, emoji);
      await chatQuery.refetch();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  async function pinMessage(m: ViewMessage | null) {
    setSheetMessage(null);
    try {
      const action = (api.api as unknown as { pinMessage?: (chatId: string, messageId: string | null) => Promise<unknown> }).pinMessage;
      if (!action) throw new Error('Закрепление пока недоступно');
      const wasPinned = m === null || pinned?.id === m.id;
      await action(chatId, wasPinned ? null : m.id);
      const fresh = await api.api.getChat(chatId).catch(() => null);
      if (fresh) setChat(fresh as ChatExt);
      pushToast({ kind: 'success', message: wasPinned ? 'Сообщение откреплено' : 'Сообщение закреплено' });
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  function confirmDelete(m: ViewMessage) {
    setSheetMessage(null);
    Alert.alert('Удалить сообщение?', 'Шифротекст будет удалён с узлов сети.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: () => {
          void deleteMsg
            .mutateAsync(m.id)
            .then(() => chatQuery.refetch())
            .catch((e: unknown) => pushToast({ kind: 'error', message: humanError(e) }));
        },
      },
    ]);
  }

  async function createSecretChat() {
    if (!chat || chat.type !== 'direct') return;
    const other = chat.members.find((m) => m.username !== myUsername);
    if (!other) {
      pushToast({ kind: 'error', message: 'Не удалось определить собеседника' });
      return;
    }
    setMenuOpen(false);
    setCreatingSecret(true);
    try {
      const create = (api.api as unknown as {
        createChat: (input: { type: 'direct'; username: string; encryption: 'e2e' }) => Promise<api.Chat>;
      }).createChat;
      const created = await create({ type: 'direct', username: other.username, encryption: 'e2e' });
      // Для E2E-чата сразу создаём ключ чата и раскладываем его по устройствам
      // участников, иначе новый чат был бы «пустым» до ручного запроса ключа.
      try {
        const core = await import('../../../src/crypto/core');
        const keys = await core.storage.loadKeys();
        if (keys) {
          const bundle = await api.api.getBundle(other.username).catch(() => ({ devices: [] as { deviceId: string; ecdhPub: string }[] }));
          const { createAndShareChatKey } = await import('../../../src/data/chatkit');
          await createAndShareChatKey(
            created.id,
            [
              { deviceId: keys.deviceId, ecdhPub: JSON.stringify(core.publicJwkOf(keys.ecdhPriv)) },
              ...bundle.devices.map((d) => ({ deviceId: d.deviceId, ecdhPub: d.ecdhPub })),
            ],
            keys,
          );
          const { refreshKeyBackup } = await import('../../../src/data/auth');
          void refreshKeyBackup();
        }
      } catch {
        /* ключ можно будет дослать позже: чат уже создан */
      }
      pushToast({ kind: 'success', message: 'Секретный чат создан — история не синхронизируется' });
      router.push(`/chat/${created.id}` as never);
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    } finally {
      setCreatingSecret(false);
    }
  }

  /* ------------------------------------------------------- цитата/пин-текст */
  const quotedFor = useCallback(
    (m: ViewMessage): QuotedMessage | null => {
      const replyId = (m as ViewMessageExt).replyTo;
      if (!replyId) return null;
      const target = allMessages.find((x) => x.id === replyId || x.clientId === replyId);
      if (!target) return { id: replyId, username: 'Сообщение', text: 'Не загружено' };
      return {
        id: target.id,
        username: target.senderUsername,
        text: target.text || target.file?.name || 'Вложение',
      };
    },
    [allMessages],
  );

  const pinnedMessage = pinned ? allMessages.find((m) => m.id === pinned.id) ?? null : null;
  const pinnedText = pinnedMessage
    ? pinnedMessage.text || pinnedMessage.file?.name || 'Вложение'
    : pinned
      ? 'Закреплённое сообщение'
      : '';
  const pinnedUsername = pinnedMessage?.senderUsername ?? pinned?.senderUsername;

  const canCreateSecret = Boolean(chat && chat.type === 'direct' && (chat as ChatExt).encryption === 'server');

  /* ---------------------- онлайн-статусы участников для обводок аватаров */
  const memberPresence = useMemo(() => {
    const map = new Map<string, { nodeOnline?: boolean; moduleOnline?: boolean; avatar?: { objectId: string; key: string; mime: string } | null }>();
    for (const member of chat?.members ?? []) {
      map.set(member.username, { nodeOnline: member.nodeOnline, moduleOnline: member.moduleOnline, avatar: member.avatar });
    }
    return map;
  }, [chat]);
  const peerPresence = chat?.type === 'direct' && peer ? memberPresence.get(peer.username) : undefined;

  return (
    <KeyboardAvoidingView
      style={{
        flex: 1,
        backgroundColor: theme.background,
        // iOS: явно уменьшаем высоту экрана на высоту клавиатуры.
        // KAV padding в связке с react-native-screens иногда не срабатывает,
        // поэтому используем проверенный явный отступ.
        paddingBottom: Platform.OS === 'ios' ? keyboardHeight : 0,
      }}
      behavior={undefined}
      keyboardVerticalOffset={0}
    >
      <View
        ref={dragRootRef}
        style={{
          flex: 1,
          backgroundColor: theme.background,
          // Акцентная рамка вокруг экрана секретного чата.
          borderWidth: secret ? 1.5 : 0,
          borderColor: secret ? theme.accent : 'transparent',
        }}
      >
        <ChatHeader
          title={title || 'Диалог'}
          channel={channel}
          linkMode={linkMode}
          statusText={connectionPhase ? CONNECTION_LABEL[connectionPhase] : null}
          secret={secret}
          typingUsername={typingUsername}
          scrollY={scrollY}
          collapse={headerCollapse}
          onBack={() => router.back()}
          onMenu={() => setMenuOpen((v) => !v)}
          onOpenInfo={() => {
            setMenuOpen(false);
            router.push(`/chat/${chatId}/info` as never);
          }}
          avatarRef={avatarRef}
          nodeOnline={peerPresence?.nodeOnline}
          moduleOnline={peerPresence?.moduleOnline}
          avatar={peerPresence?.avatar ?? chat?.avatar ?? null}
          chatType={chat?.type}
          membersCount={chat?.membersCount}
        />

        {secret ? <SecretBanner /> : null}

        {pinned ? (
          <PinnedBanner
            text={pinnedText}
            username={pinnedUsername}
            onPress={() => {
              if (pinnedMessage) scrollToMessage(pinnedMessage.id);
              else pushToast({ kind: 'info', message: 'Закреплённое сообщение не загружено' });
            }}
            onUnpin={() => void pinMessage(null)}
          />
        ) : null}

        {searchOpen ? (
          <ChatSearchBar
            value={searchQuery}
            onChange={setSearchQuery}
            count={matchedRows.length}
            currentIndex={matchIndex}
            onPrev={() => goMatch(-1)}
            onNext={() => goMatch(1)}
            onClose={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
          />
        ) : null}

        {error ? (
          <Text style={{ color: theme.danger, paddingHorizontal: 14, paddingVertical: 6, fontSize: 13 }} numberOfLines={2}>
            {error}
          </Text>
        ) : null}
        {status ? (
          <Text style={{ color: theme.warning, paddingHorizontal: 14, paddingVertical: 6, fontSize: 12.5 }} numberOfLines={2}>
            {status}
          </Text>
        ) : null}

        <View style={{ flex: 1 }}>
          {(chatQuery.isLoading || !chat) && allMessages.length === 0 ? (
            <SkeletonMessages count={8} />
          ) : allMessages.length === 0 ? (
            canCompose ? (
              <EmptyState title="Пустой чат" subtitle="Сообщений нет — напишите первым" />
            ) : (
              <EmptyState
                title="Ключ чата недоступен"
                subtitle="История этого чата была зашифрована ключом, которого нет на устройстве. Новые сообщения будут расшифровываться автоматически."
              />
            )
          ) : searchActive && matchedRows.length === 0 ? (
            <EmptyState title="Ничего не найдено" subtitle={`По запросу «${searchQuery.trim()}» совпадений нет`} />
          ) : (
            <FlatList
              ref={listRef}
              data={visibleRows}
              keyExtractor={(r) => (r.album ? `album:${r.album.map((m) => m.clientId ?? m.id).join(',')}` : r.m.clientId ?? r.m.id)}
              ListHeaderComponent={
                loadingOlder ? (
                  <View style={styles.olderSpinner} accessibilityLabel="Загружаем историю">
                    <ActivityIndicator size="small" color={theme.textSecondary} />
                  </View>
                ) : null
              }
              contentContainerStyle={{
                padding: wide ? 24 : 10,
                paddingBottom: 26,
                maxWidth: 900,
                width: '100%',
                alignSelf: 'center',
              }}
              renderItem={({ item: row, index }) => (
                <View>
                  {row.album ? (
                    <MediaAlbum
                      messages={row.album}
                      mine={row.m.mine}
                      role={row.m.mine ? myRole : rolesByUsername.get(row.m.senderUsername)}
                      channelTitle={
                        (row.m as ViewMessageExt).asChannel || (row.m.mine && asChannel && canPostAsChannel)
                          ? chat?.title ?? null
                          : null
                      }
                      viewsCount={
                        isChannel
                          ? Math.max(
                              ...row.album.map(
                                (m) => viewCounts[m.id] ?? (m as ViewMessageExt).viewsCount ?? 0,
                              ),
                            )
                          : undefined
                      }
                      onReactionPress={(emoji, m) => void reactTo(m, emoji)}
                      avatar={memberPresence.get(row.m.senderUsername)?.avatar}
                      nodeOnline={memberPresence.get(row.m.senderUsername)?.nodeOnline}
                      moduleOnline={memberPresence.get(row.m.senderUsername)?.moduleOnline}
                      onOpenComments={
                        isChannel
                          ? () => {
                              const last = row.album![row.album!.length - 1];
                              setCommentsPost({
                                id: last.id,
                                text: last.text,
                                senderUsername: last.senderUsername,
                                createdAt: last.createdAt,
                                kind: last.kind,
                              });
                            }
                          : undefined
                      }
                      commentsCount={
                        isChannel
                          ? row.album.reduce((sum, m) => sum + ((m as ViewMessageExt).commentsCount ?? 0), 0)
                          : undefined
                      }
                    />
                  ) : (
                    <MessageBubble
                      item={row.m}
                      group={row.group}
                      onCopy={(t) => void copyText(t)}
                      onReply={() => startReply(row.m)}
                      onDelete={() => confirmDelete(row.m)}
                      onOpenMenu={() => {
                        if (Platform.OS === 'web') (globalThis as { getSelection?: () => Selection | null }).getSelection?.()?.removeAllRanges();
                        setReactionTarget(row.m);
                      }}
                      quoted={quotedFor(row.m)}
                      onQuotePress={() => {
                        const q = quotedFor(row.m);
                        if (q) scrollToMessage(q.id);
                      }}
                      highlight={searchActive ? searchQuery : ''}
                      highlightActive={searchActive && index === matchIndex}
                      flash={Boolean(flashIds[row.m.id])}
                      onReactionPress={(emoji) => void reactTo(row.m, emoji)}
                      nodeOnline={memberPresence.get(row.m.senderUsername)?.nodeOnline}
                      moduleOnline={memberPresence.get(row.m.senderUsername)?.moduleOnline}
                      avatar={memberPresence.get(row.m.senderUsername)?.avatar}
                      role={row.m.mine ? myRole : rolesByUsername.get(row.m.senderUsername)}
                      asChannelTitle={
                        (row.m as ViewMessageExt).asChannel || (row.m.mine && asChannel && canPostAsChannel)
                          ? chat?.title ?? null
                          : null
                      }
                      secret={secret}
                      viewsCount={
                        isChannel
                          ? viewCounts[row.m.id] ?? (row.m as ViewMessageExt).viewsCount
                          : undefined
                      }
                      onAvatarPress={
                        row.m.mine || !row.m.senderUsername || (row.m as ViewMessageExt).asChannel
                          ? undefined
                          : () => router.push(`/user/${row.m.senderUsername}` as never)
                      }
                      onOpenComments={
                        isChannel
                          ? () =>
                              setCommentsPost({
                                id: row.m.id,
                                text: row.m.text,
                                senderUsername: row.m.senderUsername,
                                createdAt: row.m.createdAt,
                                kind: row.m.kind,
                              })
                          : undefined
                      }
                      commentsCount={isChannel ? (row.m as ViewMessageExt).commentsCount ?? 0 : undefined}
                      uploadProgress={row.m.uploadProgress}
                      uploadStage={row.m.uploadStage ?? null}
                      localPreview={row.m.localPreview}
                      failed={row.m.failed}
                      onRetryUpload={uploadsRef.current.has(row.m.id) ? () => retryUpload(row.m.id) : undefined}
                      onCancelUpload={uploadsRef.current.has(row.m.id) ? () => cancelUpload(row.m.id) : undefined}
                    />
                  )}
                </View>
              )}
              onScroll={onScroll}
              scrollEventThrottle={16}
              onViewableItemsChanged={onViewableItemsChanged}
              viewabilityConfig={viewabilityConfig}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              onScrollBeginDrag={() => {
                userScrolledRef.current = true;
              }}
              onContentSizeChange={(_w, h) => {
                contentHeightRef.current = h;
                // После подгрузки старой истории компенсируем рост контента,
                // чтобы список не «прыгал» вверх.
                const anchor = prependAnchorRef.current;
                if (anchor) {
                  prependAnchorRef.current = null;
                  const delta = h - anchor.height;
                  if (delta > 0) {
                    setTimeout(() => listRef.current?.scrollToOffset({ offset: anchor.offset + delta, animated: false }), 0);
                  }
                  return;
                }
                // Автоскролл только по явному запросу (открытие/отправка/новое),
                // иначе каждый layout дёргал ленту.
                if (pendingScrollRef.current && !searchActive) {
                  pendingScrollRef.current = false;
                  scrollToEnd(false);
                }
              }}
              onScrollToIndexFailed={(info) => {
                listRef.current?.scrollToOffset({
                  offset: Math.max(0, info.averageItemLength * info.index),
                  animated: true,
                });
                setTimeout(() => {
                  listRef.current?.scrollToIndex({
                    index: Math.min(info.index, Math.max(0, visibleRows.length - 1)),
                    animated: true,
                    viewPosition: 0.45,
                  });
                }, 160);
              }}
            />
          )}

          <ScrollToBottom
            visible={!atBottom || unreadCount > 0 || newCount > 0}
            count={Math.max(unreadCount, newCount)}
            onPress={() => {
              atBottomRef.current = true;
              setAtBottom(true);
              setNewCount(0);
              setUnreadCount(0);
              scrollToEnd(true);
            }}
          />
        </View>

        {typingUsername ? <TypingIndicator username={typingUsername} /> : null}

        {dropBusy ? (
          <MotiView
            from={{ opacity: 0, translateY: 8 }}
            animate={{ opacity: 1, translateY: 0 }}
            transition={{ type: 'timing', duration: 180 }}
            style={[styles.uploadPill, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}
          >
            <Ionicons name="cloud-upload-outline" size={15} color={theme.accent} />
            <Text style={{ color: theme.accent, fontSize: 12.5, fontWeight: '600', flex: 1 }}>
              Отправляем файл — шифруем и раскладываем по узлам…
            </Text>
          </MotiView>
        ) : null}

        <NetworkBanner visible={channel === 'waiting'} attempts={netAttempts} />

        {replyTo ? <ReplyBar mode="reply" username={replyTo.senderUsername} text={replyTo.text || replyTo.file?.name || 'Вложение'} onClose={cancelReplyOrEdit} /> : null}
        {editing ? <ReplyBar mode="edit" text={editing.text || ''} onClose={cancelReplyOrEdit} /> : null}

        {canPostAsChannel ? (
          <MotiView
            from={reduced ? { opacity: 1 } : { opacity: 0, translateY: 6 }}
            animate={{ opacity: 1, translateY: 0 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
            style={styles.channelRow}
          >
            <Pressable
              onPress={() => setAsChannel((v) => !v)}
              accessibilityRole="switch"
              accessibilityState={{ checked: asChannel }}
              accessibilityLabel="Публиковать от имени канала"
              style={({ pressed }) => [
                styles.channelChip,
                {
                  backgroundColor: asChannel ? theme.accent : theme.surface,
                  borderColor: asChannel ? theme.accent : theme.line,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <Ionicons name="megaphone" size={13} color={asChannel ? theme.onAccent : theme.textSecondary} />
              <Text style={{ color: asChannel ? theme.onAccent : theme.textSecondary, fontSize: 12, fontWeight: '700' }}>
                От имени канала
              </Text>
              {asChannel ? <Ionicons name="checkmark-circle" size={14} color={theme.onAccent} /> : null}
            </Pressable>
          </MotiView>
        ) : null}

        <View
          style={[
            styles.composer,
            {
              borderTopColor: theme.line,
              opacity: canCompose ? 1 : 0.65,
              // Safe-area снизу только при закрытой клавиатуре: иначе KAV уже
              // поднял композер, и лишний отступ даёт «пузырь» над клавиатурой.
              paddingBottom: keyboardOpen ? 10 : Math.max(12, insets.bottom + 6),
            },
          ]}
        >
          <Pressable
            onPress={() => setAttachOpen((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel="Вложения"
            accessibilityState={{ expanded: attachOpen }}
            hitSlop={6}
            style={({ pressed }) => [styles.attach, { opacity: pressed ? 0.65 : 1 }]}
          >
            <MotiView
              animate={{ rotate: attachOpen ? '45deg' : '0deg' }}
              transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
            >
              <Ionicons name="add" size={24} color={theme.textSecondary} />
            </MotiView>
          </Pressable>
          <TextInput
            ref={inputRef}
            value={text}
            onChangeText={setText}
            multiline
            editable={canCompose}
            placeholder={
              !chat
                ? 'Загружаем чат…'
                : editing
                  ? 'Изменить сообщение'
                  : canCompose
                    ? 'Сообщение'
                    : 'Ожидаем ключ чата…'
            }
            placeholderTextColor={theme.textDisabled}
            accessibilityLabel="Поле ввода сообщения"
            onContentSizeChange={(e) => {
              const h = e.nativeEvent.contentSize.height;
              // на web contentSize уже включает padding — не добавляем лишние 20px
              setInputHeight(Math.min(INPUT_MAX, Math.max(42, Platform.OS === 'web' ? h : h + 20)));
            }}
            onKeyPress={(e) => {
              // Enter отправляет, Shift+Enter переносит строку (web).
              if (Platform.OS !== 'web') return;
              const ne = e.nativeEvent as unknown as { key?: string; shiftKey?: boolean };
              if (ne.key === 'Enter' && !ne.shiftKey) {
                (e as unknown as { preventDefault?: () => void }).preventDefault?.();
                void onSend();
              }
            }}
            style={[
              styles.input,
              {
                backgroundColor: theme.surface,
                color: theme.textPrimary,
                borderColor: editing ? theme.accent : theme.line,
                maxWidth: 860,
                height: inputHeight,
              },
            ]}
          />
          {!text.trim() && !editing ? (
            <VoiceRecorder
              onSend={(file) => onAttach(file)}
              onError={(message) => pushToast({ kind: 'error', message })}
              disabled={!canCompose}
            />
          ) : null}
          <Animated.View style={{ transform: [{ scale: sendScale }] }}>
            <Pressable
              onPress={() => void onSend()}
              onPressIn={() => pressSend(true)}
              onPressOut={() => pressSend(false)}
              disabled={!canCompose || !text.trim() || (sending && Boolean(editing))}
              accessibilityRole="button"
              accessibilityLabel={editing ? 'Сохранить изменения' : 'Отправить'}
              style={({ pressed }) => [
                styles.send,
                {
                  backgroundColor: theme.accent,
                  opacity: !canCompose || !text.trim() || (sending && Boolean(editing)) ? 0.45 : pressed ? 0.85 : 1,
                },
              ]}
            >
              {editing ? (
                <Ionicons name="checkmark" size={21} color={theme.onAccent} />
              ) : (
                <Ionicons name="paper-plane" size={18} color={theme.onAccent} />
              )}
            </Pressable>
          </Animated.View>
        </View>

        <AttachmentMenu
          visible={attachOpen}
          onClose={() => setAttachOpen(false)}
          onPicked={onAttach}
        />

        <ChatMenu
          visible={menuOpen}
          onClose={() => setMenuOpen(false)}
          onSearch={() => {
            setMenuOpen(false);
            setSearchOpen(true);
          }}
          onAttachments={() => {
            setMenuOpen(false);
            setGalleryOpen(true);
          }}
          onSecret={canCreateSecret ? () => void createSecretChat() : null}
          creatingSecret={creatingSecret}
        />

        <ReactionPicker
          visible={Boolean(reactionTarget)}
          onClose={() => setReactionTarget(null)}
          onPick={(emoji) => {
            if (reactionTarget) void reactTo(reactionTarget, emoji);
            setReactionTarget(null);
          }}
          onMore={() => {
            setSheetMessage(reactionTarget);
            setReactionTarget(null);
          }}
        />

        <MessageActionSheet
          message={sheetMessage}
          pinned={Boolean(sheetMessage && pinned?.id === sheetMessage.id)}
          allowCopy={!secret}
          onClose={() => setSheetMessage(null)}
          onReact={(emoji) => sheetMessage && void reactTo(sheetMessage, emoji)}
          onReply={() => sheetMessage && startReply(sheetMessage)}
          onCopy={() => sheetMessage && void copyText(sheetMessage.text ?? '')}
          onEdit={() => sheetMessage && startEdit(sheetMessage)}
          onDelete={() => sheetMessage && confirmDelete(sheetMessage)}
          onPin={() => void pinMessage(sheetMessage)}
        />

        <AttachmentsGallery visible={galleryOpen} messages={allMessages} onClose={() => setGalleryOpen(false)} />

        <CommentsSheet
          visible={Boolean(commentsPost)}
          chatId={chatId}
          post={commentsPost}
          encryption={(chat as ChatExt | null)?.encryption === 'e2e' ? 'e2e' : 'server'}
          onClose={() => setCommentsPost(null)}
          onChanged={() => void chatQuery.refetch()}
        />

        {dragActive ? (
          <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, styles.dropOverlay]}>
            <MotiView
              from={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: 'spring', damping: 22, stiffness: 280 }}
              style={[styles.dropCard, { backgroundColor: theme.surfaceElevated, borderColor: theme.accent }]}
            >
              <Ionicons name="cloud-upload-outline" size={34} color={theme.accent} />
              <Text style={{ color: theme.textPrimary, fontSize: 16, fontWeight: '700' }}>Отпустите файл</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5 }}>Он будет зашифрован и отправлен в чат</Text>
            </MotiView>
          </View>
        ) : null}

        {secret && secretShield ? (
          <View
            style={[
              StyleSheet.absoluteFillObject,
              styles.secretShield,
              Platform.OS === 'web' ? ({ backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)' } as object) : null,
            ]}
          >
            <MotiView
              from={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
              style={[styles.secretCard, { backgroundColor: theme.surfaceElevated, borderColor: theme.accent, ...theme.shadow }]}
            >
              <View style={[styles.secretIcon, { backgroundColor: theme.accentSoft }]}>
                <Ionicons name="eye-off" size={26} color={theme.accent} />
              </View>
              <Text style={{ color: theme.textPrimary, fontSize: 16, fontWeight: '800' }}>Содержимое скрыто</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5, textAlign: 'center' }}>
                Секретный чат скрывается при потере фокуса или переключении вкладки
              </Text>
              <Pressable
                onPress={() => setSecretShield(false)}
                accessibilityRole="button"
                accessibilityLabel="Показать содержимое чата"
                style={({ pressed }) => [
                  styles.secretShow,
                  { backgroundColor: theme.accent, opacity: pressed ? 0.85 : 1 },
                ]}
              >
                <Ionicons name="eye" size={16} color={theme.onAccent} />
                <Text style={{ color: theme.onAccent, fontSize: 13, fontWeight: '700' }}>Показать</Text>
              </Pressable>
            </MotiView>
          </View>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  olderSpinner: { paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  noChannelPill: { marginHorizontal: 12, marginBottom: 6, padding: 9, borderRadius: 10, flexDirection: 'row', gap: 8, alignItems: 'center' },
  channelRow: { paddingHorizontal: 12, paddingBottom: 6, maxWidth: 940, width: '100%', alignSelf: 'center' },
  channelChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  secretShield: {
    zIndex: 220,
    backgroundColor: 'rgba(10,14,20,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  secretCard: { width: '100%', maxWidth: 340, borderRadius: 20, borderWidth: 1.5, padding: 20, alignItems: 'center', gap: 9 },
  secretIcon: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  secretShow: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
  },
  uploadPill: {
    marginHorizontal: 12,
    marginBottom: 6,
    padding: 9,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  composer: {
    paddingTop: 9,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 12,
    alignItems: 'flex-end',
    justifyContent: 'center',
    width: '100%',
    maxWidth: 940,
    alignSelf: 'center',
  },
  input: { flex: 1, borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, minHeight: 42, textAlignVertical: 'top' },
  attach: { width: 34, height: 42, alignItems: 'center', justifyContent: 'center' },
  send: { width: 42, height: 42, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  dropOverlay: {
    zIndex: 80,
    backgroundColor: 'rgba(5,9,15,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  dropCard: {
    alignItems: 'center',
    gap: 8,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 20,
    paddingHorizontal: 34,
    paddingVertical: 28,
  },
});
