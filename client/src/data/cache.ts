/**
 * Постоянный кэш клиента для офлайн-старта.
 *
 * Хранилище — `kv` из `../crypto/storage` (AsyncStorage на native,
 * localStorage на web). Данные кладутся с версией и временем сохранения;
 * всё чтение/запись обёрнуто в try/catch, чтобы битый или переполненный
 * storage никогда не ломал UI.
 *
 * Синхронный in-memory слой (`Map`) нужен, чтобы react-query и Avatar
 * получали placeholder мгновенно, не дожидаясь асинхронного storage.
 * `loadCaches()` наполняет этот слой при старте приложения.
 */
import { Platform } from 'react-native';
import { kv } from '../crypto/storage';
import type { Chat, User, UserProfile } from './api';

/** Версия формата записей: при несовпадении запись игнорируется. */
export const CACHE_VERSION = 1;

/** Не храним больше ~300 чатов на пользователя. */
export const MAX_CACHED_CHATS = 300;
/** Максимальный размер одного аватара (data URI, символов ≈ байт base64). */
export const MAX_AVATAR_BYTES = 1_500_000;
/** Предохранитель для остальных записей (профиль/чаты), ~4 МБ. */
const MAX_ENTRY_CHARS = 4_000_000;
/** Сколько профилей индексируем для офлайн-загрузки. */
const MAX_CACHED_PROFILES = 100;
/** Аватары в памяти: не держим больше, чтобы не раздувать heap. */
const MAX_MEMORY_AVATARS = 300;

const PREFIX = 'sg:cache:';
const AVATAR_PREFIX = 'sg:avatar:';
const ME_KEY = `${PREFIX}me`;
const PROFILE_INDEX_KEY = `${PREFIX}profiles:index`;

const profileKey = (username: string) => `${PREFIX}profile:${username.trim().toLowerCase()}`;
const chatsKey = (username: string) => `${PREFIX}chats:${username}`;

interface Envelope<T> {
  v: number;
  savedAt: number;
  data: T;
}

/** Синхронный слой: логический ключ → данные. */
const memory = new Map<string, unknown>();
/** Синхронный слой аватаров: objectId → data URI. */
const avatarMemory = new Map<string, string>();
let profileIndex: string[] = [];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readEnvelope<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    if (parsed.v !== CACHE_VERSION) return null;
    return (parsed.data as T) ?? null;
  } catch {
    return null;
  }
}

/** Безопасная запись: обновляет Map сразу, storage — в фоне. */
function writeEntry(key: string, data: unknown): void {
  try {
    const payload = JSON.stringify({ v: CACHE_VERSION, savedAt: Date.now(), data } satisfies Envelope<unknown>);
    if (payload.length > MAX_ENTRY_CHARS) return;
    void kv.set(key, payload).catch(() => undefined);
  } catch {
    /* circular / quota / serialization error */
  }
}

