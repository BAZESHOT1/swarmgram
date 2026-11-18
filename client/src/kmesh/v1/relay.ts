/**
 * Сохранность личных сообщений, отправленных через KMesh без Hub.
 *
 * Отправитель подписывает сообщение ключом устройства (ECDSA P-256, compact 64 байта):
 *   canonical = "klinto-relay-v1|<msgUuid>|<chatId>|<ts>|<sha256(text) hex>"
 * Подпись едет внутри зашифрованной полезной нагрузки (ключ пары/серверный ключ). Получатель сохраняет
 * расшифрованный текст и подпись в очередь пересылки. Как только Hub доступен, любой из собеседников
 * шифрует текст постоянным серверным ключом чата и выгружает копию на /v1/kmesh/v1/relay-sync.
 * Hub проверяет подпись по ключам устройств участников (кто автор), расшифровывает копию и сверяет
 * хеш текста — подделать чужое сообщение без ключа устройства автора нельзя.
 */
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { encryptBytes } from '../../crypto/core';
import { kv } from '../../crypto/storage';
import { getServerChatKey } from '../../data/chatkit';
import { api } from '../../data/api';
import { bytesToB64 } from './crypto';

const QUEUE_KEY = 'sg:kmesh:relay-queue';

export interface RelayItem {
  msgUuid: string;
  chatId: string;
  text: string;
  ts: number;
  sig: string;
}

export function relayCanonical(msgUuid: string, chatId: string, ts: number, text: string): Uint8Array {
  const textHash = bytesToHex(sha256(new TextEncoder().encode(text)));
  return new TextEncoder().encode(`klinto-relay-v1|${msgUuid}|${chatId}|${ts}|${textHash}`);
}

/** Подпись отправителя (compact r||s, base64). */
export function signRelay(identityPrivHex: string, msgUuid: string, chatId: string, ts: number, text: string): string {
  const digest = sha256(relayCanonical(msgUuid, chatId, ts, text));
  return bytesToB64(p256.sign(digest, identityPrivHex).toCompactRawBytes());
}

async function readQueue(): Promise<RelayItem[]> {
  try {
    const raw = await kv.get(QUEUE_KEY);
    const list = raw ? (JSON.parse(raw) as RelayItem[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeQueue(list: RelayItem[]): Promise<void> {
  await kv.set(QUEUE_KEY, JSON.stringify(list.slice(-500)));
}

/** Получатель: запомнить сообщение с подписью автора для последующей выгрузки на Hub. */
export async function queueRelay(item: RelayItem): Promise<void> {
  const list = await readQueue();
  if (list.some((row) => row.msgUuid === item.msgUuid)) return;
  list.push(item);
  await writeQueue(list);
}

/**
 * Выгрузить накопленные копии на Hub (вызывается при доступном Hub). Копия шифруется постоянным
 * серверным ключом чата; Hub дедуплицирует по msgUuid (если автор уже выгрузил сам — no-op).
 */
export async function flushRelayQueue(): Promise<number> {
  const list = await readQueue();
  if (!list.length) return 0;
  const left: RelayItem[] = [];
  let sent = 0;
  for (const item of list) {
    try {
      const { key, version } = await getServerChatKey(item.chatId);
      const sealed = encryptBytes(key, new TextEncoder().encode(JSON.stringify({ text: item.text })));
      await api.kmeshV1RelaySync({
        msg_uuid: item.msgUuid,
        chat_id: item.chatId,
        timestamp: item.ts,
        text_sha256: bytesToHex(sha256(new TextEncoder().encode(item.text))),
        sender_sig: item.sig,
        ciphertext_b64: sealed.ciphertext,
        nonce: sealed.nonce,
        key_version: version,
      });
      sent += 1;
    } catch (error) {
      const status = (error as { status?: number })?.status ?? 0;
      // 4xx (кроме 408/429) — копия отвергнута навсегда (подпись/членство); остальное — повторим позже.
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) continue;
      left.push(item);
    }
  }
  await writeQueue(left);
  if (sent) console.log('[kmesh]', 'relay copies synced', sent);
  return sent;
}
