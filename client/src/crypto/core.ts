/**
 * Криптографическое ядро SwarmGram — единое для web, iOS и Android.
 *
 * Использует чистые JS-реализации (@noble/*), поэтому не зависит от WebCrypto
 * и одинаково работает в браузере и в React Native.
 *
 * Принцип: приватные ключи устройства и ключи чатов никогда не покидают устройство.
 */
import { p256 } from '@noble/curves/p256';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { hkdf } from '@noble/hashes/hkdf';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from './random';
import { kv } from './storage';

/* ------------------------------------------------------------------- base64 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toB64(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

export function fromB64(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]);
    const c1 = B64.indexOf(clean[i + 1]);
    const c2 = B64.indexOf(clean[i + 2]);
    const c3 = B64.indexOf(clean[i + 3]);
    out.push((c0 << 2) | (c1 >> 4));
    if (clean[i + 2] !== undefined && c2 >= 0) out.push(((c1 & 15) << 4) | (c2 >> 2));
    if (clean[i + 3] !== undefined && c3 >= 0) out.push(((c2 & 3) << 6) | c3);
  }
  return new Uint8Array(out);
}

export function toB64u(input: Uint8Array | ArrayBuffer): string {
  return toB64(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(input: string): Uint8Array {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  return fromB64(b64);
}

/* --------------------------------------------------------------------- utf8 */

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let code = 0;
    let size = 0;
    if (b < 0x80) {
      code = b;
      size = 1;
    } else if (b >= 0xc0 && b < 0xe0) {
      code = b & 0x1f;
      size = 2;
    } else if (b >= 0xe0 && b < 0xf0) {
      code = b & 0x0f;
      size = 3;
    } else {
      code = b & 0x07;
      size = 4;
    }
    for (let k = 1; k < size; k += 1) code = (code << 6) | (bytes[i + k] & 63);
    i += size;
    if (code > 0xffff) {
      const c = code - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/* ------------------------------------------------------------------- JWK ----- */

function sec1ToJwk(sec1: Uint8Array): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    x: toB64u(sec1.slice(1, 33)),
    y: toB64u(sec1.slice(33, 65)),
    ext: true,
  };
}

function jwkToSec1(jwk: JsonWebKey): Uint8Array {
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(fromB64u(String(jwk.x ?? '')), 1);
  out.set(fromB64u(String(jwk.y ?? '')), 33);
  return out;
}

export function publicJwkOf(privateHex: string): JsonWebKey {
  return sec1ToJwk(p256.getPublicKey(privateHex, false));
}

/** Ключ шифрования резервной копии: PBKDF2-SHA512, 210k итераций. */
export function deriveBackupKeyB64(password: string, saltB64: string): Uint8Array {
  const salt = fromB64(saltB64);
  return pbkdf2(sha512, utf8Encode(password), salt, { c: 210_000, dkLen: 32 });
}

/** Blob резервной копии: {v:1,kdf:'pbkdf2-sha512-210000',salt,nonce,ct}. */
export function encryptBackupBlob(
  password: string,
  saltB64: string,
  payload: Record<string, unknown>,
): string {
  const key = deriveBackupKeyB64(password, saltB64);
  const nonce = randomBytes(12);
  const data = utf8Encode(JSON.stringify(payload));
  const ct = gcm(key, nonce).encrypt(data);
  return JSON.stringify({
    v: 1,
    kdf: 'pbkdf2-sha512-210000',
    salt: saltB64,
    nonce: toB64(nonce),
    ct: toB64(ct),
  });
}

export interface BackupPayload {
  chatKeys: Record<string, string>;
  deviceKeys?: DeviceKeys;
  /** Приватный ключ аккаунта (ECDH P-256, hex) — только внутри шифрованного blob. */
  accountPriv?: string;
  createdAt: string;
}

export function decryptBackupBlob(password: string, saltB64: string, blob: string): BackupPayload {
  const parsed = JSON.parse(blob) as { v: number; kdf: string; salt: string; nonce: string; ct: string };
  if (parsed.kdf !== 'pbkdf2-sha512-210000') throw new Error('unsupported_kdf');
  const key = deriveBackupKeyB64(password, String(parsed.salt ?? saltB64));
  const plaintext = gcm(key, fromB64(parsed.nonce)).decrypt(fromB64(parsed.ct));
  return JSON.parse(utf8Decode(plaintext)) as BackupPayload;
}

