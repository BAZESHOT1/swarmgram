/**
 * Журнал приложения: перехватывает console.log/info/warn/error в кольцевой
 * буфер, чтобы логи ([ble], [kmesh], [module], [msg]) можно было посмотреть и
 * отправить прямо из «О приложении → Журнал», без adb/logcat.
 * Последние строки сохраняются в kv и переживают перезапуск.
 */
import { kv } from '../crypto/storage';

export type LogLevel = 'log' | 'info' | 'warn' | 'error';
export interface LogEntry {
  at: number;
  level: LogLevel;
  text: string;
}

const MAX_ENTRIES = 1500;
const PERSIST_ENTRIES = 400;
const PERSIST_KEY = 'sg:applog:v1';
const MAX_LINE = 600;

let entries: LogEntry[] = [];
let installed = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* ignore */
    }
  }
}

function push(level: LogLevel, args: unknown[]): void {
  let text = args.map(stringify).join(' ');
  if (text.length > MAX_LINE) text = `${text.slice(0, MAX_LINE)}…`;
  entries.push({ at: Date.now(), level, text });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(entries.length - MAX_ENTRIES);
  notify();
  schedulePersist();
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      void Promise.resolve(kv.set(PERSIST_KEY, JSON.stringify(entries.slice(-PERSIST_ENTRIES)))).catch(
        () => undefined,
      );
    } catch {
      /* ignore */
    }
  }, 4000);
}

/** Подключает перехват консоли (идемпотентно) и подгружает прошлый сеанс. */
export function installAppLog(): void {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level]?.bind(console) as ((...a: unknown[]) => void) | undefined;
    console[level] = (...args: unknown[]) => {
      try {
        push(level, args);
      } catch {
        /* журнал не должен ломать приложение */
      }
      original?.(...args);
    };
  }
  void (async () => {
    try {
      const raw = await kv.get(PERSIST_KEY);
      if (!raw) return;
      const old = JSON.parse(raw) as LogEntry[];
      if (!Array.isArray(old)) return;
      entries = [
        ...old.map((e) => ({ ...e, text: `(прошлый сеанс) ${e.text}` })),
        ...entries,
      ].slice(-MAX_ENTRIES);
      notify();
    } catch {
      /* ignore */
    }
  })();
}

export function getAppLog(): LogEntry[] {
  return entries;
}

export function clearAppLog(): void {
  entries = [];
  void Promise.resolve(kv.set(PERSIST_KEY, '[]')).catch(() => undefined);
  notify();
}

export function subscribeAppLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatLogLine(entry: LogEntry): string {
  const d = new Date(entry.at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  const mark = entry.level === 'error' ? 'E' : entry.level === 'warn' ? 'W' : 'I';
  return `${time} ${mark} ${entry.text}`;
}
