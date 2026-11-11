/**
 * Объекты (сообщения и медиа). Hub — оркестратор: содержимое не проходит через
 * его диск и не хранится в его БД.
 *
 * Прямой путь (используется клиентом):
 *   POST /v1/objects/init   — Hub выбирает реплики (разные подсети) и раздаёт тикеты
 *   PUT  узел/fragments/:oid/:idx — клиент сам кладёт шифротекст на 3 узла
 *   POST /v1/objects/:id/commit — фиксируются подтверждённые реплики
 *
 * Резервный путь (анти-NAT): POST /v1/objects — релей через Hub, который стримит
 * шифротекст дальше, никуда не сохраняя.
 */
import type { FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { requireAuth } from '../auth.js';
import { config, mintTicket } from '../config.js';
import { uuid } from '../crypto.js';
import { one, query } from '../db.js';
import {
  adjustReputation,
  bumpNodeUsage,
  deleteFragment,
  getFragment,
  nodeEvent,
  pickNodes,
  putFragment,
  tmpFile,
} from '../nodes.js';
import { ApiError, badRequest, forbidden, log, notFound, rateLimit } from '../util.js';

/**
 * Доступ к объекту: владелец, явный grant, либо участник чата, в котором
 * объект используется (сообщение или комментарий). Второе покрывает случай,
 * когда пользователь вступил в чат уже после публикации истории.
 */
async function canAccessObject(objectId: string, userId: string): Promise<boolean> {
  const grant = await one('SELECT 1 FROM object_grants WHERE object_id = $1 AND user_id = $2', [objectId, userId]);
  if (grant) return true;
  // Аватар профиля доступен любому авторизованному пользователю: клиент
  // получает маршруты к репликам и расшифровывает файл ключом из профиля.
  const asAvatar = await one('SELECT 1 FROM users WHERE avatar_object_id = $1', [objectId]);
  if (asAvatar) return true;
  // Аватар группы/канала доступен любому участнику этого чата — так же, как
  // аватар профиля доступен авторизованному пользователю.
  const asChatAvatar = await one(
    `SELECT 1 FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
      WHERE c.avatar_object_id = $1 LIMIT 1`,
    [objectId, userId],
  );
  if (asChatAvatar) return true;
  const viaMessage = await one(
    `SELECT 1 FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
      WHERE m.object_id = $1 LIMIT 1`,
    [objectId, userId],
  );
  if (viaMessage) return true;
  const viaComment = await one(
    `SELECT 1 FROM post_comments pc
       JOIN chat_members cm ON cm.chat_id = pc.chat_id AND cm.user_id = $2
      WHERE pc.object_id = $1 LIMIT 1`,
    [objectId, userId],
  );
  return Boolean(viaComment);
}

const objectRoutes: FastifyPluginAsync = async (app) => {  /* -------------------------------------------------- init (2-фазная CI) -- */
  app.post('/objects/init', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    rateLimit(`obj:${me}`, 120, 60_000);

    const body = (req.body ?? {}) as { size?: number; sha256?: string };
    const size = Number(body.size ?? 0) | 0;
    const sha256 = String(body.sha256 ?? '');
    if (!Number.isFinite(size) || size <= 0 || size > config.maxUploadBytes) throw badRequest('invalid_size');
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw badRequest('invalid_sha256');

    // Место в сети общее: личная квота больше не блокирует загрузку
    // (поле quota_bytes остаётся в БД/ответах только для отображения).
    const nodes = await pickNodes(config.replicas, size);
    if (!nodes.length) throw new ApiError(503, 'no_nodes_available', 'no_healthy_nodes');

    const objectId = uuid();
    await query(
      `INSERT INTO objects (id, owner_id, size_bytes, sha256, replicas_desired, state)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [objectId, me, size, sha256, nodes.length],
    );
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i]!;
      await query(
        `INSERT INTO fragments (object_id, node_id, index, state) VALUES ($1,$2,$3,'promised')`,
        [objectId, node.id, i],
      );
    }

    log('info', 'object_init', { objectId, size, subnets: [...new Set(nodes.map((n) => n.subnet))].length, replicas: nodes.length });

    return reply.code(201).send({
      id: objectId,
      sizeBytes: size,
      sha256,
      replicasDesired: nodes.length,
      replicas: nodes.map((n, i) => ({
        index: i,
        nodeId: n.id,
        url: `${n.public_url.replace(/\/+$/, '')}/fragments/${objectId}/${i}`,
        ticket: mintTicket(n.ticket_secret, { op: 'put' as const, oid: objectId, idx: i, sub: me, ttlSec: 1800 }),
      })),
    });
  });

  /* ---------------------------------------------------------- commit ------ */
  app.post('/objects/:id/commit', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const body = (req.body ?? {}) as { replicas?: { index: number; nodeId: string; size: number; sha256: string }[] };

    const obj = await one<{ id: string; owner_id: string; size_bytes: number; sha256: string; state: string; replicas_desired: number }>(
      'SELECT id, owner_id, size_bytes, sha256, state, replicas_desired FROM objects WHERE id = $1 AND state = $2',
      [id, 'pending'],
    );
    if (!obj || obj.owner_id !== me) throw notFound('object');

    const claims = (body.replicas ?? []).slice(0, 8);
    if (!claims.length) throw badRequest('replicas_required');

    let acked = 0;
    for (const claim of claims) {
      if (claim.sha256 !== obj.sha256) continue; // узел вернул не тот шифротекст — отказ
      const upd = await query<{ id: string }>(
        `UPDATE fragments SET state = 'ok', size_bytes = $4, sha256 = $5
          WHERE object_id = $1 AND node_id = $2 AND index = $3 AND state = 'promised'
          RETURNING id`,
        [id, claim.nodeId, claim.index, claim.size, claim.sha256],
      );
      if (!upd?.length) continue;
      acked += 1;
      await bumpNodeUsage(claim.nodeId, obj.size_bytes);
      await query('UPDATE nodes SET total_puts = total_puts + 1 WHERE id = $1 AND $2 = $2', [claim.nodeId, claim.size]);
    }

    if (!acked) {
      await query('DELETE FROM objects WHERE id = $1', [id]);
      throw new ApiError(502, 'upload_failed', 'all_nodes_failed');
    }

    await query("UPDATE objects SET state = 'active', replicas_acked = $2 WHERE id = $1", [id, acked]);
    await query('UPDATE users SET used_bytes = used_bytes + $2 WHERE id = $1', [me, obj.size_bytes]);
    await query('INSERT INTO object_grants (object_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, me]);
    log('info', 'object_committed', { objectId: id, acked, desired: obj.replicas_desired });

    return reply.send({
      id,
      sizeBytes: obj.size_bytes,
      sha256: obj.sha256,
      replicas: acked,
      replicasDesired: obj.replicas_desired,
      degraded: acked < obj.replicas_desired,
    });
  });

  /* ------------------------------------------------- relay (резервный) ---- */
  app.post('/objects', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    rateLimit(`obj:${me}`, 60, 60_000);

    const file = await tmpFile();
    let size = 0;
    const hash = createHash('sha256');

    try {
      const contentType = String(req.headers['content-type'] ?? '');
      let source: Readable;
      if (contentType.startsWith('application/octet-stream')) {
        source = req.body as Readable;
      } else {
        const part = await req.file({ limits: { fileSize: config.maxUploadBytes, files: 1 } });
        if (!part) throw badRequest('file_required');
        source = part.file;
      }

      await pipeline(
        source,
        async function* (src: AsyncIterable<Buffer>) {
          for await (const chunk of src) {
            const buf = chunk as Buffer;
            hash.update(buf);
            size += buf.length;
            if (size > config.maxUploadBytes) throw badRequest('file_too_large');
            yield buf;
          }
        },
        createWriteStream(file),
      );

      if (size === 0) throw badRequest('empty_file');

      const sha = hash.digest('hex');
      const objectId = uuid();
      const nodes = await pickNodes(config.replicas, size);
      if (!nodes.length) throw new ApiError(503, 'no_nodes_available', 'no_healthy_nodes');

      await query(
        `INSERT INTO objects (id, owner_id, size_bytes, sha256, replicas_desired) VALUES ($1,$2,$3,$4,$5)`,
        [objectId, me, size, sha, nodes.length],
      );

      const results = await Promise.allSettled(
        nodes.map((node, index) => putFragment(node, objectId, index, me, createReadStream(file), size)),
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

      await query('UPDATE users SET used_bytes = used_bytes + $2 WHERE id = $1', [me, size]);
      await query('INSERT INTO object_grants (object_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [objectId, me]);
      log('info', 'object_stored', { objectId, size, replicas: stored, owner: me });

      return reply.code(201).send({
        id: objectId,
        sizeBytes: size,
        sha256: sha,
        replicas: stored,
        replicasDesired: nodes.length,
        degraded: stored < nodes.length,
      });
    } finally {
      await unlink(file).catch(() => {});
    }
  });

  /* --------------------------------------------------- маршруты отдачи --- */
  app.get('/objects/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;

    const obj = await one<{ id: string; owner_id: string; size_bytes: number; sha256: string }>(
      'SELECT id, owner_id, size_bytes, sha256 FROM objects WHERE id = $1 AND state = $2',
      [id, 'active'],
    );
    if (!obj) throw notFound('object');

    const allowed =
      obj.owner_id === me || (await canAccessObject(id, me));
    if (!allowed) throw forbidden('no_access');

    const frags = await query<{ index: number; node_id: string; size_bytes: number; public_url: string; ticket_secret: string; status: string; subnet: string }>(
      `SELECT f.index, f.node_id, f.size_bytes, n.public_url, n.ticket_secret, n.status, n.subnet
         FROM fragments f JOIN nodes n ON n.id = f.node_id
        WHERE f.object_id = $1 AND f.state = 'ok' AND n.status <> 'banned'
        ORDER BY (n.status = 'online') DESC, n.reputation DESC`,
      [id],
    );

    const routes = frags.map((f) => ({
      index: f.index,
      nodeId: f.node_id,
      subnet: f.subnet,
      url: `${f.public_url.replace(/\/+$/, '')}/fragments/${id}/${f.index}`,
      ticket: mintTicket(f.ticket_secret, { op: 'get' as const, oid: id, idx: f.index, sub: me }),
      sizeBytes: f.size_bytes,
      nodeOnline: f.status === 'online',
    }));

    return reply.send({
      id: obj.id,
      sizeBytes: obj.size_bytes,
      sha256: obj.sha256,
      fragments: routes,
    });
  });

  /** Резервная выдача через Hub — когда клиент не дотягивается до узла (NAT). */
  app.get('/objects/:id/proxy', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;

    const obj = await one<{ owner_id: string }>('SELECT owner_id FROM objects WHERE id = $1 AND state = $2', [id, 'active']);
    if (!obj) throw notFound('object');
    const allowed =
      obj.owner_id === me || (await canAccessObject(id, me));
    if (!allowed) throw forbidden('no_access');

    const f = await query<{ index: number; id: string; node_id: string; public_url: string; ticket_secret: string }>(
      `SELECT f.index, n.id, f.node_id, n.public_url, n.ticket_secret
         FROM fragments f JOIN nodes n ON n.id = f.node_id
        WHERE f.object_id = $1 AND f.state = 'ok' AND n.status = 'online'
        ORDER BY n.reputation DESC`,
      [id],
    );
    if (!f.length) throw new ApiError(502, 'no_live_replica', 'no_live_replica');

    for (const frag of f) {
      try {
        const stream = await getFragment(frag, id, frag.index, me);
        reply.header('content-type', 'application/octet-stream');
        reply.header('x-sg-node', frag.node_id);
        return reply.send(stream);
      } catch (e) {
        log('warn', 'proxy_fragment_failed', { nodeId: frag.node_id, error: String(e).slice(0, 160) });
      }
    }
    throw new ApiError(502, 'no_live_replica', 'no_live_replica');
  });

  /* ------------------------------------------------------------ удаление -- */
  app.delete('/objects/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const obj = await one<{ owner_id: string; size_bytes: number }>(
      'SELECT owner_id, size_bytes FROM objects WHERE id = $1 AND state = $2',
      [id, 'active'],
    );
    if (!obj) throw notFound('object');
    if (obj.owner_id !== me) throw forbidden('not_owner');

    const frags = await query<{ index: number; id: string; node_id: string; public_url: string; ticket_secret: string }>(
      `SELECT f.index, n.id, f.node_id, n.public_url, n.ticket_secret
         FROM fragments f JOIN nodes n ON n.id = f.node_id WHERE f.object_id = $1`,
      [id],
    );

    for (const frag of frags) {
      try {
        await deleteFragment(frag, id, frag.index, me);
        await bumpNodeUsage(frag.node_id, -obj.size_bytes);
      } catch (e) {
        log('warn', 'fragment_delete_failed', { nodeId: frag.node_id, error: String(e).slice(0, 160) });
      }
    }

    await query('DELETE FROM objects WHERE id = $1', [id]);
    await query('UPDATE users SET used_bytes = GREATEST(0, used_bytes - $2) WHERE id = $1', [me, obj.size_bytes]);
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------------- инфо о файле --- */
  app.get('/objects/:id/meta', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const obj = await one<{ id: string; owner_id: string; size_bytes: number; sha256: string; created_at: string }>(
      'SELECT id, owner_id, size_bytes, sha256, created_at FROM objects WHERE id = $1 AND state = $2',
      [id, 'active'],
    );
    if (!obj) throw notFound('object');
    const allowed = obj.owner_id === me || (await canAccessObject(id, me));
    if (!allowed) throw forbidden('no_access');
    const healthy = await one<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM fragments f JOIN nodes n ON n.id = f.node_id
        WHERE f.object_id = $1 AND n.status = 'online' AND f.state = 'ok'`,
      [id],
    );
    return reply.send({ ...obj, healthyReplicas: healthy?.c ?? 0 });
  });

  app.post('/objects/:id/repair', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const obj = await one<{ owner_id: string }>('SELECT owner_id FROM objects WHERE id = $1', [id]);
    if (!obj) throw notFound('object');
    if (obj.owner_id !== me) throw forbidden('not_owner');
    const { repairObject } = await import('../replicator.js');
    const moved = await repairObject(id);
    return reply.send({ repaired: moved });
  });
};

export default objectRoutes;
