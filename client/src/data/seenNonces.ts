/**
 * Защита от дублей сообщений между транспортами.
 *
 * Одно и то же сообщение может прийти по сокету/HTTP и затем ещё раз (или несколько раз) через
 * kMesh — с другим id. Nonce шифрования у всех копий один, поэтому по нему и узнаём повтор.
 * Список переживает перезапуск приложения (последние 4000 nonce).
 */
import { kv } from '../crypto/storage';

const KEY = 'sg:seen-nonces';
const LIMIT = 4000;
const seen = new Set<string>();
const order: string[] = [];
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function norm(nonce: unknown): string {
  if (!nonce) return '';
  if (typeof nonce === 'string') return nonce.replace(/=+$/, '');
  if (nonce instanceof Uint8Array) {
    let s = '';
    for (let i = 0; i < nonce.length; i += 1) s += String.fromCharCode(nonce[i]);
    return (typeof btoa === 'function' ? btoa(s) : '').replace(/=+$/, '');
  }
  return '';
}

export async function loadSeenNonces(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await kv.get(KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    for (const n of list) {
      if (!seen.has(n)) {
        seen.add(n);
        order.push(n);
      }
    }
  } catch {
    /* пусто — не страшно */
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void kv.set(KEY, JSON.stringify(order.slice(-LIMIT))).catch(() => undefined);
  }, 1500);
}

/** Запомнить nonce показанного сообщения. */
export function markNonce(nonce: unknown): void {
  const n = norm(nonce);
  if (!n || seen.has(n)) return;
  seen.add(n);
  order.push(n);
  if (order.length > LIMIT) {
    const drop = order.splice(0, order.length - LIMIT);
    for (const d of drop) seen.delete(d);
  }
  scheduleSave();
}

/** Сообщение с таким nonce уже было (по любому транспорту). */
export function isNonceSeen(nonce: unknown): boolean {
  const n = norm(nonce);
  return Boolean(n) && seen.has(n);
}
