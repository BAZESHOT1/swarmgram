/**
 * Быстрый кэш сообщений (iOS/Android): op-sqlite + WAL + in-memory слой.
 *
 * При старте топ-5 чатов прогреваются последними 40 сообщениями, поэтому
 * открытие переписки не показывает пустой экран и скелетоны.
 */
import { open } from '@op-engineering/op-sqlite';

interface Row {
  payload: string;
}

let db: ReturnType<typeof open> | null = null;
const memory = new Map<string, unknown[]>();

let initialized = false;

export function initMessageStore(): void {
  if (initialized) return;
  initialized = true;
  try {
    db = open({ name: 'klinto_messages.sqlite' });
    db.executeSync('PRAGMA journal_mode = WAL;');
    db.executeSync('PRAGMA synchronous = NORMAL;');
    db.executeSync(
      `CREATE TABLE IF NOT EXISTS messages_cache (
         chat_id TEXT NOT NULL,
         msg_id TEXT NOT NULL,
         created_at TEXT NOT NULL,
         payload TEXT NOT NULL,
         PRIMARY KEY (chat_id, msg_id)
       );`,
    );
    db.executeSync(
      `CREATE INDEX IF NOT EXISTS messages_cache_chat_time
         ON messages_cache (chat_id, created_at DESC, msg_id);`,
    );
  } catch {
    /* БД недоступна — работаем через память */
    db = null;
  }
}

function messageId(item: unknown): string {
  const record = item as Record<string, unknown>;
  return String(record.id ?? record.msgUuid ?? record.msg_uuid ?? '');
}

function createdAt(item: unknown): string {
  const record = item as Record<string, unknown>;
  return String(record.createdAt ?? record.created_at ?? record.timestamp ?? '');
}

export function getCachedMessagesSync(chatId: string): unknown[] | null {
  const cached = memory.get(chatId);
  if (cached) return cached;
  try {
    initMessageStore();
    const database = db;
    if (!database) return null;
    const result = database.executeSync(
      `SELECT payload FROM messages_cache WHERE chat_id = ? ORDER BY created_at ASC LIMIT 200`,
      [chatId],
    );
    const rows = (result.rows ?? []) as unknown as Row[];
    if (!rows.length) return null;
    const parsed = rows.map((row) => {
      try {
        return JSON.parse(row.payload) as unknown;
      } catch {
        return null;
      }
    }).filter((item): item is unknown => item !== null);
    memory.set(chatId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function saveMessagesToStore(chatId: string, messages: unknown[]): void {
  if (!chatId || !messages.length) return;
  const limited = messages.slice(-200);
  memory.set(chatId, limited);
  try {
    initMessageStore();
    const database = db;
    if (!database) return;
    database.executeSync('BEGIN');
    database.executeSync('DELETE FROM messages_cache WHERE chat_id = ?', [chatId]);
    for (const item of limited) {
      const id = messageId(item);
      if (!id) continue;
      database.executeSync(
        `INSERT OR REPLACE INTO messages_cache (chat_id, msg_id, created_at, payload)
         VALUES (?,?,?,?)`,
        [chatId, id, createdAt(item), JSON.stringify(item)],
      );
    }
    database.executeSync('COMMIT');
  } catch {
    try {
      db?.executeSync('ROLLBACK');
    } catch {
      /* ignore */
    }
  }
}

export async function prefetchTopChats(chatIds: string[]): Promise<void> {
  for (const chatId of chatIds.slice(0, 5)) {
    if (!chatId || memory.has(chatId)) continue;
    getCachedMessagesSync(chatId);
  }
}

export async function loadOlderMessages(chatId: string, before: string, limit = 50): Promise<unknown[]> {
  try {
    initMessageStore();
    const database = db;
    if (!database) return [];
    const result = database.executeSync(
      `SELECT payload FROM messages_cache
        WHERE chat_id = ? AND created_at < ?
        ORDER BY created_at DESC LIMIT ?`,
      [chatId, before, limit],
    );
    return ((result.rows ?? []) as unknown as Row[])
      .map((row) => {
        try {
          return JSON.parse(row.payload) as unknown;
        } catch {
          return null;
        }
      })
      .filter((item): item is unknown => item !== null)
      .reverse();
  } catch {
    return [];
  }
}
