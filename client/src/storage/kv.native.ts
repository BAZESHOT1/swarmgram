/**
 * Синхронный KV-слой (iOS/Android): react-native-mmkv.
 *
 * Если нативный модуль недоступен (нестандартная сборка/старый бинарник),
 * прозрачно откатываемся в память — интерфейс продолжает работать.
 */
import { MMKV } from 'react-native-mmkv';

let store: MMKV | null = null;
try {
  store = new MMKV({ id: 'klinto-sync-v1' });
} catch {
  store = null;
}
const fallback = new Map<string, string>();

export const syncKv = {
  getString(key: string): string | null {
    try {
      return store ? store.getString(key) ?? null : fallback.get(key) ?? null;
    } catch {
      return fallback.get(key) ?? null;
    }
  },
  setString(key: string, value: string): void {
    fallback.set(key, value);
    try {
      store?.set(key, value);
    } catch {
      /* диск недоступен */
    }
  },
  getNumber(key: string, fallbackValue = 0): number {
    const raw = this.getString(key);
    if (raw === null) return fallbackValue;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallbackValue;
  },
  setNumber(key: string, value: number): void {
    this.setString(key, String(value));
  },
  getBool(key: string, fallbackValue = false): boolean {
    const raw = this.getString(key);
    return raw === null ? fallbackValue : raw === '1' || raw === 'true';
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
    fallback.delete(key);
    try {
      store?.delete(key);
    } catch {
      /* ignore */
    }
  },
  keys(): string[] {
    try {
      return store ? store.getAllKeys() : [...fallback.keys()];
    } catch {
      return [...fallback.keys()];
    }
  },
};
