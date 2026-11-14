/**
 * Кэш постоянной идентичности пользователя для полного оффлайна.
 *
 * users.id (UUID) и его ble_prefix (8 hex первых 4 байт SHA-256) нужны,
 * чтобы приложение без интернета отличало свои модули KL-<ME>-<MOD6>
 * от свободных и чужих.
 */
import { kv } from '../../crypto/storage';
import { api } from '../../data/api';

export interface CachedUserIdentity {
  userId: string;
  netId: number;
  blePrefix: string;
  cachedAt: number;
}

const KEY = 'sg:kmesh:identity';

let memory: CachedUserIdentity | null = null;

export async function loadCachedIdentity(): Promise<CachedUserIdentity | null> {
  if (memory) return memory;
  try {
    const raw = await kv.get(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as CachedUserIdentity;
    if (!value?.userId || !/^[0-9a-f]{8}$/i.test(value.blePrefix)) return null;
    memory = { ...value, blePrefix: value.blePrefix.toLowerCase() };
    return memory;
  } catch {
    return null;
  }
}

export async function saveCachedIdentity(identity: {
  userId: string;
  netId: number;
  blePrefix: string;
}): Promise<CachedUserIdentity> {
  const value: CachedUserIdentity = {
    userId: identity.userId,
    netId: identity.netId >>> 0,
    blePrefix: identity.blePrefix.toLowerCase(),
    cachedAt: Date.now(),
  };
  memory = value;
  try {
    await kv.set(KEY, JSON.stringify(value));
  } catch {
    /* оффлайн-кэш недоступен — работаем без него */
  }
  return value;
}

/** Обновить кэш с сервера; при оффлайне вернуть сохранённый. */
export async function refreshCachedIdentity(): Promise<CachedUserIdentity | null> {
  try {
    const res = await api.kmeshV1MeIdentity();
    return await saveCachedIdentity({
      userId: res.userId,
      netId: res.netId,
      blePrefix: res.blePrefix,
    });
  } catch {
    return loadCachedIdentity();
  }
}

export function clearCachedIdentity(): void {
  memory = null;
  void kv.set(KEY, '').catch(() => undefined);
}
