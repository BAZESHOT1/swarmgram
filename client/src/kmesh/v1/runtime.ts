/**
 * Активный KMesh_v1-клиент для UI.
 *
 * ModuleProvider создаёт клиент поверх BLE и регистрирует его здесь, чтобы
 * экран чатов мог запросить поиск/ленту через модуль, когда HTTP недоступен.
 */
import type { KMeshV1Client } from './client';

let active: KMeshV1Client | null = null;
let reqSeq = 1;

export function setActiveKMeshV1(client: KMeshV1Client | null): void {
  active = client;
}

export function activeKMeshV1(): KMeshV1Client | null {
  return active;
}

function nextReqId(): number {
  const id = reqSeq;
  reqSeq = (reqSeq + 1) & 0xffff;
  return id || 1;
}

/**
 * Сервисный запрос с повтором: BLE-канал может быть занят или переподключаться
 * (клиент заменяется новым). Каждый раз берём актуальный активный клиент.
 */
async function withRetry(run: (client: KMeshV1Client) => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const client = active;
    if (client) {
      const ok = await run(client).catch(() => false);
      if (ok) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  return false;
}

export async function requestKmeshSearch(query: string, type = 0): Promise<boolean> {
  if (!active) return false;
  const reqId = nextReqId();
  // Без Hub отвечают соседние телефоны кластера; с Hub — сервер. Спрашиваем оба источника.
  void active.localSearch(reqId, query).catch(() => false);
  return withRetry((client) => client.search(reqId, query, type));
}

export async function requestKmeshFeed(lastSyncTs: number): Promise<boolean> {
  if (!active) return false;
  return withRetry((client) => client.syncFeed(lastSyncTs >>> 0));
}

export async function requestKmeshHistory(chatRef: number, limit = 8): Promise<boolean> {
  if (!active) return false;
  return withRetry((client) => client.chatHistory(chatRef, 0n, limit));
}

/** Квитанция о прочтении по kMesh (9 байт на сообщение, без ACK). */
export function sendKmeshReadReceipt(
  chatId: string,
  chatRef: number,
  entries: Array<{ msgUuid: string; read: boolean }>,
): boolean {
  if (!active || !entries.length) return false;
  return active.sendReceipt(chatId, chatRef, entries);
}
