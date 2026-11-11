/**
 * Релейное хранилище: общая механика «стримим шифротекст → раскладываем
 * на реплики». Используется и веб-клиентом (POST /v1/objects), и mesh-ретрансляторами
 * ESP32 (POST /v1/mesh/relay). Содержимое Hub не читает.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError, log } from './util.js';
import { config } from './config.js';
import { uuid } from './crypto.js';
import { one, query } from './db.js';
import { adjustReputation, bumpNodeUsage, nodeEvent, pickNodes, putFragment, tmpFile } from './nodes.js';

export interface StoreResult {
  objectId: string;
  size: number;
  sha256: string;
  replicas: number;
  replicasDesired: number;
}

/**
 * Принимает готовый (уже зашифрованный) поток, раскладывает на узлы и регистрирует объект.
 * Квота владельца проверяется вызывающей стороной ДО вызова этой функции.
 */
export async function storeEncrypted(
  ownerId: string,
  source: Readable,
  limitBytes: number,
  replicasDesired: number,
): Promise<StoreResult> {
  const file = await tmpFile();
  let size = 0;
  const hash = createHash('sha256');
  try {
    await pipeline(
      source,
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          const buf = chunk as Buffer;
          hash.update(buf);
          size += buf.length;
          if (size > limitBytes) throw new ApiError(413, 'file_too_large', 'file_too_large');
          yield buf;
        }
      },
      createWriteStream(file),
    );
    if (size === 0) throw new ApiError(400, 'empty_payload', 'empty_payload');

    const sha = hash.digest('hex');
    const objectId = uuid();
    const nodes = await pickNodes(replicasDesired, size);
    if (!nodes.length) throw new ApiError(503, 'no_nodes_available', 'no_healthy_nodes');

    await query(
      `INSERT INTO objects (id, owner_id, size_bytes, sha256, replicas_desired) VALUES ($1,$2,$3,$4,$5)`,
      [objectId, ownerId, size, sha, nodes.length],
    );

    const results = await Promise.allSettled(
      nodes.map((node, index) => putFragment(node, objectId, index, ownerId, createReadStreamFor(file), size)),
    );

    let stored = 0;
    results.forEach((r, i) => {
      const node = nodes[i]!;
      if (r.status === 'fulfilled') {
        stored += 1;
        void bumpNodeUsage(node.id, size);
        void query(
          `INSERT INTO fragments (object_id, node_id, index, size_bytes, sha256) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (object_id, node_id, index) DO NOTHING`,
          [objectId, node.id, i, size, sha],
        );
      } else {
        log('warn', 'fragment_put_failed', { nodeId: node.id, reason: String(r.reason).slice(0, 200) });
        void adjustReputation(node.id, -2);
        void nodeEvent(node.id, 'put_failed', String(r.reason).slice(0, 200));
      }
    });

    if (!stored) {
      await query('DELETE FROM objects WHERE id = $1', [objectId]);
      throw new ApiError(503, 'upload_failed', 'all_nodes_failed');
    }

    await query('UPDATE users SET used_bytes = used_bytes + $2 WHERE id = $1', [ownerId, size]);
    await query('INSERT INTO object_grants (object_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [objectId, ownerId]);
    await query(`UPDATE objects SET replicas_desired = $2 WHERE id = $1`, [objectId, nodes.length]);
    log('info', 'object_stored', { objectId, size, replicas: stored, subnets: [...new Set(nodes.map((n) => n.subnet))].length });

    return { objectId, size, sha256: sha, replicas: stored, replicasDesired: nodes.length };
  } finally {
    await unlink(file).catch(() => {});
  }
}

// локальный helper — не выносим наружу
import { createReadStream } from 'node:fs';
import { tmpFile as _t } from './nodes.js';
function createReadStreamFor(file: string) {
  return createReadStream(file);
}
void _t;
void config;
