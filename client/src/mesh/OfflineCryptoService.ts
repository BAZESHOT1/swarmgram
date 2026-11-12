/**
 * Ephemeral Signing Key (Ed25519) для Autonomous Mode.
 * Приватный ключ живёт в kv (Keychain/Keystore через secure storage adapter)
 * и уничтожается после успешной синхронизации.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { kv } from '../crypto/storage';

const KEY_STORE = 'sg:mesh:esk';
const PUB_STORE = 'sg:mesh:esk-pub';
const CREATED_STORE = 'sg:mesh:esk-at';

export interface EphemeralKeyPair {
  publicKeyB64: string;
  /** Ссылка на приватный ключ; сам ключ в kv не покидает сервис. */
  ref: string;
}

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  if (typeof btoa === 'function') return btoa(bin);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? alphabet[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? alphabet[b2 & 63] : '=';
  }
  return out;
}

function unb64(value: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(value);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = alphabet.indexOf(clean[i]);
    const c1 = alphabet.indexOf(clean[i + 1]);
    const c2 = alphabet.indexOf(clean[i + 2]);
    const c3 = alphabet.indexOf(clean[i + 3]);
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) out.push(((c1 & 15) << 4) | (c2 >> 2));
    if (c3 >= 0) out.push(((c2 & 3) << 6) | c3);
  }
  return new Uint8Array(out);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const offlineCrypto = {
  /** Создаёт ESK при входе в Autonomous Mode (если ещё нет). */
  async ensureKeyPair(): Promise<EphemeralKeyPair> {
    const existing = await kv.get(KEY_STORE);
    const pub = await kv.get(PUB_STORE);
    if (existing && pub) return { publicKeyB64: pub, ref: 'esk:current' };
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    await kv.set(KEY_STORE, hex(privateKey));
    await kv.set(PUB_STORE, b64(publicKey));
    await kv.set(CREATED_STORE, String(Date.now()));
    return { publicKeyB64: b64(publicKey), ref: 'esk:current' };
  },

  async currentPublicKey(): Promise<string | null> {
    return kv.get(PUB_STORE);
  },

  /** Подпись офлайн-пакета: Ed25519(msg_id|chat_id|ciphertext). */
  async sign(input: { msgId: string; chatId: string; ciphertext: string }): Promise<string | null> {
    const privateHex = await kv.get(KEY_STORE);
    if (!privateHex) return null;
    const message = `${input.msgId}|${input.chatId}|${input.ciphertext}`;
    const signature = ed25519.sign(new TextEncoder().encode(message), unhex(privateHex));
    return b64(signature);
  },

  /** Проверка подписи получателем по ephemeral_pubkey из пакета. */
  verify(input: {
    msgId: string;
    chatId: string;
    ciphertext: string;
    signatureB64: string;
    publicKeyB64: string;
  }): boolean {
    try {
      const message = `${input.msgId}|${input.chatId}|${input.ciphertext}`;
      return ed25519.verify(
        unb64(input.signatureB64),
        new TextEncoder().encode(message),
        unb64(input.publicKeyB64),
      );
    } catch {
      return false;
    }
  },

  /** Уничтожение ESK после успешного flush. */
  async destroy(): Promise<void> {
    await kv.remove(KEY_STORE);
    await kv.remove(PUB_STORE);
    await kv.remove(CREATED_STORE);
  },
};
