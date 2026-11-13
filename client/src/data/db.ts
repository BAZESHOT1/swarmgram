/**
 * Локальная БД клиента: очередь отправки (outbox) и служебные KV.
 * Нативные платформы — expo-sqlite (реальная SQLite-база),
 * веб-сборка — localStorage с тем же контрактом.
 */
import { Platform } from 'react-native';

export interface OutboxItem {
  id: string;
  chatId: string;
  objectId: string;
  nonce: string;
  header: string;
  kind: string;
  createdAt: string;
  clientId: string;
  envelopeB64: string;
  state: 'pending' | 'failed';
  attempts: number;
}

let sqliteDb: { execAsync(sql: string): Promise<void>; runAsync(sql: string, ...args: any[]): Promise<unknown>; getAllAsync<T>(sql: string, ...args: any[]): Promise<T[]> } | null = null;

async function native(): Promise<NonNullable<typeof sqliteDb> | null> {
  if (sqliteDb) return sqliteDb;
  try {
    const SQLite = await import('expo-sqlite');
    const db = SQLite.openDatabaseSync('kinto.db');
    if (typeof db.execAsync === 'function') {
      // Переход с прежнего имени таблицы (v3 -> KMesh_v1) без потери данных.
      try {
        await db.execAsync('ALTER TABLE mesh_v3_outbox RENAME TO kmesh_v1_outbox');
      } catch {
        /* таблицы ещё нет или она уже переименована */
      }
      await db.execAsync(
        `CREATE TABLE IF NOT EXISTS outbox (
           id TEXT PRIMARY KEY,
           chat_id TEXT NOT NULL,
           object_id TEXT NOT NULL,
           nonce TEXT NOT NULL,
           header TEXT NOT NULL,
           kind TEXT NOT NULL,
           created_at TEXT NOT NULL,
           envelope_b64 TEXT NOT NULL DEFAULT '',
           state TEXT NOT NULL DEFAULT 'pending',
           attempts INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE IF NOT EXISTS kmesh_v1_outbox (
           msg_uuid TEXT PRIMARY KEY,
           chat_id TEXT NOT NULL,
           chat_ref INTEGER NOT NULL DEFAULT 65535,
           peer_node_id INTEGER NOT NULL DEFAULT 0,
           sender_node_id INTEGER NOT NULL DEFAULT 0,
           text TEXT NOT NULL,
           created_at TEXT NOT NULL,
           ciphertext_b64 TEXT NOT NULL DEFAULT '',
           nonce TEXT NOT NULL DEFAULT '',
           state TEXT NOT NULL DEFAULT 'LOCAL_MESH_ONLY',
           attempts INTEGER NOT NULL DEFAULT 0,
           server_seq INTEGER,
           permanent_signature TEXT NOT NULL DEFAULT ''
         );`,
      );
      sqliteDb = db as unknown as NonNullable<typeof sqliteDb>;
      return sqliteDb;
    }
    return null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ outbox */

export async function enqueueOutbox(item: Omit<OutboxItem, 'state' | 'attempts'>): Promise<void> {
  if (Platform.OS === 'web') {
    const list = await listOutbox();
    list.unshift({ ...item, state: 'pending', attempts: 0 });
    try {
      localStorage.setItem('sg:outbox', JSON.stringify(list.slice(0, 200)));
    } catch {
      /* quota */
    }
    return;
  }
  const db = await native();
  if (!db) return;
  await db.runAsync(
    `INSERT OR REPLACE INTO outbox (id, chat_id, object_id, nonce, header, kind, created_at, envelope_b64, state, attempts)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    item.id, item.chatId, item.objectId, item.nonce, item.header, item.kind, item.createdAt, item.envelopeB64, 'pending', 0,
  );
}

export async function listOutbox(): Promise<OutboxItem[]> {
  if (Platform.OS === 'web') {
    try {
      return JSON.parse(localStorage.getItem('sg:outbox') ?? '[]') as OutboxItem[];
    } catch {
      return [];
    }
  }
  const db = await native();
  if (!db) return [];
  const rows = await db.getAllAsync<{
    id: string; chat_id: string; object_id: string; nonce: string; header: string; kind: string; created_at: string; envelope_b64: string; state: string; attempts: number;
  }>('SELECT * FROM outbox ORDER BY created_at ASC LIMIT 200');
  return rows.map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    objectId: r.object_id,
    nonce: r.nonce,
    header: r.header,
    kind: r.kind,
    createdAt: r.created_at,
    clientId: r.id,
    envelopeB64: r.envelope_b64 ?? '',
    state: r.state as OutboxItem['state'],
    attempts: r.attempts ?? 0,
  }));
}

export async function updateOutboxState(id: string, state: OutboxItem['state'], attempts: number): Promise<void> {
  if (Platform.OS === 'web') {
    const list = (await listOutbox()).filter((i) => i.id !== id);
    try {
      localStorage.setItem('sg:outbox', JSON.stringify(list));
    } catch {
      /* quota */
    }
    return;
  }
  const db = await native();
  if (!db) return;
  await db.runAsync('UPDATE outbox SET state = ?, attempts = ?, created_at = created_at WHERE id = ?', state, attempts, id);
}

export async function removeOutbox(id: string): Promise<void> {
  if (Platform.OS === 'web') {
    await updateOutboxState(id, 'failed', 0);
    return;
  }
  const db = await native();
  if (!db) return;
  await db.runAsync('DELETE FROM outbox WHERE id = ?', id);
}

/* --------------------------------------------------------------------- KV */

export async function dbGet(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return localStorage.getItem(`sg:kv:${key}`);
    } catch {
      return null;
    }
  }
  const db = await native();
  if (!db) return null;
  const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
  return rows.length ? rows[0].value : null;
}

export async function dbSet(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      localStorage.setItem(`sg:kv:${key}`, value);
    } catch {
      /* quota */
    }
    return;
  }
  const db = await native();
  if (!db) return;
  await db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?,?)', key, value);
}

/* ------------------------------------------------------- KMesh_v1 outbox -- */

export type KMeshV1SyncState = 'LOCAL_MESH_ONLY' | 'SYNC_PENDING' | 'SYNCED_PERMANENT' | 'FAILED';

export interface KMeshV1OutboxItem {
  msgUuid: string;
  chatId: string;
  chatRef: number;
  peerNodeId: number;
  senderNodeId: number;
  text: string;
  createdAt: string;
  ciphertextB64: string;
  nonce: string;
  state: KMeshV1SyncState;
  attempts: number;
  serverSeq?: number;
  permanentSignature: string;
}

const KMESH_V1_KV = 'sg:kmeshV1Outbox';

async function readKMeshV1Web(): Promise<KMeshV1OutboxItem[]> {
  try {
    return JSON.parse(localStorage.getItem(KMESH_V1_KV) ?? '[]') as KMeshV1OutboxItem[];
  } catch {
    return [];
  }
}

async function writeKMeshV1Web(items: KMeshV1OutboxItem[]): Promise<void> {
  try {
    localStorage.setItem(KMESH_V1_KV, JSON.stringify(items.slice(0, 200)));
  } catch {
    /* quota */
  }
}

export async function kmeshV1Enqueue(item: KMeshV1OutboxItem): Promise<void> {
  if (Platform.OS === 'web') {
    const list = (await readKMeshV1Web()).filter((i) => i.msgUuid !== item.msgUuid);
    list.unshift(item);
    await writeKMeshV1Web(list);
    return;
  }
  const db = await native();
  if (!db) return;
  await db.runAsync(
    `INSERT OR REPLACE INTO kmesh_v1_outbox
       (msg_uuid, chat_id, chat_ref, peer_node_id, sender_node_id, text, created_at,
        ciphertext_b64, nonce, state, attempts, server_seq, permanent_signature)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    item.msgUuid, item.chatId, item.chatRef, item.peerNodeId, item.senderNodeId, item.text,
    item.createdAt, item.ciphertextB64, item.nonce, item.state, item.attempts,
    item.serverSeq ?? null, item.permanentSignature,
  );
}

export async function kmeshV1List(): Promise<KMeshV1OutboxItem[]> {
  if (Platform.OS === 'web') return readKMeshV1Web();
  const db = await native();
  if (!db) return [];
  const rows = await db.getAllAsync<{
    msg_uuid: string; chat_id: string; chat_ref: number; peer_node_id: number;
    sender_node_id: number; text: string; created_at: string; ciphertext_b64: string;
    nonce: string; state: string; attempts: number; server_seq: number | null;
    permanent_signature: string;
  }>('SELECT * FROM kmesh_v1_outbox WHERE state <> ? ORDER BY created_at ASC LIMIT 200',
    'SYNCED_PERMANENT');
  return rows.map((r) => ({
    msgUuid: r.msg_uuid,
    chatId: r.chat_id,
    chatRef: r.chat_ref,
    peerNodeId: r.peer_node_id,
    senderNodeId: r.sender_node_id,
    text: r.text,
    createdAt: r.created_at,
    ciphertextB64: r.ciphertext_b64,
    nonce: r.nonce,
    state: r.state as KMeshV1SyncState,
    attempts: r.attempts ?? 0,
    serverSeq: r.server_seq ?? undefined,
    permanentSignature: r.permanent_signature ?? '',
  }));
}

export async function kmeshV1Update(item: KMeshV1OutboxItem): Promise<void> {
  await kmeshV1Enqueue(item);
}

export async function kmeshV1Remove(msgUuid: string): Promise<void> {
  if (Platform.OS === 'web') {
    await writeKMeshV1Web((await readKMeshV1Web()).filter((i) => i.msgUuid !== msgUuid));
    return;
  }
  const db = await native();
  if (!db) return;
  await db.runAsync('DELETE FROM kmesh_v1_outbox WHERE msg_uuid = ?', msgUuid);
}
