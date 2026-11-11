import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export function b64u(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')).toString('base64url');
}

export function unb64u(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function hmac(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export interface Ticket {
  v: number;
  op: 'get' | 'put' | 'del';
  oid: string;
  idx: number;
  sub: string;
  exp: number;
}

/**
 * Проверка маршрутного билета. Билет подписан секретом этого узла,
 * который выдаётся Hub при регистрации — обращаться к Hub за проверкой не нужно.
 */
export function verifyTicket(token: string, secret: string): Ticket | null {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!safeEqual(hmac(secret, body), sig)) return null;
  try {
    const t = JSON.parse(unb64u(body).toString('utf8')) as Ticket;
    if (!t || typeof t.oid !== 'string' || typeof t.exp !== 'number') return null;
    if (t.exp * 1000 < Date.now()) return null;
    if (!['get', 'put', 'del'].includes(t.op)) return null;
    return t;
  } catch {
    return null;
  }
}

export function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
