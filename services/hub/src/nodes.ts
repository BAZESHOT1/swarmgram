/**
 * Работа с узлами: выбор под хранение, запись/чтение фрагментов, телеметрия.
 * Правило размещения: 3 реплики объекта живут в РАЗНЫХ подсетях, пока сеть
 * позволяет. Hub не расшифровывает данные — он только маршрутизирует.
 */
import { createHash } from 'node:crypto';
import dnsPromises from 'node:dns/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { Readable, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config, mintTicket } from './config.js';
import { one, query } from './db.js';
import { log } from './util.js';

const pipe = promisify(pipeline);

export interface NodeRow {
  id: string;
  owner_id: string | null;
  name: string;
  public_url: string;
  ticket_secret: string;
  capacity_bytes: number;
  used_bytes: number;
  free_bytes: number;
  status: string;
  reputation: number;
  region: string;
  subnet: string;
  hw_hash: string;
}

/* ------------------------------------------------------------- http helper */

async function nodeFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? 20_000;
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    ...(init.body instanceof Readable ? { duplex: 'half' } : {}),
  } as RequestInit);
}

/* --------------------------------------------------------- детекция подсети */

/** ip -> a.b.c (v4 /24), ipv6 -> первые 4 группы (аналог /64), домен -> по DNS. */
export async function resolveSubnet(publicUrl: string): Promise<string> {
  let host = '';
  try {
    const u = new URL(publicUrl);
    host = u.hostname;
  } catch {
    return '';
  }
  if (!host) return '';
  if (host.includes(':')) {
    const clean = host.replace(/^\[|\]$/g, '').split('%')[0];
    return clean.split(':').slice(0, 4).join(':');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host.split('.').slice(0, 3).join('.');
  try {
    const addrs = await dnsPromises.lookup(host, { all: true });
    for (const a of addrs) {
      if (a.family === 4) return a.address.split('.').slice(0, 3).join('.');
    }
    for (const a of addrs) return a.address.split(':').slice(0, 4).join(':');
  } catch {
    /* недоступный DNS — называем подсетью имя хоста */
  }
  return host;
}

/* -------------------------------------------------------------- выбор узлов */

/**
 * Выбирает `count` живых узлов под объект размера `sizeBytes`.
 * Приоритет: (1) максимум РАЗНЫХ подсетей, (2) разные владельцы,
 * (3) репутация и свободное место.
 */
export async function pickNodes(count: number, sizeBytes: number, excludeNodeIds: string[] = []): Promise<NodeRow[]> {
  const rows = await query<NodeRow>(
    `SELECT * FROM nodes
      WHERE status = 'online'
        AND free_bytes >= $1
        AND (capacity_bytes = 0 OR capacity_bytes >= $2)
      ORDER BY reputation DESC, free_bytes DESC`,
    [sizeBytes * 2, sizeBytes],
  );

  const candidates = rows.filter((n) => !excludeNodeIds.includes(n.id));
  const picked: NodeRow[] = [];
  const take = (node: NodeRow) => {
    if (!picked.some((p) => p.id === node.id) && picked.length < count) picked.push(node);
  };

  // 1-й проход: строго по одной реплике из каждой подсети
  const seenSubnets = new Set<string>();
  for (const node of candidates) {
    if (picked.length >= count) break;
    const subnet = node.subnet || 'local';
    if (seenSubnets.has(subnet)) continue;
    take(node);
    seenSubnets.add(subnet);
  }

  // 2-й проход: добираем по одному от каждого владельца (если в той же подсети
  // есть второй дом — даёт независимость по железу)
  const seenOwners = new Set<string>();
  for (const node of candidates) {
    if (picked.length >= count) break;
    const owner = node.owner_id ?? 'anon';
    if (seenOwners.has(owner)) continue;
    seenOwners.add(owner);
    take(node);
  }

  // 3-й проход: добираем остаток
  for (const node of candidates) take(node);

  return picked.slice(0, count);
}

/** Минимально допустимое число живых реплик для объекта. */
export function minReplicasDesired(): number {
  // если сеть мала, допускаем degrade, но объект считается хрупким
  return Math.max(1, Math.min(2, config.replicas));
}

/* ------------------------------------------------------------- фрагменты -- */

export async function tmpFile(): Promise<string> {
  await mkdir(config.tmpDir, { recursive: true });
  return path.join(config.tmpDir, `sg-${randomUUID()}.bin`);
}

/** Запись шифротекста на узел. Возвращает фактический размер. */
export async function putFragment(
  node: Pick<NodeRow, 'public_url' | 'ticket_secret' | 'id'>,
  objectId: string,
  index: number,
  ownerId: string,
  source: Readable,
  sizeBytes: number,
): Promise<void> {
  const ticket = mintTicket(node.ticket_secret, { op: 'put', oid: objectId, idx: index, sub: ownerId, ttlSec: 600 });
  const url = `${node.public_url.replace(/\/+$/, '')}/fragments/${objectId}/${index}`;
  const res = await nodeFetch(url, {
    method: 'PUT',
    body: source,
    headers: {
      'content-type': 'application/octet-stream',
      'x-sg-ticket': ticket,
      'x-sg-size': String(sizeBytes),
    },
    timeoutMs: 120_000,
  });
  if (!res.ok) {
    throw new Error(`node ${node.id} put failed: ${res.status} ${await safeText(res)}`);
  }
}

export async function getFragment(
  node: Pick<NodeRow, 'public_url' | 'ticket_secret' | 'id'>,
  objectId: string,
  index: number,
  userId: string,
): Promise<Readable> {
  const ticket = mintTicket(node.ticket_secret, { op: 'get', oid: objectId, idx: index, sub: userId });
  const url = `${node.public_url.replace(/\/+$/, '')}/fragments/${objectId}/${index}`;
  const res = await nodeFetch(url, { method: 'GET', headers: { 'x-sg-ticket': ticket }, timeoutMs: 120_000 });
  if (!res.ok || !res.body) throw new Error(`node ${node.id} get failed: ${res.status}`);
  return Readable.fromWeb(res.body as any);
}

export async function deleteFragment(
  node: Pick<NodeRow, 'public_url' | 'ticket_secret' | 'id'>,
  objectId: string,
  index: number,
  userId: string,
): Promise<void> {
  const ticket = mintTicket(node.ticket_secret, { op: 'del', oid: objectId, idx: index, sub: userId });
  const url = `${node.public_url.replace(/\/+$/, '')}/fragments/${objectId}/${index}`;
  const res = await nodeFetch(url, { method: 'DELETE', headers: { 'x-sg-ticket': ticket }, timeoutMs: 30_000 });
  if (!res.ok && res.status !== 404) {
    throw new Error(`node ${node.id} delete failed: ${res.status}`);
  }
}

/** Проверка доступности публичного URL узла (важно для узлов за NAT). */
export async function pingNode(node: Pick<NodeRow, 'public_url' | 'ticket_secret' | 'id'>): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  try {
    const ticket = mintTicket(node.ticket_secret, { op: 'get', oid: 'health', idx: 0, sub: 'hub', ttlSec: 60 });
    const res = await nodeFetch(`${node.public_url.replace(/\/+$/, '')}/n/ping`, {
      headers: { 'x-sg-ticket': ticket },
      timeoutMs: 8_000,
    });
    return { ok: res.ok, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

/* ---------------------------------------------------------------- учёт ----- */

export async function bumpNodeUsage(nodeId: string, deltaBytes: number): Promise<void> {
  await query(
    `UPDATE nodes
        SET used_bytes = GREATEST(0, used_bytes + $2),
            free_bytes = GREATEST(0, capacity_bytes - GREATEST(0, used_bytes + $2))
      WHERE id = $1`,
    [nodeId, deltaBytes],
  );
}

export async function nodeEvent(nodeId: string, type: string, message = ''): Promise<void> {
  await query('INSERT INTO node_events (node_id, type, message) VALUES ($1,$2,$3)', [nodeId, type, message]);
}

/** Репутация: растёт при аптайме, падает при недоступности. */
export async function adjustReputation(nodeId: string, delta: number): Promise<void> {
  await query('UPDATE nodes SET reputation = LEAST(100, GREATEST(0, reputation + $2)) WHERE id = $1', [nodeId, delta]);
}

export async function getNode(id: string): Promise<NodeRow | null> {
  return one<NodeRow>('SELECT * FROM nodes WHERE id = $1', [id]);
}

/* --------------------------------------------------------- восстановление -- */

/**
 * Копирует фрагмент с живого узла на новый, считая SHA-256 на лету.
 * Расшифровать поток Hub не может, но проверить целостность по хэшу — обязан:
 * битую реплику он выкупает с другого узла и перетирает.
 */
export async function copyFragment(
  from: NodeRow,
  to: NodeRow,
  objectId: string,
  index: number,
  ownerId: string,
  expectedSha: string,
): Promise<{ size: number; sha256: string; ok: boolean }> {
  const file = await tmpFile();
  try {
    const hash = createHash('sha256');
    const stream = await getFragment(from, objectId, index, ownerId);
    const chunks: Buffer[] = [];
    await pipe(stream, async function* (src) {
      for await (const chunk of src) {
        hash.update(chunk as Buffer);
        chunks.push(chunk as Buffer);
        yield chunk;
      }
    }, createWriteStream(file).on('finish', () => {}));
    const { size } = await stat(file);
    const sha256 = hash.digest('hex');
    const ok = !expectedSha || sha256 === expectedSha;
    if (ok) {
      await putFragment(to, objectId, index, ownerId, createReadStream(file), size);
    }
    return { size, sha256, ok };
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

export async function logAndIgnore(promise: Promise<unknown>, ctx: string): Promise<void> {
  try {
    await promise;
  } catch (e) {
    log('warn', 'background_task_failed', { ctx, error: e instanceof Error ? e.message : String(e) });
  }
}
