/**
 * OutboxSyncService — батчевый flush офлайн-очереди (по 20 сообщений)
 * и автоматическое уничтожение ESK после подтверждения.
 */
import { listOutbox } from '../data/db';
import { flushOutbox } from '../data/messaging';
import { destroyEphemeralKey } from './OfflineCryptoService';

export const OUTBOX_BATCH_SIZE = 20;

export interface OutboxFlushResult {
  batches: number;
  sent: number;
  remaining: number;
  destroyedKey: boolean;
}

let flushing: Promise<OutboxFlushResult> | null = null;
const listeners = new Set<(remaining: number) => void>();

export function onOutboxDepth(listener: (remaining: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function emitDepth(): Promise<number> {
  const remaining = (await listOutbox().catch(() => [])).length;
  for (const listener of listeners) {
    try {
      listener(remaining);
    } catch {
      /* ignore */
    }
  }
  return remaining;
}

/** Отправляет очередь пачками; повторный вызов возвращает текущий промис. */
export async function flushOutboxBatched(myUsername: string): Promise<OutboxFlushResult> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    let batches = 0;
    for (let i = 0; i < 20; i += 1) {
      const before = (await listOutbox().catch(() => [])).length;
      if (!before) break;
      batches += 1;
      const result = await flushOutbox(myUsername).catch(() => []);
      sent += result.length;
      const after = (await emitDepth());
      if (after >= before) break; // нет прогресса — не крутим цикл вхолостую
    }
    const remaining = await emitDepth();
    let destroyedKey = false;
    if (remaining === 0) {
      await destroyEphemeralKey();
      destroyedKey = true;
    }
    return { batches, sent, remaining, destroyedKey };
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

export async function getOutboxDepth(): Promise<number> {
  return emitDepth();
}

/** Совместимый интерфейс для PresenceStatus. */
export const meshOutbox = {
  size: getOutboxDepth,
  flush: flushOutboxBatched,
};
