/**
 * Уровень работы с ключами чата и конвертами.
 * Все ключи остаются на устройстве: сервер и узлы видят только шифротексты.
 */
import { ApiError } from './api';
import * as api from './api';
import { kv } from '../crypto/storage';
import {
  fromB64,
  fromB64u,
  generateChatKeyRaw,
  storage,
  toB64u,
  unwrapKeyForDevice,
  wrapKeyForDevice,
  wrapKeyForAccount,
  unwrapKeyForAccount,
  encryptJson,
  decryptJson,
  encryptFileBytes,
  decryptFileBytes,
  type DeviceKeys,
} from '../crypto/core';

export interface MessagePayload {
  text?: string;
  file?: { id: string; key: string; name: string; mime: string; size: number };
}

export async function saveChatKeyLocal(chatId: string, raw: Uint8Array): Promise<void> {
  const map = await storage.loadChatKeys();
  map[chatId] = toB64u(raw);
  await storage.saveChatKeys(map);
}

export async function loadChatKey(chatId: string, keys: DeviceKeys): Promise<Uint8Array | null> {
  const map = await storage.loadChatKeys();
  const local = map[chatId];
  if (local) return fromB64u(local);

  // 1) ключ аккаунта: доступен на любом устройстве после входа паролем
  const accountPriv = await storage.loadAccountPriv();
  if (accountPriv) {
    const accountRows = await api.api.myAccountChatKeys(chatId).catch(() => [] as api.AccountKeyRow[]);
    for (const row of accountRows) {
      try {
        const raw = await unwrapKeyForAccount(row.wrappedKey, accountPriv);
        await saveChatKeyLocal(chatId, raw);
        return raw;
      } catch {
        /* обёртка под другой ключ аккаунта */
      }
    }
  }

  // 2) legacy: обёртка под конкретное устройство
  const rows = await api.api.myChatKeys(chatId).catch(() => [] as api.DeviceKeyRow[]);
  for (const row of rows) {
    if (row.deviceId !== keys.deviceId) continue;
    try {
      const raw = await unwrapKeyForDevice(row.wrappedKey, keys.ecdhPriv);
      await saveChatKeyLocal(chatId, raw);
      return raw;
    } catch {
      /* конверт предназначен другому устройству */
    }
  }
  return null;
}

export async function createAndShareChatKey(
  chatId: string,
  devices: { deviceId: string; ecdhPub: string }[],
  keys: DeviceKeys,
): Promise<Uint8Array> {
  const raw = await generateChatKeyRaw();
  await shareChatKey(chatId, raw, devices);
  await saveChatKeyLocal(chatId, raw);
  await shareChatKeyToAccounts(chatId, raw).catch(() => undefined);
  return raw;
}

export async function shareChatKey(
  chatId: string,
  rawKey: Uint8Array,
  devices: { deviceId: string; ecdhPub: string }[],
): Promise<void> {
  const payload: { deviceId: string; wrappedKey: string }[] = [];
  for (const d of devices) {
    if (!d.ecdhPub) continue;
    try {
      payload.push({ deviceId: d.deviceId, wrappedKey: await wrapKeyForDevice(rawKey, d.ecdhPub) });
    } catch {
      /* устройство с некорректным ключом пропускаем */
    }
  }
  if (payload.length) await api.api.uploadChatKeys(chatId, payload);
}

export async function topUpMissingKeys(chatId: string, rawKey: Uint8Array): Promise<void> {
  const missing = await api.api.missingKeys(chatId).catch(() => [] as api.MissingKeyDevice[]);
  if (!missing.length) return;
  const payload: { deviceId: string; wrappedKey: string }[] = [];
  for (const d of missing) {
    if (!d.ecdh_pub) continue;
    try {
      payload.push({ deviceId: d.device_id, wrappedKey: await wrapKeyForDevice(rawKey, d.ecdh_pub) });
    } catch {
      /* ignore */
    }
  }
  if (payload.length) await api.api.uploadChatKeys(chatId, payload).catch(() => undefined);
}

/** Обёртка ключа чата под ключи аккаунтов всех участников (мультиустройство). */
export async function shareChatKeyToAccounts(chatId: string, rawKey: Uint8Array): Promise<number> {
  const missing = await api.api.accountMissing(chatId).catch(() => [] as api.AccountMissingUser[]);
  if (!missing.length) return 0;
  const payload: { userId: string; wrappedKey: string }[] = [];
  for (const u of missing) {
    if (!u.accountPub) continue;
    try {
      payload.push({ userId: u.userId, wrappedKey: await wrapKeyForAccount(rawKey, u.accountPub) });
    } catch {
      /* некорректный ключ аккаунта — пропускаем */
    }
  }
  if (payload.length) await api.api.uploadAccountChatKeys(chatId, payload).catch(() => undefined);
  return payload.length;
}

/** Дослать ключ всем, у кого его ещё нет: устройства + аккаунты. */
export async function topUpAllKeys(chatId: string, rawKey: Uint8Array): Promise<void> {
  await topUpMissingKeys(chatId, rawKey).catch(() => undefined);
  await shareChatKeyToAccounts(chatId, rawKey).catch(() => undefined);
}

export async function encryptPayload(rawKey: Uint8Array, payload: MessagePayload) {
  return encryptJson(rawKey, payload);
}

export async function decryptPayload(rawKey: Uint8Array, ciphertext: string, nonce: string): Promise<MessagePayload | null> {
  if (!ciphertext || !nonce) return null;
  try {
    return await decryptJson<MessagePayload>(rawKey, ciphertext, nonce);
  } catch {
    return null;
  }
}

/* --------------------------------------------------- серверные ключи ---- */

export interface ChatEnvelopeHeader {
  scheme: 'server' | 'e2e';
  keyVersion?: number;
  nonce: string;
  clientId?: string;
  edited?: boolean;
}