export function publicJwkJson(privateHex: string): string {
  return JSON.stringify(publicJwkOf(privateHex));
}

/** SHA-256 байтов в hex — идентичность конверта для реплик узлов. */
export function sha256Of(bytes: Uint8Array): string {
  return Array.from(sha256(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/* ----------------------------------------------------------- устройство ---- */

export interface DeviceKeys {
  deviceId: string;
  identityPriv: string;
  ecdhPriv: string;
  signedPrekeyPriv: string;
  prekeySig: string;
  oneTimePrivs: string[];
}

export interface PublicDeviceBundle {
  deviceId: string;
  identityPub: string;
  ecdhPub: string;
  signedPrekey: string;
  prekeySig: string;
  prekeys: string[];
}

function randomPriv(): string {
  // 32 случайных байта в hex
  return Array.from(randomBytes(32))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function generateDeviceKeys(): Promise<{ stored: DeviceKeys; publicBundle: PublicDeviceBundle }> {
  const identityPriv = randomPriv();
  const ecdhPriv = randomPriv();
  const signedPrekeyPriv = randomPriv();
  const signedPrekeyJwk = publicJwkOf(signedPrekeyPriv);
  const sig = p256.sign(sha256(utf8Encode(JSON.stringify(signedPrekeyJwk))), identityPriv).toDERRawBytes();

  const oneTimePrivs: string[] = [];
  const prekeys: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const priv = randomPriv();
    oneTimePrivs.push(priv);
    prekeys.push(JSON.stringify(publicJwkOf(priv)));
  }

  const stored: DeviceKeys = {
    deviceId: randomHexId(),
    identityPriv,
    ecdhPriv,
    signedPrekeyPriv,
    prekeySig: toB64(sig),
    oneTimePrivs,
  };

  return {
    stored,
    publicBundle: {
      deviceId: stored.deviceId,
      identityPub: JSON.stringify(publicJwkOf(identityPriv)),
      ecdhPub: JSON.stringify(publicJwkOf(ecdhPriv)),
      signedPrekey: JSON.stringify(signedPrekeyJwk),
      prekeySig: toB64(sig),
      prekeys,
    },
  };
}

function randomHexId(): string {
  const bytes = randomBytes(16);
  const hexed = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hexed.slice(0, 8)}-${hexed.slice(8, 12)}-${hexed.slice(12, 16)}-${hexed.slice(16, 20)}-${hexed.slice(20, 32)}`;
}

export async function generateOneTimePrekeys(n = 10): Promise<{ publics: string[]; privs: string[] }> {
  const publics: string[] = [];
  const privs: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const priv = randomPriv();
    privs.push(priv);
    publics.push(JSON.stringify(publicJwkOf(priv)));
  }
  return { publics, privs };
}

/* ------------------------------------------------------- ключи чата ------ */

export async function generateChatKeyRaw(): Promise<Uint8Array> {
  return randomBytes(32);
}

async function deriveKek(privHex: string, peerJwkJson: string, salt: Uint8Array): Promise<Uint8Array> {
  const shared = p256.getSharedSecret(privHex, jwkToSec1(JSON.parse(peerJwkJson) as JsonWebKey));
  return hkdf(sha256, shared, salt, utf8Encode('swarmgram-chat-key-v1'), 32);
}

/** Оборачиваем ключ чата под устройство получателя. */
export async function wrapKeyForDevice(chatKeyRaw: Uint8Array, recipientEcdhPubJson: string): Promise<string> {
  const ephPriv = randomPriv();
  const ephPubJwk = publicJwkOf(ephPriv);
  const salt = randomBytes(16);
  const kek = await deriveKek(ephPriv, recipientEcdhPubJson, salt);
  const iv = randomBytes(12);
  const ct = gcm(kek, iv).encrypt(chatKeyRaw);
  return JSON.stringify({ v: 1, eph: ephPubJwk, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) });
}

export async function unwrapKeyForDevice(wrappedJson: string, myEcdhPrivHex: string): Promise<Uint8Array> {
  const payload = JSON.parse(wrappedJson) as { eph: JsonWebKey; salt: string; iv: string; ct: string };
  const kek = await deriveKek(myEcdhPrivHex, JSON.stringify(payload.eph), fromB64(payload.salt));
  return gcm(kek, fromB64(payload.iv)).decrypt(fromB64(payload.ct));
}

/* ---------------------------------------------------------- аккаунт ------ */

/**
 * Ключ аккаунта (Signal-подобная модель): публичная часть на сервере,
 * приватная — только в шифрованном резерве (PBKDF2 от пароля). Любое
 * устройство аккаунта после входа паролем получает accountPriv и может
 * развернуть ключи всех чатов, не запрашивая их вручную.
 */
export function generateAccountKey(): { accountPriv: string; accountPub: string } {
  const accountPriv = randomPriv();
  return { accountPriv, accountPub: JSON.stringify(publicJwkOf(accountPriv)) };
}

/** Обёртка ключа чата под ключ аккаунта — тот же ECDH+HKDF+AES-GCM конверт. */
export const wrapKeyForAccount = wrapKeyForDevice;
export const unwrapKeyForAccount = unwrapKeyForDevice;

/* ---------------------------------------------------------- сообщения ---- */

export function encryptBytes(key: Uint8Array, data: Uint8Array): { ciphertext: string; nonce: string } {
  const iv = randomBytes(12);
  return { ciphertext: toB64(gcm(key, iv).encrypt(data)), nonce: toB64(iv) };
}

export function decryptBytes(key: Uint8Array, ciphertext: string, nonce: string): Uint8Array {
  return gcm(key, fromB64(nonce)).decrypt(fromB64(ciphertext));
}

export async function encryptJson(key: Uint8Array, payload: unknown): Promise<{ ciphertext: string; nonce: string }> {
  return encryptBytes(key, utf8Encode(JSON.stringify(payload)));
}

export async function decryptJson<T = any>(key: Uint8Array, ciphertext: string, nonce: string): Promise<T> {
  return JSON.parse(utf8Decode(decryptBytes(key, ciphertext, nonce))) as T;
}

/* -------------------------------------------------------------- файлы ---- */

export interface EncryptedFile {
  bytes: Uint8Array;
  rawKey: Uint8Array;
  size: number;
}

/** Шифруем файл: [12 байт nonce][AES-GCM(шифротекст)]. Ключ — случайный на файл. */
export function encryptFileBytes(data: Uint8Array): EncryptedFile {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const ct = gcm(key, iv).encrypt(data);
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return { bytes: out, rawKey: key, size: out.length };
}

export function decryptFileBytes(rawKey: Uint8Array, data: Uint8Array): Uint8Array {
  return gcm(rawKey, data.slice(0, 12)).decrypt(data.slice(12));
}

/* ------------------------------------------------------------ хранилище -- */

const K_SESSION = 'sg:session';
const K_KEYS = 'sg:device-keys';
const K_CHATKEYS = 'sg:chat-keys';
const K_ACCOUNT = 'sg:account-key';

export interface Session {
  userId: string;
  username: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  accessExp: number;
  /** Ключ для зашифрованного API-туннеля через mesh-шлюз. */
  meshRelayKey?: string;
}

export const storage = {
  async saveSession(s: Session) {
    await kv.set(K_SESSION, JSON.stringify(s));
  },
  async loadSession(): Promise<Session | null> {
    const raw = await kv.get(K_SESSION);
    return raw ? (JSON.parse(raw) as Session) : null;
  },
  async clearSession() {
    await kv.remove(K_SESSION);
  },
  async saveKeys(keys: DeviceKeys) {
    await kv.set(K_KEYS, JSON.stringify(keys));
  },
  async loadKeys(): Promise<DeviceKeys | null> {
    const raw = await kv.get(K_KEYS);
    return raw ? (JSON.parse(raw) as DeviceKeys) : null;
  },
  async saveChatKeys(map: Record<string, string>) {
    await kv.set(K_CHATKEYS, JSON.stringify(map));
  },
  async loadChatKeys(): Promise<Record<string, string>> {
    const raw = await kv.get(K_CHATKEYS);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  },
  async saveAccountPriv(privHex: string) {
    await kv.set(K_ACCOUNT, privHex);
  },
  async loadAccountPriv(): Promise<string | null> {
    return kv.get(K_ACCOUNT);
  },
  async clearAccountPriv() {
    await kv.remove(K_ACCOUNT);
  },
};