async function readEntry<T>(key: string): Promise<T | null> {
  try {
    return readEnvelope<T>(await kv.get(key));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ me ---- */

export function getCachedMe(): User | null {
  const value = memory.get('me');
  return isObject(value) && typeof value.username === 'string' ? (value as unknown as User) : null;
}

export function saveMe(user: User | null | undefined): void {
  if (!isObject(user) || typeof user.username !== 'string' || !user.username) return;
  try {
    memory.set('me', user);
    writeEntry(ME_KEY, user);
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------- chats ---- */

export function getCachedChats(username: string | null | undefined): Chat[] | null {
  if (!username) return null;
  const value = memory.get(`chats:${username}`);
  return Array.isArray(value) ? (value as Chat[]) : null;
}

export function saveChats(username: string | null | undefined, chats: Chat[] | null | undefined): void {
  if (!username || !Array.isArray(chats)) return;
  try {
    const trimmed = chats.slice(0, MAX_CACHED_CHATS);
    memory.set(`chats:${username}`, trimmed);
    writeEntry(chatsKey(username), trimmed);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------- профили ---- */

export function getCachedProfile(username: string | null | undefined): UserProfile | null {
  if (!username) return null;
  const value = memory.get(`profile:${username.trim().toLowerCase()}`);
  return isObject(value) && typeof value.username === 'string' ? (value as unknown as UserProfile) : null;
}

/** Дочитывает профиль из постоянного кэша (для офлайн-открытия). */
export async function loadCachedProfile(username: string | null | undefined): Promise<UserProfile | null> {
  if (!username) return null;
  const inMemory = getCachedProfile(username);
  if (inMemory) return inMemory;
  try {
    const profile = await readEntry<UserProfile>(profileKey(username));
    if (isObject(profile) && typeof profile.username === 'string') {
      memory.set(`profile:${profile.username.trim().toLowerCase()}`, profile);
      return profile;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: UserProfile | null | undefined): void {
  if (!isObject(profile) || typeof profile.username !== 'string' || !profile.username) return;
  const username = profile.username.trim().toLowerCase();
  try {
    memory.set(`profile:${username}`, profile);
    writeEntry(profileKey(username), profile);
    void addToProfileIndex(username);
  } catch {
    /* ignore */
  }
}

async function loadProfileIndex(): Promise<string[]> {
  if (profileIndex.length) return profileIndex;
  const stored = await readEntry<string[]>(PROFILE_INDEX_KEY);
  if (Array.isArray(stored)) {
    profileIndex = stored.filter((u): u is string => typeof u === 'string' && Boolean(u)).slice(0, MAX_CACHED_PROFILES);
  }
  return profileIndex;
}

async function addToProfileIndex(username: string): Promise<void> {
  try {
    const current = await loadProfileIndex();
    const next = [username, ...current.filter((u) => u !== username)].slice(0, MAX_CACHED_PROFILES);
    profileIndex = next;
    void kv.set(PROFILE_INDEX_KEY, JSON.stringify({ v: CACHE_VERSION, savedAt: Date.now(), data: next } satisfies Envelope<string[]>)).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------- аватары --- */

/**
 * Синхронное чтение. На web localStorage доступен сразу, поэтому холодный
 * старт тоже получает фото без мигания инициалов. На native до `loadCaches`
 * или асинхронного `loadCachedAvatar` вернёт null.
 */
export function getCachedAvatar(objectId: string | null | undefined): string | null {
  if (!objectId) return null;
  const fromMemory = avatarMemory.get(objectId);
  if (fromMemory) return fromMemory;
  if (Platform.OS === 'web') {
    try {
      const raw = localStorage.getItem(AVATAR_PREFIX + objectId);
      if (raw) {
        avatarMemory.set(objectId, raw);
        return raw;
      }
    } catch {
      /* privacy mode */
    }
  }
  return null;
}

/** Асинхронно дочитывает аватар из постоянного кэша (native/localStorage). */
export async function loadCachedAvatar(objectId: string | null | undefined): Promise<string | null> {
  if (!objectId) return null;
  const cached = getCachedAvatar(objectId);
  if (cached) return cached;
  try {
    const raw = await kv.get(AVATAR_PREFIX + objectId);
    if (!raw || !raw.startsWith('data:image/') || raw.length > MAX_AVATAR_BYTES) return null;
    rememberAvatar(objectId, raw);
    return raw;
  } catch {
    return null;
  }
}

export function saveAvatar(objectId: string | null | undefined, dataUri: string | null | undefined): void {
  if (!objectId || !dataUri || !dataUri.startsWith('data:image/')) return;
  if (dataUri.length > MAX_AVATAR_BYTES) return;
  rememberAvatar(objectId, dataUri);
  void kv.set(AVATAR_PREFIX + objectId, dataUri).catch(() => undefined);
}

export function removeCachedAvatar(objectId: string | null | undefined): void {
  if (!objectId) return;
  avatarMemory.delete(objectId);
  void kv.remove(AVATAR_PREFIX + objectId).catch(() => undefined);
}

function rememberAvatar(objectId: string, uri: string): void {
  try {
    avatarMemory.set(objectId, uri);
    if (avatarMemory.size > MAX_MEMORY_AVATARS) {
      const oldest = avatarMemory.keys().next().value;
      if (oldest && oldest !== objectId) avatarMemory.delete(oldest);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Полная очистка кэша (например, при выходе из аккаунта).
 * Аватары удаляются по objectId из `me` и закэшированных профилей.
 */
export function clearCaches(username?: string | null): void {
  try {
    const me = getCachedMe();
    const name = username ?? me?.username ?? null;
    const avatarIds = new Set<string>();
    if (me?.avatar?.objectId) avatarIds.add(me.avatar.objectId);
    memory.forEach((value) => {
      if (!isObject(value)) return;
      const avatar = value.avatar;
      if (isObject(avatar) && typeof avatar.objectId === 'string') avatarIds.add(avatar.objectId);
    });

    memory.clear();
    avatarMemory.clear();
    void kv.remove(ME_KEY).catch(() => undefined);
    if (name) void kv.remove(chatsKey(name)).catch(() => undefined);
    profileIndex.forEach((u) => void kv.remove(profileKey(u)).catch(() => undefined));
    avatarIds.forEach((id) => void kv.remove(AVATAR_PREFIX + id).catch(() => undefined));
    profileIndex = [];
    void kv.remove(PROFILE_INDEX_KEY).catch(() => undefined);
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------------------- загрузка -- */

/* --------------------------------------------------------- сообщения чата -- */

const messageKey = (chatId: string) => `${PREFIX}messages:${chatId}`;

/** Последние сообщения из памяти (для мгновенного открытия чата). */
export function getCachedMessages(chatId: string | null | undefined): unknown[] | null {
  if (!chatId) return null;
  const value = memory.get(`messages:${chatId}`);
  return Array.isArray(value) ? value : null;
}

export async function loadCachedMessages(chatId: string | null | undefined): Promise<unknown[] | null> {
  if (!chatId) return null;
  const inMemory = getCachedMessages(chatId);
  if (inMemory) return inMemory;
  try {
    const data = await readEntry<unknown[]>(messageKey(chatId));
    if (!Array.isArray(data)) return null;
    const limited = data.slice(0, 120);
    memory.set(`messages:${chatId}`, limited);
    return limited;
  } catch {
    return null;
  }
}

export function saveMessages(chatId: string | null | undefined, messages: unknown[] | null | undefined): void {
  if (!chatId || !Array.isArray(messages)) return;
  const limited = messages.slice(0, 120);
  memory.set(`messages:${chatId}`, limited);
  void writeEntry(messageKey(chatId), limited);
}

/**
 * Наполняет in-memory слой при старте приложения.
 * @param username — текущий пользователь; если не передан, берётся из кэша `me`.
 */
export async function loadCaches(username?: string | null): Promise<void> {
  try {
    const me = await readEntry<User>(ME_KEY);
    if (isObject(me) && typeof me.username === 'string') memory.set('me', me);

    const name = username ?? (isObject(me) && typeof me.username === 'string' ? me.username : null);
    if (name) {
      const chats = await readEntry<Chat[]>(chatsKey(name));
      if (Array.isArray(chats)) memory.set(`chats:${name}`, chats.slice(0, MAX_CACHED_CHATS));
    }
  } catch {
    /* offline / storage unavailable — работаем без кэша */
  }
}

/** Профили догружаем в фоне после старта, чтобы не задерживать первый кадр. */
export async function loadProfileCaches(): Promise<void> {
  try {
    const index = await loadProfileIndex();
    const profiles = await Promise.all(
      index.slice(0, MAX_CACHED_PROFILES).map((u) => readEntry<UserProfile>(profileKey(u))),
    );
    profiles.forEach((profile) => {
      if (isObject(profile) && typeof profile.username === 'string') {
        memory.set(`profile:${profile.username.trim().toLowerCase()}`, profile);
      }
    });
  } catch {
    /* ignore */
  }
}
