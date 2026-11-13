/**
 * HTTP-запросы через mesh-шлюз.
 *
 * Клиент шифрует запрос ключом устройства (meshRelayKey из сессии), шлюз
 * пересылает непрозрачный blob в Hub. Hub выполняет запрос и возвращает
 * зашифрованный ответ. Шлюз не видит ни токен, ни тело запроса.
 */
import { ApiError, getSession } from '../data/api';
import { decryptJson, encryptJson, fromB64, toB64, utf8Encode } from '../crypto/core';
import { onMeshEnvelope, sendViaMesh, canSendViaMesh } from './meshLink';

interface Pending {
  resolve: (value: MeshHttpResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface MeshHttpResponse {
  status: number;
  body: unknown;
}

const pending = new Map<string, Pending>();
const assemblies = new Map<string, { total: number; parts: Map<number, string> }>();
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  onMeshEnvelope((raw) => {
    const env = raw as unknown as Record<string, any>;
    if (env?.kind !== 'http_resp' || typeof env.id !== 'string') return;
    const item = pending.get(env.id);
    if (!item) return;

    // Ответ приходит частями (mesh-кадр <= 280 байт base64-blob).
    let packedText = typeof env.blob === 'string' ? String(env.blob) : '';
    if (!packedText && typeof env.chunk === 'string') {
      const total = Math.max(1, Number(env.total) || 1);
      const part = Math.max(0, Number(env.part) || 0);
      let assembly = assemblies.get(env.id);
      if (!assembly || assembly.total !== total) {
        assembly = { total, parts: new Map() };
        assemblies.set(env.id, assembly);
      }
      assembly.parts.set(part, env.chunk);
      if (assembly.parts.size < total) return;
      const ordered: string[] = [];
      for (let i = 0; i < total; i += 1) {
        const chunk = assembly.parts.get(i);
        if (chunk == null) return;
        ordered.push(chunk);
      }
      assemblies.delete(env.id);
      packedText = ordered.join('');
    }
    if (!packedText) return;
    pending.delete(env.id);
    clearTimeout(item.timer);
    void (async () => {
      try {
        const session = getSession();
        if (!session?.meshRelayKey) throw new Error('no relay key');
        const packed = JSON.parse(utf8Decode(fromB64(packedText)));
        const data = await decryptJson<{ status: number; body: unknown }>(
          fromB64(session.meshRelayKey),
          String(packed.ciphertext || ''),
          String(packed.nonce || ''),
        );
        item.resolve({ status: Number(data.status) || 0, body: data.body });
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b);
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
}

/** Доступен ли туннель: есть ключ и подключённый модуль с шлюзом. */
export function meshHttpAvailable(): boolean {
  return Boolean(getSession()?.meshRelayKey && canSendViaMesh());
}

/**
 * Выполнить API-запрос через mesh. Возвращает null, если модуль/шлюз
 * недоступен или истёк таймаут — тогда вызывающий использует обычную ошибку.
 */
export async function meshHttpFetch(
  path: string,
  init: RequestInit = {},
): Promise<MeshHttpResponse | null> {
  const session = getSession();
  if (!session?.meshRelayKey) return null;
  wire();

  const id = `mh-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const method = String(init.method || 'GET').toUpperCase();
  let body: unknown = null;
  if (typeof init.body === 'string' && init.body) {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  const key = fromB64(session.meshRelayKey);
  const enc = await encryptJson(key, {
    v: 1,
    id,
    ts: Date.now(),
    method,
    path,
    body,
  });
  const blob = toB64(utf8Encode(JSON.stringify(enc)));

  const result = await new Promise<MeshHttpResponse | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      assemblies.delete(id);
      resolve(null);
    }, 30_000);
    pending.set(id, {
      resolve,
      reject: () => resolve(null),
      timer,
    });
    void sendViaMesh('__http__', {
      kind: 'http',
      id,
      userId: session.userId,
      deviceId: session.deviceId,
      blob,
    }).then((ok) => {
      if (!ok) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(null);
      }
    });
  });
  return result;
}

/** Превратить ответ туннеля в ApiError при не-2xx. */
export function throwIfMeshError(response: MeshHttpResponse): void {
  if (response.status >= 200 && response.status < 300) return;
  const body = (response.body ?? {}) as { error?: string; message?: string };
  throw new ApiError(response.status, body.error ?? 'mesh_http_error', body.message ?? 'mesh_http_error');
}
