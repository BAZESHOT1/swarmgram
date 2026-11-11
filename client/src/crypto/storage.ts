/**
 * Единое хранилище сессий и ключей.
 * Web — localStorage, нативные платформы — AsyncStorage (подгружается лениво,
 * чтобы веб-сборка не тянула нативный модуль).
 */
import { Platform } from 'react-native';

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const memory = new Map<string, string>();
let nativeStorage: {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
} | null = null;

async function getNativeStorage() {
  if (!nativeStorage) {
    const mod: any = await import('@react-native-async-storage/async-storage');
    nativeStorage = mod.default ?? mod;
  }
  return nativeStorage!;
}

export const kv: KV = {
  async get(key: string) {
    if (Platform.OS === 'web') {
      try {
        return localStorage.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    }
    return getNativeStorage().then((s) => s.getItem(key));
  },
  async set(key: string, value: string) {
    memory.set(key, value);
    if (Platform.OS === 'web') {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* quota / privacy mode */
      }
      return;
    }
    const s = await getNativeStorage();
    await s.setItem(key, value);
  },
  async remove(key: string) {
    memory.delete(key);
    if (Platform.OS === 'web') {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      return;
    }
    const s = await getNativeStorage();
    await s.removeItem(key);
  },
};
