/**
 * Быстрый кэш сообщений (Web): IndexedDB + in-memory слой активных чатов.
 * Чтение для первого кадра синхронное, запись — в фоне.
 */
interface StoredRow {
  chat_id: string;
  msg_id: string;
  created_at: string;
  payload: string;
}

const DB_NAME = 'klinto-messages';
const STORE = 'messages_cache';
const memory = new Map<string, unknown[]>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: ['chat_id', 'msg_id'] });
          store.createIndex('chat_time', ['chat_id', 'created_at']);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function messageId(item: unknown): string {
  const record = item as Record<string, unknown>;
  return String(record.id ?? record.msgUuid ?? record.msg_uuid ?? '');
}

function createdAt(item: unknown): string {
  const record = item as Record<string, unknown>;
  return String(record.createdAt ?? record.created_at ?? record.timestamp ?? '');
}

export function initMessageStore(): void {
  void openDb();
}

export function getCachedMessagesSync(chatId: string): unknown[] | null {
  return memory.get(chatId) ?? null;
}

export function saveMessagesToStore(chatId: string, messages: unknown[]): void {
  if (!chatId || !messages.length) return;
  const limited = messages.slice(-200);
  memory.set(chatId, limited);
  void (async () => {
    const db = await openDb();
    if (!db) return;
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const item of limited) {
        const id = messageId(item);
        if (!id) continue;
        store.put({
          chat_id: chatId,
          msg_id: id,
          created_at: createdAt(item),
          payload: JSON.stringify(item),
        } satisfies StoredRow);
      }
    } catch {
      /* quota */
    }
  })();
}

export async function prefetchTopChats(chatIds: string[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  for (const chatId of chatIds.slice(0, 5)) {
    if (memory.has(chatId)) continue;
    const rows = await new Promise<StoredRow[]>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const index = tx.objectStore(STORE).index('chat_time');
        const range = IDBKeyRange.bound([chatId, ''], [chatId, '\uffff']);
        const request = index.openCursor(range, 'prev');
        const out: StoredRow[] = [];
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || out.length >= 40) {
            resolve(out.reverse());
            return;
          }
          out.push(cursor.value as StoredRow);
          cursor.continue();
        };
        request.onerror = () => resolve(out.reverse());
      } catch {
        resolve([]);
      }
    });
    memory.set(
      chatId,
      rows.map((row) => {
        try {
          return JSON.parse(row.payload) as unknown;
        } catch {
          return null;
        }
      }).filter((item): item is unknown => item !== null),
    );
  }
}

export async function loadOlderMessages(chatId: string, before: string, limit = 50): Promise<unknown[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const index = tx.objectStore(STORE).index('chat_time');
      const range = IDBKeyRange.bound([chatId, ''], [chatId, before], false, true);
      const request = index.openCursor(range, 'prev');
      const out: StoredRow[] = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || out.length >= limit) {
          resolve(out.reverse().map((row) => JSON.parse(row.payload) as unknown));
          return;
        }
        out.push(cursor.value as StoredRow);
        cursor.continue();
      };
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}
