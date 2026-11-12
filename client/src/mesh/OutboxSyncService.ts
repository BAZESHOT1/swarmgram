/**
 * Офлайн-очередь mesh v2. Хранится в kv (на native — AsyncStorage/SQLite-адаптер),
 * flush батчами по 20 при появлении любого канала.
 */
import { kv } from '../crypto/storage';
import { offlineCrypto } from './OfflineCryptoService';

const OUTBOX_KEY = 'sg:mesh:outbox-v2';
const BATCH = 20;

export interface MeshOutboxItem {
  msgId: string;
  chatId: string;
  ciphertext: string;
  signature: string;
  publicKey: string;
  timestamp: number;
  clusterId: string;
  ttlHops: number;
  clusterAgnostic: boolean;
  unverifiableAfterDeviceChange?: boolean;
}

export interface FlushResult {
  ok: boolean;
  acked: string[];
  remaining: number;
}

async function read(): Promise<MeshOutboxItem[]> {
  try {
    const raw = await kv.get(OUTBOX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as MeshOutboxItem[]) : [];
  } catch {
    return [];
  }
}

async function write(items: MeshOutboxItem[]): Promise<void> {
  await kv.set(OUTBOX_KEY, JSON.stringify(items.slice(0, 2000)));
}

export const meshOutbox = {
  async size(): Promise<number> {
    return (await read()).length;
  },

  async enqueue(input: {
    msgId: string;
    chatId: string;
    ciphertext: string;
    clusterId: string;
    clusterAgnostic?: boolean;
    ttlHops?: number;
  }): Promise<MeshOutboxItem | null> {
    const key = input.clusterAgnostic ? null : await offlineCrypto.ensureKeyPair();
    const publicKey = key?.publicKeyB64 ?? (await offlineCrypto.currentPublicKey()) ?? '';
    const signature = await offlineCrypto.sign({
      msgId: input.msgId,
      chatId: input.chatId,
      ciphertext: input.ciphertext,
    });
    if (!signature) return null;
    const item: MeshOutboxItem = {
      msgId: input.msgId,
      chatId: input.chatId,
      ciphertext: input.ciphertext,
      signature,
      publicKey,
      timestamp: Date.now(),
      clusterId: input.clusterId,
      ttlHops: input.ttlHops ?? 8,
      clusterAgnostic: Boolean(input.clusterAgnostic),
    };
    const items = await read();
    items.push(item);
    await write(items);
    return item;
  },

  /**
   * flush отправляет батчи по 20. sender возвращает список подтверждённых msgId.
   * При смене устройства неподтверждённые сообщения помечаются
   * unverifiable_after_device_change и больше не переподписываются.
   */
  async flush(sender: (batch: MeshOutboxItem[]) => Promise<string[]>): Promise<FlushResult> {
    const acked = new Set<string>();
    let items = await read();
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      let ids: string[] = [];
      try {
        ids = await sender(batch);
      } catch {
        break;
      }
      ids.forEach((id) => acked.add(id));
      if (!ids.length) break;
    }
    items = items.map((item) =>
      acked.has(item.msgId)
        ? item
        : item.unverifiableAfterDeviceChange
          ? item
          : item,
    );
    const remaining = items.filter((item) => !acked.has(item.msgId));
    // Если ключ этого устройства уже недоступен, помечаем остаток.
    const hasKey = Boolean(await offlineCrypto.currentPublicKey());
    const next = remaining.map((item) =>
      !hasKey && !item.unverifiableAfterDeviceChange
        ? { ...item, unverifiableAfterDeviceChange: true }
        : item,
    );
    await write(next);
    if (!next.length) await offlineCrypto.destroy();
    return { ok: next.length === 0, acked: [...acked], remaining: next.length };
  },

  async list(): Promise<MeshOutboxItem[]> {
    return read();
  },

  async clear(): Promise<void> {
    await write([]);
    await offlineCrypto.destroy();
  },
};
