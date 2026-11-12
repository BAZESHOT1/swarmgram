/**
 * Push-уведомления: регистрация FCM-токенов, история и background-fallback.
 *
 * Поток:
 *  - клиент регистрирует токен (POST /push/token) при старте;
 *  - сервер складывает уведомления в push_notifications и шлёт через FCM;
 *  - если FCM недоступен/устройство офлайн, приложение при background-fetch
 *    забирает GET /notifications/pending и помечает доставленные
 *    POST /notifications/:id/delivered.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin, requireAuth } from '../auth.js';
import { query } from '../db.js';
import { enqueueNotification, isKnownPlatform, sendSystemNotification } from '../push.js';
import { badRequest, notFound, rateLimit, str } from '../util.js';

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

interface NotificationDbRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
}

function toApi(row: NotificationDbRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
  };
}

const notificationRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------------- push-токены ---- */
  app.post('/push/token', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    rateLimit(`push-token:${me}`, 60, 60_000);

    const body = (req.body ?? {}) as { token?: unknown; platform?: unknown; deviceId?: unknown };
    const token = str(body.token, 'token', { max: 4096 });
    if (token.length < 10) throw badRequest('invalid_token');
    if (!isKnownPlatform(body.platform)) throw badRequest('invalid_platform');
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 128) : req.auth!.deviceId;

    // Один токен принадлежит одному пользователю/устройству — переносим его.
    await query(
      `INSERT INTO push_tokens (user_id, platform, token, device_id, hide_content)
       VALUES ($1, $2, $3, $4, COALESCE((SELECT notify_hide_content FROM users WHERE id = $1), false))
       ON CONFLICT (token) DO UPDATE
          SET user_id = EXCLUDED.user_id,
              platform = EXCLUDED.platform,
              device_id = EXCLUDED.device_id,
              hide_content = COALESCE((SELECT notify_hide_content FROM users WHERE id = EXCLUDED.user_id), push_tokens.hide_content),
              enabled = true,
              last_seen_at = now()`,
      [me, body.platform, token, deviceId ?? null],
    );
    return reply.send({ ok: true });
  });

  /** Скрывать ли отправителя и текст в push (применяется ко всем токенам). */
  app.post('/push/preferences', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const body = (req.body ?? {}) as { hideContent?: unknown };
    if (typeof body.hideContent !== 'boolean') throw badRequest('invalid_hide_content');
    await query('UPDATE users SET notify_hide_content = $2 WHERE id = $1', [me, body.hideContent]);
    await query('UPDATE push_tokens SET hide_content = $2 WHERE user_id = $1', [me, body.hideContent]);
    return reply.send({ ok: true, hideContent: body.hideContent });
  });

  app.delete('/push/token', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const body = (req.body ?? {}) as { token?: unknown };
    const token = str(body.token, 'token', { max: 4096 });
    await query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [token, me]);
    return reply.send({ ok: true });
  });

  /* ---------------------------------------------------------- история ----- */
  app.get('/notifications', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const q = req.query as { limit?: string; before?: string };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);
    const params: unknown[] = [me, limit];
    let cond = '';
    if (q.before && UUID_RE.test(q.before)) {
      // keyset-пагинация по created_at/id через подзапрос к опорной записи.
      cond = ' AND created_at < COALESCE((SELECT created_at FROM push_notifications WHERE id = $3), now())';
      params.push(q.before);
    }
    const rows = await query<NotificationDbRow>(
      `SELECT id, kind, title, body, data, status, attempts, last_error, created_at, sent_at, delivered_at
         FROM push_notifications
        WHERE user_id = $1${cond}
        ORDER BY created_at DESC
        LIMIT $2`,
      params,
    );
    return reply.send(rows.map(toApi));
  });

  /**
   * Background-fallback: недоставленные или не подтверждённые уведомления.
   * Отдаём только pending/failed без delivered_at, чтобы не спамить повторами.
   * platform/deviceId принимаются для совместимости с клиентом и логики
   * выбора устройства; уведомления хранятся на уровне пользователя.
   */
  app.get('/notifications/pending', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const q = req.query as { platform?: string; deviceId?: string; limit?: string };
    if (q.platform !== undefined && !isKnownPlatform(q.platform)) throw badRequest('invalid_platform');
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);

    const rows = await query<NotificationDbRow>(
      `SELECT id, kind, title, body, data, status, attempts, last_error, created_at, sent_at, delivered_at
         FROM push_notifications
        WHERE user_id = $1
          AND status IN ('pending', 'failed')
          AND delivered_at IS NULL
        ORDER BY created_at ASC
        LIMIT $2`,
      [me, limit],
    );
    return reply.send(rows.map(toApi));
  });

  app.post('/notifications/:id/delivered', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw notFound('notification');

    const row = await query<{ id: string }>(
      `UPDATE push_notifications
          SET status = 'delivered', delivered_at = now()
        WHERE id = $1 AND user_id = $2
        RETURNING id`,
      [id, me],
    );
    if (!row.length) throw notFound('notification');
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------ системные (admin) ----- */
  app.post('/push/system', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      userId?: unknown;
      title?: unknown;
      body?: unknown;
      data?: unknown;
    };
    const title = str(body.title, 'title', { max: 200 });
    const text = str(body.body, 'body', { max: 2000 });
    const userId = typeof body.userId === 'string' && body.userId ? body.userId : null;
    if (userId && !UUID_RE.test(userId)) throw badRequest('invalid_user_id');
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : {};

    const count = await sendSystemNotification(userId, title, text, data);
    return reply.send({ ok: true, queued: count });
  });

  /* ------------------------------- внутренняя постановка (для админа) ----- */
  // Позволяет вручную поставить уведомление конкретному пользователю и
  // проверить retry/историю, не дожидаясь сообщения в чате.
  app.post('/push/enqueue', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      userId?: unknown;
      kind?: unknown;
      title?: unknown;
      body?: unknown;
      data?: unknown;
    };
    if (typeof body.userId !== 'string' || !UUID_RE.test(body.userId)) throw badRequest('invalid_user_id');
    const id = await enqueueNotification(body.userId, {
      kind: str(body.kind ?? 'system', 'kind', { max: 32 }),
      title: str(body.title, 'title', { max: 200 }),
      body: str(body.body, 'body', { max: 2000 }),
      data: body.data && typeof body.data === 'object' && !Array.isArray(body.data)
        ? (body.data as Record<string, unknown>)
        : {},
    });
    return reply.send({ ok: true, id });
  });
};

export default notificationRoutes;
