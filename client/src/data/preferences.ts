/**
 * Синхронизация настроек интерфейса (тема, акцент, язык, приглушённые чаты,
 * история поиска) между устройствами через PATCH /v1/me.
 *
 * Правила:
 *  - серверные значения применяются в store без обратной отправки (applyingRemote);
 *  - локальные изменения дебаунсятся и уходят только полями настроек;
 *  - пока настройки не применены с сервера, синхронизация не активна.
 */
import { api, type SearchHistoryEntry, type User } from './api';
import { useStore, type ThemeName } from '../state/useStore';
import { ACCENTS, type AccentName } from '../theme/theme';
import { kv } from '../crypto/storage';

/** Пока true — изменения store пришли с сервера и не должны отправляться назад. */
let applyingRemote = false;
/** Синхронизация включается после первого применения серверных настроек. */
let syncReady = false;
/** Активная подписка (initPreferenceSync должен вызываться один раз). */
let activeUnsubscribe: (() => void) | null = null;

const THEMES: readonly ThemeName[] = ['dark', 'light', 'system'];
/** Языки, которые сейчас поддерживает интерфейс. */
const LOCALES = ['ru', 'en', 'de'];

/** Допустимые типы истории поиска. */
const SEARCH_TYPES: readonly SearchHistoryEntry['type'][] = ['user', 'chat', 'group', 'channel', 'message'];
/** Сервер и клиент хранят не больше 20 последних элементов. */
const SEARCH_HISTORY_LIMIT = 20;

/** Только поля настроек — ровно то, что синхронизируется с сервером. */
type PrefSnapshot = {
  themeName: ThemeName;
  accentName: AccentName;
  locale: string;
  mutedChats: string[];
  searchHistory: SearchHistoryEntry[];
};

function snapshot(): PrefSnapshot {
  const s = useStore.getState();
  return {
    themeName: s.themeName,
    accentName: s.accentName,
    locale: s.locale,
    mutedChats: [...s.mutedChats],
    searchHistory: [...s.searchHistory],
  };
}

/** Один элемент истории с сервера: битое/неизвестное отбрасываем (null). */
function parseHistoryEntry(raw: unknown): SearchHistoryEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.type !== 'string' || !(SEARCH_TYPES as readonly string[]).includes(row.type)) return null;
  if (typeof row.id !== 'string' || !row.id || row.id.length > 200) return null;
  if (typeof row.title !== 'string' || !row.title) return null;
  if (typeof row.at !== 'string' || Number.isNaN(Date.parse(row.at))) return null;

  const entry: SearchHistoryEntry = {
    type: row.type as SearchHistoryEntry['type'],
    id: row.id,
    title: row.title.slice(0, 120),
    at: row.at,
  };
  if (typeof row.subtitle === 'string' && row.subtitle) entry.subtitle = row.subtitle.slice(0, 160);
  if (typeof row.username === 'string' && row.username) entry.username = row.username.slice(0, 64);
  const avatar = row.avatar;
  if (avatar && typeof avatar === 'object' && !Array.isArray(avatar)) {
    const a = avatar as Record<string, unknown>;
    if (typeof a.objectId === 'string' && typeof a.key === 'string' && typeof a.mime === 'string') {
      entry.avatar = { objectId: a.objectId, key: a.key, mime: a.mime };
    }
  }
  return entry;
}

/** История поиска с сервера: фильтруем битые элементы и обрезаем до 20. */
function parseHistory(raw: unknown): SearchHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseHistoryEntry)
    .filter((entry): entry is SearchHistoryEntry => entry !== null)
    .slice(0, SEARCH_HISTORY_LIMIT);
}

function samePrefs(a: PrefSnapshot, b: PrefSnapshot): boolean {
  return (
    a.themeName === b.themeName &&
    a.accentName === b.accentName &&
    a.locale === b.locale &&
    a.mutedChats.length === b.mutedChats.length &&
    a.mutedChats.every((id, i) => id === b.mutedChats[i]) &&
    // История — массив объектов; порядок важен (последние сверху), сравниваем целиком.
    JSON.stringify(a.searchHistory) === JSON.stringify(b.searchHistory)
  );
}

/**
 * Применить серверные настройки к store. Неизвестные/отсутствующие значения
 * игнорируются — остаются локальные (например, выбранные до входа).
 */
export function applyServerPreferences(user: Partial<User> | null): void {
  if (!user) return;
  applyingRemote = true;
  try {
    if (typeof user.themeName === 'string' && (THEMES as readonly string[]).includes(user.themeName)) {
      useStore.getState().setThemeName(user.themeName as ThemeName);
    }
    if (typeof user.accentName === 'string' && user.accentName in ACCENTS) {
      useStore.getState().setAccent(user.accentName as AccentName);
    }
    if (typeof user.locale === 'string' && LOCALES.includes(user.locale)) {
      useStore.getState().setLocale(user.locale);
    }
    if (Array.isArray(user.mutedChats)) {
      const ids = user.mutedChats
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200)
        .slice(0, 200);
      useStore.setState({ mutedChats: ids });
      void kv.set('sg:muted-chats', JSON.stringify(ids)).catch(() => undefined);
    }
    // История поиска приходит с сервера; локальный ключ sg:search-history
    // (старый формат) не перезаписываем — UI сам решит, что читать.
    if (Array.isArray(user.searchHistory)) {
      useStore.getState().setSearchHistory(parseHistory(user.searchHistory));
    }
  } finally {
    applyingRemote = false;
  }
}

/**
 * Подписка на изменения настроек с debounce ~900 мс. Возвращает unsubscribe.
 * Первое срабатывание не отправляет ничего: снимок берётся сразу после init.
 */
export function initPreferenceSync(): () => void {
  if (activeUnsubscribe) return activeUnsubscribe;

  syncReady = true;
  let last = snapshot();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const unsub = useStore.subscribe(() => {
    // Серверные значения и ранний старт не отправляем.
    if (!syncReady || applyingRemote) return;
    const next = snapshot();
    if (samePrefs(next, last)) return;
    last = next;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!syncReady || applyingRemote) return;
      const current = snapshot();
      // Только настройки интерфейса: профиль не трогаем.
      void api
        .patchMe({
          themeName: current.themeName,
          accentName: current.accentName,
          locale: current.locale,
          mutedChats: current.mutedChats,
          searchHistory: current.searchHistory,
        })
        .catch(() => undefined);
    }, 900);
  });

  const unsubscribe = () => {
    syncReady = false;
    if (timer) clearTimeout(timer);
    timer = null;
    unsub();
    activeUnsubscribe = null;
  };
  activeUnsubscribe = unsubscribe;
  return unsubscribe;
}