/** Расшифрованные серверные ключи в памяти: `${chatId}:${version}`. */
const serverKeyCache = new Map<string, Uint8Array>();
/** Последняя известная текущая версия и время запроса (для авто-ротации). */
const currentVersionCache = new Map<string, { version: number; fetchedAt: number }>();
const CURRENT_KEY_TTL_MS = 60_000;

/** Ключ чата в режиме 'server'. Без version — текущая версия с сервера. */
export async function getServerChatKey(chatId: string, version?: number): Promise<{ key: Uint8Array; version: number }> {
  if (version === undefined) {
    const current = currentVersionCache.get(chatId);
    if (current && Date.now() - current.fetchedAt < CURRENT_KEY_TTL_MS) {
      const cached = serverKeyCache.get(`${chatId}:${current.version}`);
      if (cached) return { key: cached, version: current.version };
    }
  } else {
    const cached = serverKeyCache.get(`${chatId}:${version}`);
    if (cached) return { key: cached, version };
  }

  // Офлайн-режим: ключ мог быть сохранён на устройстве при прошлом открытии.
  try {
    if (version !== undefined) {
      const stored = await kv.get(`sg:chat-key:${chatId}:${version}`);
      if (stored) {
        const raw = fromB64u(stored);
        serverKeyCache.set(`${chatId}:${version}`, raw);
        return { key: raw, version };
      }
    } else {
      const storedVersion = Number(await kv.get(`sg:chat-key-current:${chatId}`));
      if (Number.isFinite(storedVersion) && storedVersion > 0) {
        const stored = await kv.get(`sg:chat-key:${chatId}:${storedVersion}`);
        if (stored) {
          const raw = fromB64u(stored);
          serverKeyCache.set(`${chatId}:${storedVersion}`, raw);
          currentVersionCache.set(chatId, { version: storedVersion, fetchedAt: Date.now() });
          return { key: raw, version: storedVersion };
        }
      }
    }
  } catch {
    /* локальный кэш не критичен */
  }

  const res = await api.api.chatKey(chatId, version);
  const raw = fromB64(res.key);
  serverKeyCache.set(`${chatId}:${res.version}`, raw);
  if (version === undefined) currentVersionCache.set(chatId, { version: res.version, fetchedAt: Date.now() });
  void kv.set(`sg:chat-key:${chatId}:${res.version}`, toB64u(raw)).catch(() => undefined);
  if (version === undefined) {
    void kv.set(`sg:chat-key-current:${chatId}`, String(res.version)).catch(() => undefined);
  }
  return { key: raw, version: res.version };
}

/** Сбросить кэш серверных ключей (всего чата или конкретного). */
export function clearServerKeyCache(chatId?: string): void {
  if (!chatId) {
    serverKeyCache.clear();
    currentVersionCache.clear();
    return;
  }
  for (const key of Array.from(serverKeyCache.keys())) {
    if (key.startsWith(`${chatId}:`)) serverKeyCache.delete(key);
  }
  currentVersionCache.delete(chatId);
}

/**
 * Зашифровать payload для чата: серверный ключ с Hub или E2E-ключ с устройства.
 * clientId в header добавляет messaging.ts.
 */
export async function encryptForChat(
  chat: { id: string; encryption: 'server' | 'e2e' },
  payload: MessagePayload,
  keys: DeviceKeys,
): Promise<{ ciphertext: string; nonce: string; header: ChatEnvelopeHeader }> {
  if (chat.encryption === 'server') {
    const { key, version } = await getServerChatKey(chat.id);
    const { ciphertext, nonce } = await encryptJson(key, payload);
    return { ciphertext, nonce, header: { scheme: 'server', keyVersion: version, nonce } };
  }

  const rawKey = await loadChatKey(chat.id, keys);
  if (!rawKey) throw new ApiError(409, 'chat_key_missing', 'Ключ чата ещё не получен');
  const { ciphertext, nonce } = await encryptJson(rawKey, payload);
  return { ciphertext, nonce, header: { scheme: 'e2e', nonce } };
}

/**
 * Прямая раскладка конверта по узлам: init → 3×PUT на узлы → commit.
 * Hub шифротекст не видит и не хранит.
 *
 * Опциональные onProgress/signal не меняют старый контракт: вызовы
 * `uploadEnvelope(bytes)` работают как раньше. Новые вызовы (upload-менеджер)
 * получают реальный прогресс PUT на web и возможность отмены между этапами.
 */
export async function uploadEnvelope(
  bytes: Uint8Array,
  opts: {
    onProgress?: (progress: number) => void;
    onStage?: (stage: 'upload' | 'register') => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ objectId: string; size: number; replicas: number }> {
  const { uploadBytesWithProgress } = await import('./uploader');
  return uploadBytesWithProgress(bytes, {
    onProgress: opts.onProgress,
    onStage: opts.onStage
      ? (stage) => {
          if (stage === 'upload' || stage === 'register') opts.onStage?.(stage);
        }
      : undefined,
    signal: opts.signal,
  });
}

export async function downloadObject(objectId: string): Promise<Uint8Array | null> {
  const routes = await api.api.objectRoutes(objectId).catch(() => null);
  if (routes && routes.fragments.length) {
    for (const frag of routes.fragments) {
      if (!frag.nodeOnline) continue;
      try {
        return await api.api.fetchFragment(frag);
      } catch {
        continue;
      }
    }
  }
  /* резервный путь: Hub сам стримит шифротекст с узла */
  try {
    const res = await fetch(`${api.apiBase}/v1/objects/${objectId}/proxy`, {
      headers: { authorization: `Bearer ${api.getSession()?.accessToken ?? ''}` },
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export { encryptFileBytes, decryptFileBytes };
