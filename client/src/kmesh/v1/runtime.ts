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

export async function requestKmeshSearch(query: string, type = 0): Promise<boolean> {
  if (!active) return false;
  return active.search(nextReqId(), query, type).catch(() => false);
}

export async function requestKmeshFeed(lastSyncTs: number): Promise<boolean> {
  if (!active) return false;
  return active.syncFeed(lastSyncTs >>> 0).catch(() => false);
}

export async function requestKmeshHistory(chatRef: number, limit = 8): Promise<boolean> {
  if (!active) return false;
  return active.chatHistory(chatRef, 0n, limit).catch(() => false);
}
