/**
 * Базовые криптографические примитивы Hub.
 * Всё строится на встроенном node:crypto — без нативных зависимостей.
 */
import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
  createHash,
  createPublicKey,
  createVerify,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/* ---------------------------------------------------------------- base64url */

export function b64u(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buf.toString('base64url');
}

export function unb64u(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

/* ------------------------------------------------------------------- random */

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export function uuid(): string {
  return randomUUID();
}

/** Короткий человекочитаемый код для привязки узла / подтверждения почты. */
export function randomCode(len = 12): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const out: string[] = [];
  const bytes = randomBytes(len);
  for (let i = 0; i < len; i++) out.push(alphabet[bytes[i] % alphabet.length]);
  return out.join('');
}

/* --------------------------------------------------------------------- HMAC */

export function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/* -------------------------------------------------------------- JWT (HS256) */

export type Claims = {
  sub: string;
  did?: string;
  type: 'access' | 'refresh' | 'node' | 'module' | 'claim';
  scope?: string;
  /** Публичный 8-значный ID модуля (для module-токенов). */
  pid?: string;
  iat: number;
  exp: number;
  jti?: string;
};

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Компактный JWT HS256. */
export function signToken(claims: Claims, secret: string): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(claims));
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

export function verifyToken<T extends Claims = Claims>(token: string, secret: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  if (!safeEqual(sig, sign(`${head}.${body}`, secret))) return null;
  try {
    const claims = JSON.parse(unb64u(body).toString('utf8')) as T;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- пароли --- */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [algo, n, r, p, salt, key] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const derived = await scrypt(password.normalize('NFKC'), unb64u(salt), 32, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return safeEqual(derived.toString('base64url'), key);
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- коды ----- */

export async function hashCode(code: string): Promise<string> {
  return `scrypt$${sha256(`${code}:swarmgram`)}`;
}

/* ------------------------------------------------- подписи устройств (mesh) */

/**
 * Проверка ECDSA P-256 подписи устройства. Публичный ключ устройства
 * хранится как JWK (WebCrypto export), поэтому mesh-мост (LoRa/BLE) не может
 * подделать конверт: Hub проверяет подпись отправителя.
 */
export function verifyEcdsaP256(jwkJson: string, dataB64: string, sigB64: string): boolean {
  try {
    if (!jwkJson.startsWith('{')) return false;
    const jwk = JSON.parse(jwkJson) as Record<string, unknown>;
    const key = createPublicKey({ key: jwk as any, format: 'jwk' });
    const verifier = createVerify('SHA256');
    verifier.update(Buffer.from(dataB64, 'base64'));
    verifier.end();
    return verifier.verify(key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}
