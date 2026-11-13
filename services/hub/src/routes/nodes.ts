/**
 * Узлы сети: саморегистрация контейнера, heartbeat, телеметрия, управление.
 * Регистрация защищена claim-токеном, который пользователь создаёт в клиенте
 * (иначе любой мог бы привязать узел к чужому username).
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin, requireAuth } from '../auth.js';
import { config } from '../config.js';
import { hashCode, randomCode, signToken, uuid, verifyToken } from '../crypto.js';
import { one, query } from '../db.js';
import { drainNode } from '../drain.js';
import { nodeEvent, resolveSubnet } from '../nodes.js';
import { badRequest, clientIp, forbidden, log, notFound, rateLimit, str, unauthorized } from '../util.js';

declare module 'fastify' {
  interface FastifyRequest {
    node?: { nodeId: string };
  }
}

/** Аутентификация узла по его долгоживущему токену. */
function requireNode() {
  return async (req: FastifyRequest): Promise<void> => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized('node_token_required');
    const claims = verifyToken(token, config.jwtSecret);
    if (!claims || claims.type !== 'node') throw unauthorized('invalid_node_token');
    req.node = { nodeId: claims.sub };
  };
}

const nodeRoutes: FastifyPluginAsync = async (app) => {
  /* --------------------------------------------------- claim-токен (юзер) */
  app.post('/nodes/claim', { onRequest: [requireAuth()] }, async (req, reply) => {
    rateLimit(`claim:${req.auth!.userId}`, 20, 60 * 60 * 1000);
    const body = (req.body ?? {}) as { nodeName?: string };
    const code = randomCode(12);
    const row = await one<{ id: string; expires_at: string }>(
      `INSERT INTO node_claims (user_id, code_hash, expires_at)
       VALUES ($1,$2, now() + interval '30 minutes') RETURNING id, expires_at`,
      [req.auth!.userId, await hashCode(code)],
    );
    log('info', 'node_claim_created', { userId: req.auth!.userId, name: body.nodeName ?? '' });
    return reply.send({ claimToken: code, expiresAt: row!.expires_at });
  });

  app.get('/nodes/claims', { onRequest: [requireAuth()] }, async (req, reply) => {
    const rows = await query<{ id: string; expires_at: string; consumed_at: string | null; node_id: string | null; created_at: string }>(
      `SELECT id, expires_at, consumed_at, node_id, created_at FROM node_claims
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.auth!.userId],
    );
    return reply.send(rows);
  });

  /* ---------------------------------------------------------- регистрация */
  app.post('/nodes/register', async (req, reply) => {
    rateLimit(`nreg:${clientIp(req)}`, 20, 60 * 60 * 1000);

    const body = (req.body ?? {}) as {
      ownerUsername?: string;
      claimToken?: string;
      name?: string;
      publicUrl?: string;
      capacityBytes?: number;
      region?: string;
      version?: string;
      nodeId?: string;
      hardwareId?: string;
    };

    const ownerUsername = str(body.ownerUsername, 'ownerUsername').toLowerCase();
    const claimToken = str(body.claimToken ?? '', 'claimToken', { max: 64 });
    const name = str(body.name ?? 'klinto-node', 'name', { max: 64 });
    const publicUrl = str(body.publicUrl, 'publicUrl', { max: 300 });
    if (!/^https?:\/\//.test(publicUrl)) throw badRequest('invalid_public_url');
    const capacityBytes = Math.max(0, Number(body.capacityBytes ?? 0) || 0);
    const ip = clientIp(req);
    const hwHash = str(body.hardwareId ?? '', 'hardwareId', { max: 128 }).toLowerCase();
    const subnet = await resolveSubnet(publicUrl);

    const blocked = await one(
      `SELECT 1 FROM blocked_nodes WHERE active = true AND (ip = $1${hwHash ? ' OR hw_hash = $2' : ''})`,
      hwHash ? [ip, hwHash] : [ip],
    );
    if (blocked) {
      log('warn', 'node_blocked_register', { ip, hwHash });
      throw forbidden('node_blocked');
    }

    const owner = await one<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE lower(username) = $1`,
      [ownerUsername],
    );
    if (!owner) throw notFound('owner_not_found');
    if (owner.status !== 'active') throw forbidden('owner_disabled');

    if (!claimToken && !config.allowOpenNodes) throw unauthorized('claim_token_required');

    if (claimToken) {
      const claim = await one<{ id: string; user_id: string; code_hash: string; expires_at: string; consumed_at: string | null }>(
        `SELECT id, user_id, code_hash, expires_at, consumed_at FROM node_claims
          WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
        [owner.id],
      );
      if (!claim || claim.code_hash !== (await hashCode(claimToken))) throw unauthorized('invalid_claim_token');
      if (claim.user_id !== owner.id) throw forbidden('claim_owner_mismatch');

      const nodeId = uuid();
      const ticketSecret = `${uuid()}${uuid()}`;
      const nodeToken = signToken(
        { sub: nodeId, type: 'node', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 },
        config.jwtSecret,
      );

      await query(
        `INSERT INTO nodes (id, owner_id, name, public_url, ticket_secret, region, version, capacity_bytes, free_bytes, status, subnet, last_ip, hw_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'pending',$9,$10,$11)`,
        [
          nodeId,
          owner.id,
          name,
          publicUrl,
          ticketSecret,
          str(body.region ?? '', 'region', { max: 32 }),
          body.version ?? '1.0.0',
          capacityBytes,
          subnet,
          ip,
          hwHash,
        ],
      );
      await query('UPDATE node_claims SET consumed_at = now(), node_id = $2 WHERE id = $1', [claim.id, nodeId]);
      await query('INSERT INTO node_events (node_id, type, message) VALUES ($1,$2,$3)', [
        nodeId,
        'registered',
        `${name} (${publicUrl})`,
      ]);
      await query('INSERT INTO audit_log (actor_id, action, target) VALUES ($1,$2,$3)', [owner.id, 'node_registered', nodeId]);

      log('info', 'node_registered', { nodeId, owner: ownerUsername, publicUrl, capacityBytes });

      return reply.code(201).send({
        nodeId,
        nodeToken,
        ticketSecret,
        heartbeatIntervalSec: config.nodeHeartbeatIntervalSec,
        ownerUsername,
        status: 'pending',
      });
    }

    throw badRequest('claim_token_required');
  });

  /* ------------------------------------------------------------ heartbeat */
  app.post('/nodes/heartbeat', { onRequest: [requireNode()] }, async (req, reply) => {
    try {
      const nodeId = req.node!.nodeId;
      const body = (req.body ?? {}) as { freeBytes?: number; usedBytes?: number; load?: number; version?: string; publicUrl?: string; hardwareId?: string };

      const freeBytes = Math.max(0, Number(body.freeBytes ?? 0) || 0);
      const usedBytes = Math.max(0, Number(body.usedBytes ?? 0) || 0);
      const ip = clientIp(req);
      const hwHash = str(body.hardwareId ?? '', 'hardwareId', { max: 128 }).toLowerCase();

      if (ip || hwHash) {
        const banned = await one(
          `SELECT 1 FROM blocked_nodes WHERE active = true AND (COALESCE(ip,'') = $1 OR COALESCE(hw_hash,'') = $2) LIMIT 1`,
          [ip, hwHash],
        );
        if (banned) {
          log('warn', 'node_blocked_heartbeat', { nodeId, ip, hwHash });
          return reply.code(403).send({ error: 'node_blocked', message: 'hardware_or_ip_blacklisted' });
        }
      }

      const subnet = await resolveSubnet(String(body.publicUrl ?? ''));
      await query(
        `UPDATE nodes
            SET last_heartbeat_at = now(),
                free_bytes = $2,
                used_bytes = $3,
                version = COALESCE(NULLIF($4,''), version),
                public_url = COALESCE(NULLIF($5,''), public_url),
                subnet = COALESCE(NULLIF($6,''), subnet),
                last_ip = $7,
                hw_hash = COALESCE(NULLIF($8,''), hw_hash),
                status = CASE
                  WHEN status = 'draining' THEN status
                  WHEN status IN ('pending','degraded') THEN 'online'
                  -- планово выведенный узел не должен «воскресать» от heartbeat
                  WHEN status = 'offline' AND drain_requested_at IS NULL THEN 'online'
                  ELSE status
                END
          WHERE id = $1`,
        [nodeId, freeBytes, usedBytes, String(body.version ?? ''), String(body.publicUrl ?? ''), subnet, ip, hwHash],
      );

      // суточный учёт вклада узла (для начисления кредитов владельцу)
      await query(
        `INSERT INTO node_contributions (node_id, day, bytes_stored, uptime_seconds)
         VALUES ($1, current_date, $2, $3)
         ON CONFLICT (node_id, day) DO UPDATE
           SET bytes_stored = GREATEST(node_contributions.bytes_stored, EXCLUDED.bytes_stored),
               uptime_seconds = node_contributions.uptime_seconds + EXCLUDED.uptime_seconds`,
        [nodeId, usedBytes, config.nodeHeartbeatIntervalSec],
      );

      const node = await one<{ status: string; owner_id: string | null; drain_requested_at: string | null }>(
        'SELECT status, owner_id, drain_requested_at FROM nodes WHERE id = $1',
        [nodeId],
      );
      const status = node?.status ?? 'online';
      return reply.send({
        ok: true,
        status,
        // плановый вывод: узел больше не принимает новые фрагменты
        drain: status === 'draining',
        // вывод завершён: можно удалять локальные фрагменты и выключаться
        stop: status === 'offline' && node?.drain_requested_at != null,
        heartbeatIntervalSec: config.nodeHeartbeatIntervalSec,
        serverTime: new Date().toISOString(),
      });
    } catch (e) {
      log('error', 'heartbeat_failed', { nodeId: req.node!.nodeId, error: e instanceof Error ? e.message : String(e) });
      return reply.code(500).send({ error: 'internal_error' });
    }
  });

  /** Узел сообщает об ошибке — попадает в лентy событий. */
  app.post('/nodes/report', { onRequest: [requireNode()] }, async (req, reply) => {
    const body = (req.body ?? {}) as { type?: string; message?: string };
    await nodeEvent(req.node!.nodeId, str(body.type ?? 'report', 'type', { max: 32 }), str(body.message ?? '', 'message', { max: 500 }));
    return reply.send({ ok: true });
  });

  /* -------------------------------------------------------------- списки -- */
  app.get('/nodes', { onRequest: [requireAuth()] }, async (req, reply) => {
    const rows = await query<{
      id: string;
      name: string;
      status: string;
      region: string;
      reputation: number;
      capacity_bytes: number;
      used_bytes: number;
      free_bytes: number;
      last_heartbeat_at: string | null;
      owner_username: string | null;
    }>(
      `SELECT n.id, n.name, n.status, n.region, n.reputation, n.capacity_bytes, n.used_bytes, n.free_bytes,
              n.last_heartbeat_at, u.username AS owner_username
         FROM nodes n LEFT JOIN users u ON u.id = n.owner_id
        WHERE n.status <> 'banned'
        ORDER BY (n.status = 'online') DESC, n.reputation DESC`,
    );
    return reply.send(rows);
  });

  app.get('/nodes/mine', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const rows = await query(
      `SELECT n.id, n.name, n.public_url, n.status, n.region, n.reputation, n.capacity_bytes, n.used_bytes,
              n.free_bytes, n.total_puts, n.total_gets, n.bytes_served, n.last_heartbeat_at, n.registered_at,
              n.drain_requested_at, n.drained_at,
              COALESCE((SELECT SUM(credits) FROM node_contributions nc WHERE nc.node_id = n.id),0) AS credits
         FROM nodes n WHERE n.owner_id = $1 ORDER BY n.registered_at DESC`,
      [me],
    );
    return reply.send(rows);
  });

  app.get('/nodes/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = await one<{ id: string; owner_id: string | null }>('SELECT id, owner_id FROM nodes WHERE id = $1', [id]);
    if (!node) throw notFound('node');
    if (node.owner_id !== req.auth!.userId) throw forbidden('not_owner');

    const events = await query(
      'SELECT type, message, created_at FROM node_events WHERE node_id = $1 ORDER BY created_at DESC LIMIT 50',
      [id],
    );
    const contrib = await query(
      'SELECT day, bytes_stored, uptime_seconds, credits FROM node_contributions WHERE node_id = $1 ORDER BY day DESC LIMIT 30',
      [id],
    );
    return reply.send({ node, events, contributions: contrib });
  });

  /**
   * Плавный вывод узла: реплики переносятся на живые узлы, после чего узел
   * гасится. Ответ отдаём сразу (202), миграция идёт в фоне.
   * Идемпотентно: повторный вызов не создаёт дублей и не ломает вывод.
   */
  app.post('/nodes/:id/drain', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = await one<{
      owner_id: string | null;
      status: string;
      drain_requested_at: string | null;
      drained_at: string | null;
    }>(
      'SELECT owner_id, status, drain_requested_at, drained_at FROM nodes WHERE id = $1',
      [id],
    );
    if (!node) throw notFound('node');
    if (node.owner_id !== req.auth!.userId) throw forbidden('not_owner');
    if (node.status === 'banned') throw forbidden('node_banned');

    // уже выведен — просто подтверждаем результат
    if (node.status === 'offline' && node.drained_at) {
      return reply.code(202).send({ ok: true, status: 'offline' });
    }

    // событие пишем только на первый запрос, повторный вызов — идемпотентен
    const alreadyRequested = node.status === 'draining' || node.drain_requested_at !== null;

    await query(
      `UPDATE nodes
          SET status = 'draining',
              drain_requested_at = COALESCE(drain_requested_at, now())
        WHERE id = $1`,
      [id],
    );

    if (!alreadyRequested) {
      await nodeEvent(id, 'drain_requested', 'requested by owner');
      log('info', 'node_drain_requested', { nodeId: id, ownerId: req.auth!.userId });
    }

    // Не ждём миграцию: ответ уходит сразу, работа продолжается в фоне.
    void drainNode(id);

    return reply.code(202).send({ ok: true, status: 'draining' });
  });

  app.post('/nodes/:id/status', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = str(body.status ?? '', 'status');
    if (!['draining', 'online', 'offline'].includes(status)) throw badRequest('invalid_status');

    const node = await one<{ owner_id: string | null }>('SELECT owner_id FROM nodes WHERE id = $1', [id]);
    if (!node) throw notFound('node');
    if (node.owner_id !== req.auth!.userId) throw forbidden('not_owner');

    await query('UPDATE nodes SET status = $2 WHERE id = $1', [id, status]);
    await nodeEvent(id, `status_${status}`, 'changed by owner');
    return reply.send({ ok: true, status });
  });

  /* --------------------------------------------------------------- админ -- */
  app.post('/admin/nodes/:id/status', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string };
    const status = str(body.status ?? '', 'status');
    if (!['online', 'degraded', 'offline', 'banned', 'draining', 'pending'].includes(status)) {
      throw badRequest('invalid_status');
    }
    await query('UPDATE nodes SET status = $2 WHERE id = $1', [id, status]);
    await nodeEvent(id, `admin_${status}`, 'changed by admin');
    log('warn', 'admin_node_status', { nodeId: id, status });
    return reply.send({ ok: true, status });
  });

  /** Начисление кредитов владельцу узла за сутки работы (вызывается планировщиком/админом). */
  app.post('/admin/accrue', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const rows = await query<{ node_id: string; owner_id: string; bytes_stored: number; uptime_seconds: number }>(
      `SELECT nc.node_id, n.owner_id, COALESCE(SUM(nc.bytes_stored),0) AS bytes_stored,
              COALESCE(SUM(nc.uptime_seconds),0) AS uptime_seconds
         FROM node_contributions nc JOIN nodes n ON n.id = nc.node_id
        WHERE n.owner_id IS NOT NULL
        GROUP BY nc.node_id, n.owner_id`,
    );

    let accrued = 0;
    for (const r of rows) {
      // 1 кредит за 1 GB·день хранения + 1 кредит за 6 часов аптайма
      const credits = (r.bytes_stored / 1024 ** 3) * 1 + r.uptime_seconds / 21600;
      if (credits <= 0) continue;
      await query(
        'INSERT INTO ledger (user_id, type, amount, meta) VALUES ($1,$2,$3,$4)',
        [r.owner_id, 'node_contribution', credits, { nodeId: r.node_id }],
      );
      accrued += credits;
    }
    return reply.send({ nodes: rows.length, accrued });
  });
};

export default nodeRoutes;
