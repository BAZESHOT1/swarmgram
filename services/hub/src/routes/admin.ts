/** Админ-панель: управление пользователями, узлами, модулями, чатами/каналами. */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { requireAdmin } from '../auth.js';
import { uuid } from '../crypto.js';
import { one, query } from '../db.js';
import { nodeEvent, resolveSubnet } from '../nodes.js';
import { decryptSecret } from '../secrets.js';
import { badRequest, forbidden, notFound, str } from '../util.js';

import { publish, publishMany } from '../realtime.js';

const adminRoutes: FastifyPluginAsync = async (app) => {
  interface AdminCtx { via: 'token' | 'user'; userId?: string }

  async function audit(ctx: AdminCtx, action: string, target: string, reason = ''): Promise<void> {
    await query('INSERT INTO audit_log (actor_id, action, target, meta) VALUES ($1,$2,$3,$4)', [
      ctx.userId ?? null, action, target, JSON.stringify({ reason }),
    ]);
  }

  /* ------------------------------------------------------------- Users --- */
  app.get('/admin/users', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const q = str((req.query as { q?: string }).q ?? '', 'q', { max: 64 }).toLowerCase();
    const params: unknown[] = [];
    let where = '1=1';
    if (q.length >= 2) {
      params.push(`%${q}%`);
      where += ` AND (lower(username) LIKE $${params.length} OR lower(email) LIKE $${params.length} OR lower(display_name) LIKE $${params.length})`;
    }
    const rows = await query(
      `SELECT id, email, username, display_name, role, plan, status, suspended_reason, blocked_by,
              quota_bytes, used_bytes, email_verified, created_at, last_seen_at
         FROM users WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
      params,
    );
    return reply.send(rows);
  });

  app.post('/admin/users/:id/status', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string; reason?: string };
    const requested = str(body.status ?? '', 'status');
    // 'banned' — публичный алиас блокировки для админки, в БД храним 'suspended'
    const status = requested === 'banned' ? 'suspended' : requested;
    if (!['active', 'suspended'].includes(status)) throw badRequest('invalid_status');

    const user = await one<{ id: string }>('SELECT id FROM users WHERE id = $1', [id]);
    if (!user) throw notFound('user');

    await query(
      `UPDATE users SET status = $2, suspended_reason = $3 WHERE id = $1`,
      [id, status, status === 'suspended' ? str(body.reason ?? '', 'reason', { max: 300 }) : null],
    );
    if (status === 'suspended') {
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [id]);
      publish(id, { type: 'account_suspended' });
    }
    await audit(ctx, `user_${status}`, id, body.reason ?? '');
    return reply.send({ ok: true, status });
  });

  app.post('/admin/users/:id/role', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { role?: string };
    const role = str(body.role ?? '', 'role');
    if (!['user', 'admin'].includes(role)) throw badRequest('invalid_role');
    await query('UPDATE users SET role = $2 WHERE id = $1', [id, role]);
    await audit(ctx, `user_role_${role}`, id);
    return reply.send({ ok: true, role });
  });

  app.post('/admin/users/:id/quota', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { quotaBytes?: number; plan?: string };
    const quota = Math.max(0, Number(body.quotaBytes ?? 0)) | 0;
    const plan = str(body.plan ?? '', 'plan', { max: 16 });
    const user = await one<PlanRow>('SELECT quota_bytes, plan FROM users WHERE id = $1', [id]);
    if (!user) throw notFound('user');
    await query(
      `UPDATE users SET quota_bytes = $2, plan = COALESCE(NULLIF($3,''), plan) WHERE id = $1`,
      [id, quota > 0 ? quota : user.quota_bytes, plan],
    );
    await audit(ctx, 'user_quota', id, `quota=${quota}, plan=${plan}`);
    return reply.send({ ok: true });
  });

  app.delete('/admin/users/:id', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    await query('DELETE FROM users WHERE id = $1', [id]);
    await audit(ctx, 'user_deleted', id, body.reason ?? '');
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------------------- Nodes --- */
  app.get('/admin/nodes', { onRequest: [requireAdmin()] }, async (_req, reply) => {
    return reply.send(await query(
      `SELECT n.id, n.name, n.owner_id, u.username AS owner_username, n.status, n.blocked_reason,
              n.public_url, n.subnet, n.last_ip, n.hw_hash, n.region, n.reputation, n.version,
              n.capacity_bytes, n.used_bytes, n.free_bytes, n.last_heartbeat_at, n.registered_at
         FROM nodes n LEFT JOIN users u ON u.id = n.owner_id
        ORDER BY n.status, n.reputation DESC`,
    ));
  });

  app.post('/admin/nodes/:id/block', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string; terminateData?: boolean };
    const node = await one<{ last_ip: string; hw_hash: string; name: string; owner_id: string | null; capacity: number }>(
      `SELECT last_ip, hw_hash, name, owner_id, capacity_bytes AS capacity FROM nodes WHERE id = $1`,
      [id],
    );
    if (!node) throw notFound('node');

    const reason = str(body.reason ?? '', 'reason', { max: 300 }) || `node ${node.name}`;
    if (node.last_ip || node.hw_hash) {
      await query(
        `INSERT INTO blocked_nodes (ip, hw_hash, reason)
         SELECT $1, $2, $3 WHERE NOT (COALESCE($1,'') = '' AND COALESCE($2,'') = '')`,
        [node.last_ip, node.hw_hash, reason],
      );
    }
    await query(
      `UPDATE nodes SET status = 'banned', reputation = 0, blocked_reason = $2 WHERE id = $1`,
      [id, reason],
    );
    await nodeEvent(id, 'admin_banned', `IP=${node.last_ip} HW=${node.hw_hash} · ${reason}`);
    if (body.terminateData && node.owner_id) {
      // блокируем и сам аккаунт-владелец, если узел доверенный
      await query(`UPDATE users SET status = 'suspended', blocked_by = $2 WHERE id = $1`, [node.owner_id, `node ${reason}`]);
      await query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [node.owner_id]);
    }
    await audit(ctx, 'node_blocked', id, reason);
    return reply.send({ ok: true });
  });

  app.post('/admin/nodes/:id/unblock', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    const node = await one<{ last_ip: string; hw_hash: string }>('SELECT last_ip, hw_hash FROM nodes WHERE id = $1', [id]);
    if (!node) throw notFound('node');

    await query(
      `UPDATE blocked_nodes SET active = false WHERE (ip = $1 AND ip <> '') OR (hw_hash = $2 AND hw_hash <> '')`,
      [node.last_ip, node.hw_hash],
    );
    await query(`UPDATE nodes SET status = 'offline', blocked_reason = NULL WHERE id = $1`, [id]);
    await nodeEvent(id, 'admin_unbanned', body.reason ?? '');
    await audit(ctx, 'node_unblocked', id, body.reason ?? '');
    return reply.send({ ok: true });
  });

  /* ----------------------------------------------------------- Modules --- */
  app.get('/admin/modules', { onRequest: [requireAdmin()] }, async (_req, reply) => {
    return reply.send(await query(
      `SELECT m.id, m.board_uuid, m.module_type, m.is_public, m.kind, m.owner_id, u.username AS owner_username,
              m.status, m.blocked_reason, m.firmware, m.battery, m.gateway, m.neighbors, m.last_seen_at
         FROM modules m LEFT JOIN users u ON u.id = m.owner_id
        ORDER BY m.status, m.last_seen_at DESC NULLS LAST`,
    ));
  });

  app.post('/admin/modules/:id/block', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    const mod = await one<{ board_uuid: string; owner_id: string; name: string }>(
      'SELECT board_uuid, owner_id, board_uuid AS name FROM modules WHERE id = $1',
      [id],
    );
    if (!mod) throw notFound('module');
    const reason = str(body.reason ?? '', 'reason', { max: 300 }) || `module ${mod.board_uuid}`;
    await query(
      `INSERT INTO blocked_nodes (ip, hw_hash, reason) VALUES ('', $1, $2)`,
      [(await import('../crypto.js')).sha256(mod.board_uuid), reason],
    );
    await query(`UPDATE modules SET blocked_reason = $2, status = 'offline' WHERE id = $1`, [id, reason]);
    publish(mod.owner_id, { type: 'module_blocked', moduleId: id, reason });
    await audit(ctx, 'module_blocked', id, reason);
    return reply.send({ ok: true });
  });

  app.post('/admin/modules/:id/unblock', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    const mod = await one<{ board_uuid: string }>('SELECT board_uuid FROM modules WHERE id = $1', [id]);
    if (!mod) throw notFound('module');
    await query(
      `UPDATE blocked_nodes SET active = false WHERE (hw_hash = $1 AND hw_hash <> '') OR (ip = $2 AND ip <> '')`,
      [(await import('../crypto.js')).sha256(mod.board_uuid), 'never-used-no-ip'],
    );
    await query(`UPDATE modules SET blocked_reason = NULL, status = 'offline' WHERE id = $1`, [id]);
    await audit(ctx, 'module_unblocked', id, body.reason ?? '');
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------- Channels & groups --- */
  app.get('/admin/chats', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const type = str((req.query as { type?: string }).type ?? '', 'type', { max: 16 });
    const allowed = ['channel', 'group', 'direct'].includes(type) ? type : null;
    const rows = await query(
      `SELECT c.id, c.type, c.title, c.is_public, c.blocked_reason, c.owner_id, u.username AS owner_username,
              COUNT(DISTINCT cm.user_id)::int AS members,
              (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id = c.id) AS messages
         FROM chats c
         LEFT JOIN users u ON u.id = c.owner_id
         LEFT JOIN chat_members cm ON cm.chat_id = c.id
        WHERE (${allowed ? 'c.type = $1' : 'TRUE'})
        GROUP BY c.id, c.title, u.username
        ORDER BY c.created_at DESC LIMIT 200`,
      allowed ? [allowed] : [],
    );
    return reply.send(rows);
  });

  app.post('/admin/chats/:id/block', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    const chat = await one<{ id: string; type: string }>('SELECT id, type FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    const reason = str(body.reason ?? '', 'reason', { max: 300 });
    if (!reason) throw badRequest('reason_required');
    await query(`UPDATE chats SET blocked_reason = $2 WHERE id = $1`, [id, reason]);
    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [id]);
    for (const m of members) publish(m.user_id, { type: 'chat_blocked', chatId: id, reason });
    await audit(ctx, 'chat_blocked', id, reason);
    return reply.send({ ok: true });
  });

  app.post('/admin/chats/:id/unblock', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    await query(`UPDATE chats SET blocked_reason = NULL WHERE id = $1`, [id]);
    await audit(ctx, 'chat_unblocked', id);
    return reply.send({ ok: true });
  });

  app.delete('/admin/chats/:id', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { reason?: string };
    const chat = await one<{ id: string }>('SELECT id FROM chats WHERE id = $1', [id]);
    if (!chat) throw notFound('chat');
    // cascade objects/messages via SQL
    await query(
      `UPDATE objects SET state = 'deleted' WHERE id IN (SELECT object_id FROM messages WHERE chat_id = $1 AND object_id IS NOT NULL)`,
      [id],
    );
    await query('DELETE FROM chats WHERE id = $1', [id]);
    await audit(ctx, 'chat_deleted', id, body.reason ?? 'deleted by admin');
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------------------ жалобы --- */
  app.get('/admin/reports', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const raw = str((req.query as { status?: string }).status ?? '', 'status', { max: 16 });
    const filter = raw === 'all' ? 'all' : 'open';
    const rows = await query<ReportRow>(
      `SELECT r.id, r.reason, r.note, r.status, r.resolution_note, r.created_at, r.resolved_at,
              r.reporter_id, rp.username AS reporter_username, rp.display_name AS reporter_display_name,
              r.target_id, tp.username AS target_username, tp.display_name AS target_display_name,
              tp.status AS target_status,
              (SELECT COUNT(*)::int FROM chat_members cm WHERE cm.user_id = r.target_id) AS chats_count
         FROM user_reports r
         JOIN users rp ON rp.id = r.reporter_id
         JOIN users tp ON tp.id = r.target_id
        WHERE ($1 = 'all' OR r.status = 'open')
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [filter],
    );
    return reply.send(rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      note: r.note,
      status: r.status,
      resolutionNote: r.resolution_note,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at ?? null,
      reporter: {
        userId: r.reporter_id,
        username: r.reporter_username,
        displayName: r.reporter_display_name,
      },
      target: {
        userId: r.target_id,
        username: r.target_username,
        displayName: r.target_display_name,
        status: r.target_status,
      },
      chatsCount: Number(r.chats_count ?? 0),
    })));
  });

  app.post('/admin/reports/:id/resolve', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('invalid_report');
    const body = (req.body ?? {}) as { status?: string; note?: string };
    const status = str(body.status ?? '', 'status');
    if (!['open', 'resolved', 'dismissed'].includes(status)) throw badRequest('invalid_status');
    const note = body.note === undefined ? '' : str(body.note, 'note', { max: 500 });

    const report = await one<{ id: number }>('SELECT id FROM user_reports WHERE id = $1', [id]);
    if (!report) throw notFound('report');

    await query(
      `UPDATE user_reports
          SET status = $2,
              resolution_note = $3,
              resolved_by = CASE WHEN $2 = 'open' THEN NULL ELSE $4::uuid END,
              resolved_at = CASE WHEN $2 = 'open' THEN NULL ELSE now() END
        WHERE id = $1`,
      [id, status, note, ctx.userId ?? null],
    );
    await audit(ctx, `report_${status}`, String(id), note);
    return reply.send({ ok: true, status });
  });

  /* --------------------------------------------------- чаты нарушителя --- */
  app.get('/admin/users/:id/chats', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = await one<{ id: string }>('SELECT id FROM users WHERE id = $1', [id]);
    if (!user) throw notFound('user');

    const rows = await query<{
      id: string; type: string; title: string; encryption: string; last_seq: number;
      members_count: number; peer_username: string | null; peer_display_name: string | null;
    }>(
      `SELECT c.id, c.type, c.title, c.encryption, c.last_seq,
              COUNT(cm2.user_id)::int AS members_count,
              peer.username AS peer_username, peer.display_name AS peer_display_name
         FROM chat_members mine
         JOIN chats c ON c.id = mine.chat_id
         LEFT JOIN chat_members cm2 ON cm2.chat_id = c.id
         LEFT JOIN LATERAL (
           SELECT u.username, u.display_name
             FROM chat_members x
             JOIN users u ON u.id = x.user_id
            WHERE x.chat_id = c.id AND x.user_id <> $1
            LIMIT 1
         ) peer ON TRUE
        WHERE mine.user_id = $1
        GROUP BY c.id, peer.username, peer.display_name
        ORDER BY c.updated_at DESC
        LIMIT 200`,
      [id],
    );

    return reply.send(rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.type === 'direct'
        ? (r.peer_display_name || r.peer_username || 'Диалог')
        : r.title,
      encryption: r.encryption === 'e2e' ? 'e2e' : 'server',
      membersCount: Number(r.members_count ?? 0),
      lastSeq: Number(r.last_seq ?? 0),
    })));
  });

  /* ------------------------------------------------ просмотр переписки --- */
  app.get('/admin/chats/:id/view', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const chat = await one<{ id: string; type: string; title: string; encryption: string }>(
      'SELECT id, type, title, encryption FROM chats WHERE id = $1',
      [id],
    );
    if (!chat) throw notFound('chat');

    const members = await query<{ user_id: string; username: string; display_name: string; role: string }>(
      `SELECT cm.user_id, u.username, u.display_name, cm.role
         FROM chat_members cm
         JOIN users u ON u.id = cm.user_id
        WHERE cm.chat_id = $1
        ORDER BY u.username`,
      [id],
    );

    const rows = await query<{
      id: string; seq: number; kind: string; header: unknown; object_id: string | null;
      created_at: string; sender_username: string;
    }>(
      `SELECT m.id, m.seq, m.kind, m.header, m.object_id, m.created_at, u.username AS sender_username
         FROM messages m
         JOIN users u ON u.id = m.sender_user_id
        WHERE m.chat_id = $1
        ORDER BY m.seq DESC
        LIMIT 60`,
      [id],
    );

    // Для server-чата администратору доступен текущий ключ; E2E сервер расшифровать не может.
    let key: { key: string; version: number } | null = null;
    if (chat.encryption !== 'e2e') {
      const keyRow = await one<{ version: number; key_enc: string }>(
        'SELECT version, key_enc FROM chat_key_versions WHERE chat_id = $1 ORDER BY version DESC LIMIT 1',
        [id],
      );
      if (keyRow) key = { key: decryptSecret(keyRow.key_enc), version: keyRow.version };
    }

    const title = chat.type === 'direct'
      ? (members.map((m) => m.display_name || m.username).join(' ↔ ') || 'Диалог')
      : chat.title;

    return reply.send({
      chat: {
        id: chat.id,
        type: chat.type,
        title,
        encryption: chat.encryption === 'e2e' ? 'e2e' : 'server',
        membersCount: members.length,
      },
      members: members.map((m) => ({
        userId: m.user_id,
        username: m.username,
        displayName: m.display_name,
        role: m.role,
      })),
      messages: rows.reverse().map((m) => {
        const meta = adminHeaderMeta(m.header);
        return {
          id: m.id,
          seq: m.seq,
          kind: m.kind,
          createdAt: m.created_at,
          senderUsername: m.sender_username,
          objectId: m.object_id,
          nonce: meta.nonce,
          header: m.header,
          scheme: meta.scheme,
          keyVersion: meta.keyVersion,
          edited: meta.edited,
        };
      }),
      key,
    });
  });

  app.delete('/admin/messages/:id', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const msg = await one<{ chat_id: string; object_id: string | null }>(
      'SELECT chat_id, object_id FROM messages WHERE id = $1',
      [id],
    );
    if (!msg) throw notFound('message');

    await query('DELETE FROM messages WHERE id = $1', [id]);
    if (msg.object_id) {
      await query("UPDATE objects SET state = 'deleted' WHERE id = $1", [msg.object_id]);
    }
    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [msg.chat_id]);
    publishMany(members.map((m) => m.user_id), {
      type: 'message_deleted',
      chatId: msg.chat_id,
      messageId: id,
    });
    await audit(ctx, 'message_deleted', id, `chat=${msg.chat_id}`);
    return reply.send({ ok: true });
  });

  /* --------------------------------------------------- предупреждения --- */
  app.post('/admin/users/:id/warn', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const ctx = (req as unknown as { admin: AdminCtx }).admin;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { note?: string };
    const note = body.note === undefined ? '' : str(body.note, 'note', { max: 500 });
    const user = await one<{ id: string }>('SELECT id FROM users WHERE id = $1', [id]);
    if (!user) throw notFound('user');

    await query(
      'INSERT INTO user_warnings (user_id, admin_id, note) VALUES ($1,$2,$3)',
      [id, ctx.userId ?? null, note],
    );
    await audit(ctx, 'user_warned', id, note);
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------------------ blocked --- */
  app.get('/admin/blocked', { onRequest: [requireAdmin()] }, async (_req, reply) => {
    return reply.send(await query(
      `SELECT id, ip, hw_hash, reason, created_at FROM blocked_nodes WHERE active = true ORDER BY created_at DESC`,
    ));
  });

  app.delete('/admin/blocked/:id', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await query('UPDATE blocked_nodes SET active = false WHERE id = $1', [id]);
    return reply.send({ ok: true });
  });

  /* --------------------------------------------------------------- audit -- */
  app.get('/admin/audit', { onRequest: [requireAdmin()] }, async (_req, reply) => {
    return reply.send(await query(
      `SELECT a.id, a.actor_id, u.username AS actor, a.action, a.target, a.meta, a.created_at
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.created_at DESC LIMIT 100`,
    ));
  });
};

interface PlanRow { quota_bytes: number; plan: string }

interface ReportRow {
  id: number;
  reason: string;
  note: string;
  status: string;
  resolution_note: string;
  created_at: string;
  resolved_at: string | null;
  reporter_id: string;
  reporter_username: string;
  reporter_display_name: string;
  target_id: string;
  target_username: string;
  target_display_name: string;
  target_status: string;
  chats_count: number;
}

/** Метаданные конверта сообщения (как в публичной истории чата). */
function adminHeaderMeta(header: unknown): { scheme: 'server' | 'e2e'; keyVersion: number | null; nonce: string; edited: boolean } {
  const h = header && typeof header === 'object' ? (header as Record<string, unknown>) : {};
  const rawVersion = h.keyVersion;
  const keyVersion = typeof rawVersion === 'number'
    ? rawVersion
    : rawVersion !== undefined && Number.isFinite(Number(rawVersion))
      ? Number(rawVersion)
      : null;
  return {
    scheme: h.scheme === 'server' ? 'server' : 'e2e',
    keyVersion,
    nonce: typeof h.nonce === 'string' ? h.nonce : '',
    edited: h.edited === true,
  };
}

export default adminRoutes;
export const _unusedNames = { resolveSubnet, uuid, forbidden };
