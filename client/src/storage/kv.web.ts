/**
 * Синхронный KV-слой (Web): in-memory Map + фоновая запись в localStorage.
 *
 * Чтение при рендере мгновенное; localStorage обновляется в idle-очереди,
 * поэтому прокрутка и ввод не блокируются синхронным IO.
 */
const PREFIX = 'klinto:sync:';
const memory = new Map<string, string>();
let flushScheduled = false;

function hydrate(): void {
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PREFIX)) memory.set(key.slice(PREFIX.length), localStorage.getItem(key) ?? '');
    }
  } catch {
    /* приватный режим */
  }
}

hydrate();

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = () => {
    flushScheduled = false;
    try {
      for (const [key, value] of memory) localStorage.setItem(PREFIX + key, value);
    } catch {
      /* quota */
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 500 });
  else setTimeout(run, 0);
}

export const syncKv = {
  getString(key: string): string | null {
    return memory.get(key) ?? null;
  },
  setString(key: string, value: string): void {
    memory.set(key, value);
    scheduleFlush();
  },
  getNumber(key: string, fallback = 0): number {
    const raw = memory.get(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  },
  setNumber(key: string, value: number): void {
    this.setString(key, String(value));
  },
  getBool(key: string, fallback = false): boolean {
    const raw = memory.get(key);
    return raw === undefined ? fallback : raw === '1';
  },
  setBool(key: string, value: boolean): void {
    this.setString(key, value ? '1' : '0');
  },
  getJSON<T>(key: string): T | null {
    const raw = this.getString(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },
  setJSON(key: string, value: unknown): void {
    try {
      this.setString(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
  delete(key: string): void {
    memory.delete(key);
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
  keys(): string[] {
    return [...memory.keys()];
  },
};
