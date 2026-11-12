/**
 * OfflineCryptoService — Ephemeral Signing Key (Ed25519) для автономного режима.
 *
 * Пока нет ни интернета, ни подтверждённого шлюза, приложение подписывает
 * офлайн-пакеты временным ключом. После успешного flush() ключ уничтожается,
 * а сервер переподписывает сообщение постоянным ключом пользователя.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { kv } from '../crypto/storage';

const STORAGE_KEY = 'sg:mesh:esk';

export interface EphemeralKeyPair {
  /** Публичный ключ, hex (кладётся в каждый офлайн-пакет). */
  publicKey: string;
  /** Приватный ключ, hex. Хранится локально и уничтожается после flush. */
  privateKey: string;
  createdAt: number;
}

export interface SignedOfflinePacket {
  payload: unknown;
  ephemeralPubkey: string;
  signature: string;
}

let cached: EphemeralKeyPair | null = null;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  const clean = value.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Создаёт ESK (или возвращает существующий в рамках автономной сессии). */
export async function ensureEphemeralKey(): Promise<EphemeralKeyPair> {
  if (cached) return cached;
  try {
    const raw = await kv.get(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as EphemeralKeyPair;
      if (parsed?.privateKey && parsed?.publicKey) {
        cached = parsed;
        return parsed;
      }
    }
  } catch {
    /* повреждённый ключ пересоздаём */
  }
  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  cached = { privateKey: toHex(privateKey), publicKey: toHex(publicKey), createdAt: Date.now() };
  await kv.set(STORAGE_KEY, JSON.stringify(cached));
  return cached;
}

/** Подписывает офлайн-пакет. */
export async function signOfflinePayload(payload: unknown): Promise<SignedOfflinePacket> {
  const key = await ensureEphemeralKey();
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const signature = ed25519.sign(bytes, fromHex(key.privateKey));
  return { payload, ephemeralPubkey: key.publicKey, signature: toHex(signature) };
}

/**
 * Подписывает hex-дайджест (SHA-256 payload), как его проверяет сервер.
 * Подпись ставится над ASCII-байтами hex-строки — контракт с Hub.
 */
export async function signOfflineDigest(
  digestHex: string,
): Promise<{ ephemeralPubkey: string; signature: string }> {
  const key = await ensureEphemeralKey();
  const bytes = new TextEncoder().encode(digestHex);
  const signature = ed25519.sign(bytes, fromHex(key.privateKey));
  return { ephemeralPubkey: key.publicKey, signature: toHex(signature) };
}

/** Проверка подписи (используется в тестах/на серверной стороне-аналоге). */
export function verifyOfflinePacket(packet: SignedOfflinePacket): boolean {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(packet.payload));
    return ed25519.verify(fromHex(packet.signature), bytes, fromHex(packet.ephemeralPubkey));
  } catch {
    return false;
  }
}

/** Уничтожает ESK после успешной синхронизации outbox. */
export async function destroyEphemeralKey(): Promise<void> {
  cached = null;
  await kv.remove(STORAGE_KEY).catch(() => undefined);
}

export async function hasEphemeralKey(): Promise<boolean> {
  if (cached) return true;
  try {
    return Boolean(await kv.get(STORAGE_KEY));
  } catch {
    return false;
  }
}
