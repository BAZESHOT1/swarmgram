/**
 * Сообщения. Хранение — ТОЛЬКО на узлах: Hub не видит шифротекст.
 * Клиент кладёт конверт (AES-GCM) прямо на 3 реплики (init/commit),
 * затем регистрирует метаданные здесь: object_id + nonce + header.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { uuid } from '../crypto.js';
import { one, query } from '../db.js';
import { publish, publishMany } from '../realtime.js';
import { enqueueNotification } from '../push.js';
import { badRequest, forbidden, notFound, rateLimit, str } from '../util.js';
import { can } from './chats.js';

const MAX_NONCE_B64 = 64;

const messageRoutes: FastifyPluginAsync = async (app) => {
  /* --------------------------------------------------------- отправка ---- */
  app.post('/chats/:id/messages', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id: chatId } = req.params as { id: string };
    const me = req.auth!.userId;
    const deviceId = req.auth!.deviceId;
    rateLimit(`msg:${me}`, 120, 60_000);

    const membership = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
    if (!membership) throw forbidden('not_a_member');

    const chat = await one<{ type: string; title: string; owner_id: string | null; blocked_reason: string | null }>(
      'SELECT type, title, owner_id, blocked_reason FROM chats WHERE id = $1',
      [chatId],
    );
    if (!chat) throw notFound('chat');
    if (chat.blocked_reason) throw forbidden('chat_blocked');
    // Бан в чате блокирует и отправку сообщений.
    if (await banActive(chatId, me)) throw forbidden('banned');
    if (chat.type === 'direct') {
      // Блокировка пользователя: ни одна сторона не может писать в личный чат.
      const peer = await one<{ user_id: string }>(
        'SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2 LIMIT 1',
        [chatId, me],
      );
      if (peer) {
        const blocked = await one(
          `SELECT 1 FROM user_blocks
            WHERE (blocker_id = $1 AND blocked_id = $2)
               OR (blocker_id = $2 AND blocked_id = $1)
            LIMIT 1`,
          [me, peer.user_id],
        );
        if (blocked) throw forbidden('user_blocked');
      }
    }
    if (chat.type === 'channel' && chat.owner_id !== me) {
      // в канале публикуют владелец/админ или роль с правом publish
      const role = await one<{ role: string }>('SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
      if (!role) throw forbidden('not_a_member');
      if (role.role !== 'admin' && role.role !== 'owner' && !(await can(chatId, me, 'publish'))) {
        throw forbidden('not_admin');
      }
    }

    const body = (req.body ?? {}) as {
      objectId?: string;
      nonce?: string;
      header?: unknown;
      kind?: string;
      replyTo?: string;
      clientId?: string;
      /** Опубликовать от имени канала (только канал + право publish). */
      asChannel?: boolean;
    };

    // Публикация от имени канала: только в каналах и только при праве publish.
    const asChannel = body.asChannel === true;
    if (asChannel) {
      if (chat.type !== 'channel') throw forbidden('as_channel_not_allowed');
      if (!(await can(chatId, me, 'publish'))) throw forbidden('no_publish_permission');
    }

    const objectId = String(body.objectId ?? '');
    const nonce = String(body.nonce ?? '');
    if (!/^[0-9a-fA-F-]{36}$/.test(objectId)) throw badRequest('object_required');
    if (!nonce.length || nonce.length > MAX_NONCE_B64) throw badRequest('invalid_nonce');

    const obj = await one<{ id: string; owner_id: string; size_bytes: number }>(
      'SELECT id, owner_id, size_bytes FROM objects WHERE id = $1 AND state = $2',
      [objectId, 'active'],
    );
    if (!obj || obj.owner_id !== me) throw notFound('object');
    if (obj.size_bytes > config.maxUploadBytes) throw badRequest('object_too_large');

    const kind = str(body.kind ?? 'text', 'kind', { max: 24 });

    // nonce всегда сохраняем в header: история читает его оттуда
    // (в realtime он приходит отдельным полем, но при чтении истории нужен в header).
    const headerObj: Record<string, unknown> = body.header && typeof body.header === 'object' && !Array.isArray(body.header)
      ? { ...(body.header as Record<string, unknown>) }
      : {};
    if (typeof headerObj.nonce !== 'string' || !headerObj.nonce) headerObj.nonce = nonce;

    // всем участникам чата — право читать объект с узлов
    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
    for (const m of members) {
      await query('INSERT INTO object_grants (object_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
        objectId,
        m.user_id,
      ]);
    }

    const id = uuid();
    const user = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [me]);
    // идемпотентность: доставка того же клиентского сообщения через mesh + интернет не дублируется
    if (body.clientId) {
      const found = await one<{ id: string; seq: number; created_at: string; header: unknown; object_id: string | null; reply_to: string | null; as_channel: boolean }>(
        'SELECT id, seq, created_at, header, object_id, reply_to, as_channel FROM messages WHERE chat_id = $1 AND client_id = $2',
        [chatId, body.clientId],
      );
      if (found) {
        const meta = headerMeta(found.header);
        return reply.code(200).send({
          id: found.id,
          seq: found.seq,
          chatId,
          kind,
          ciphertext: '',
          nonce: extractNonce(found.header),
          header: found.header,
          objectId: found.object_id,
          replyTo: found.reply_to,
          asChannel: found.as_channel,
          scheme: meta.scheme,
          keyVersion: meta.keyVersion,
          edited: meta.edited,
          senderUserId: me,
          senderUsername: user?.username ?? '',
          senderDeviceId: deviceId,
          createdAt: found.created_at,
          clientId: body.clientId,
        });
      }
    }
    const row = await one<{ seq: number; created_at: string }>(
      `INSERT INTO messages (id, chat_id, sender_user_id, sender_device_id, kind, header, object_id, reply_to, client_id, as_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NULLIF($9,''), $10) RETURNING seq, created_at`,
      [id, chatId, me, deviceId, kind, JSON.stringify(headerObj), objectId, body.replyTo ?? null, body.clientId ?? null, asChannel],
    );

    await query('UPDATE chats SET last_seq = GREATEST(last_seq, $2), updated_at = now() WHERE id = $1', [chatId, row!.seq]);

    const envelope = {
      type: 'message',
      chatId,
      message: {
        id,
        seq: row!.seq,
        chatId,
        kind,
        objectId,
        nonce,
        header: headerObj,
        replyTo: body.replyTo ?? null,
        asChannel,
        senderUserId: me,
        senderUsername: user?.username ?? '',
        senderDeviceId: deviceId,
        createdAt: row!.created_at,
        clientId: body.clientId ?? null,
      },
    };
    for (const m of members) publish(m.user_id, envelope);

    // Push получателям — best-effort и без ожидания: отправка сообщения не
    // должна зависеть от FCM. Текст уведомления не содержит содержимого.
    void notifyMessageRecipients({
      chatId,
      chatTitle: chat.title,
      messageId: id,
      kind,
      senderId: me,
      senderUsername: user?.username ?? '',
      members: members.map((m) => m.user_id),
    }).catch(() => undefined);

    return reply.code(201).send(envelope.message);
  });

  /* ------------------------------------------------------------ история -- */
  app.get('/chats/:id/messages', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id: chatId } = req.params as { id: string };
    const me = req.auth!.userId;
    const membership = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
    if (!membership) throw forbidden('not_a_member');
    const chat = await one<{ type: string }>('SELECT type FROM chats WHERE id = $1', [chatId]);
    const isChannel = chat?.type === 'channel';
    const q = req.query as { before?: string; after?: string; limit?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 100);
    const before = Number(q.before);
    const after = Number(q.after);

    const params: unknown[] = [chatId, limit];
    let cond = '';
    if (Number.isFinite(before) && before > 0) {
      cond = ' AND m.seq < $3';
      params.push(before);
    } else if (Number.isFinite(after) && after > 0) {
      cond = ' AND m.seq > $3';
      params.push(after);
    }

    const rows = await query<MsgRow>(
      `SELECT m.id, m.seq, m.kind, m.header, m.object_id, o.size_bytes, m.reply_to, m.created_at,
              m.as_channel, m.sender_user_id, u.username AS sender_username, m.sender_device_id
         FROM messages m
         JOIN users u ON u.id = m.sender_user_id
         LEFT JOIN objects o ON o.id = m.object_id
        WHERE m.chat_id = $1${cond}
        ORDER BY m.seq DESC LIMIT $2`,
      params,
    );

    // агрегированные реакции одним запросом (emoji + число + моя ли реакция)
    const reactionsByMsg = new Map<string, { emoji: string; count: number; mine: boolean }[]>();
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const reactionRows = await query<{ message_id: string; emoji: string; count: number; mine: boolean }>(
        `SELECT message_id, emoji, count(*)::int AS count,
                bool_or(user_id = $2) AS mine
           FROM message_reactions
          WHERE message_id = ANY($1::uuid[])
          GROUP BY message_id, emoji
          ORDER BY emoji`,
        [ids, me],
      );
      for (const r of reactionRows) {
        const list = reactionsByMsg.get(r.message_id) ?? [];
        list.push({ emoji: r.emoji, count: r.count, mine: r.mine });
        reactionsByMsg.set(r.message_id, list);
      }
    }

    // просмотры считаем для всех типов чатов; UI сам решает, показывать ли их
    const viewsByMsg = new Map<string, number>();
    if (rows.length) {
      const viewRows = await query<{ message_id: string; count: number }>(
        `SELECT message_id, count(*)::int AS count
           FROM message_views WHERE message_id = ANY($1::uuid[])
          GROUP BY message_id`,
        [rows.map((r) => r.id)],
      );
      for (const v of viewRows) viewsByMsg.set(v.message_id, v.count);
    }

    // число комментариев под постами — только для каналов
    const commentsByMsg = new Map<string, number>();
    if (isChannel && rows.length) {
      const commentRows = await query<{ message_id: string; count: number }>(
        `SELECT message_id, count(*)::int AS count
           FROM post_comments WHERE message_id = ANY($1::uuid[])
          GROUP BY message_id`,
        [rows.map((r) => r.id)],
      );
      for (const c of commentRows) commentsByMsg.set(c.message_id, c.count);
    }

    return reply.send(
      rows.reverse().map((r) => {
        const meta = headerMeta(r.header);
        return {
          id: r.id,
          seq: r.seq,
          chatId,
          kind: r.kind,
          objectId: r.object_id,
          sizeBytes: r.size_bytes,
          nonce: extractNonce(r.header),
          header: r.header,
          replyTo: r.reply_to,
          asChannel: r.as_channel,
          viewsCount: viewsByMsg.get(r.id) ?? 0,
          scheme: meta.scheme,
          keyVersion: meta.keyVersion,
          edited: meta.edited,
          reactions: reactionsByMsg.get(r.id) ?? [],
          ...(isChannel ? { commentsCount: commentsByMsg.get(r.id) ?? 0 } : {}),
          createdAt: r.created_at,
          senderUserId: r.sender_user_id,
          senderUsername: r.sender_username,
          senderDeviceId: r.sender_device_id,
        };
      }),
    );
  });

  /* ------------------------------------------------------------ просмотр - */
  // Отметка «я посмотрел сообщение». Повторный вызов безопасен (PK + DO NOTHING).
  app.post('/chats/:id/messages/:messageId/view', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const me = req.auth!.userId;
    // uuid может быть невалидным — иначе Postgres вернёт ошибку 22P02 (500).
    if (!/^[0-9a-fA-F-]{36}$/.test(messageId)) throw notFound('message');

    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
    if (!member) throw forbidden('not_a_member');
    const msg = await one('SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
    if (!msg) throw notFound('message');

    await query(
      `INSERT INTO message_views (message_id, user_id) VALUES ($1,$2)
       ON CONFLICT (message_id, user_id) DO NOTHING`,
      [messageId, me],
    );
    const row = await one<{ views: number }>(
      'SELECT count(*)::int AS views FROM message_views WHERE message_id = $1',
      [messageId],
    );
    return reply.send({ ok: true, views: Number(row?.views ?? 0) });
  });

  /* ------------------------------------------------------- редактирование - */
  app.patch('/chats/:id/messages/:messageId', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const me = req.auth!.userId;
    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
    if (!member) throw forbidden('not_a_member');

    const msg = await one<{ sender_user_id: string; header: unknown }>(
      'SELECT sender_user_id, header FROM messages WHERE id = $1 AND chat_id = $2',
      [messageId, chatId],
    );
    if (!msg) throw notFound('message');
    if (msg.sender_user_id !== me) throw forbidden('not_your_message');

    const body = (req.body ?? {}) as { objectId?: string; nonce?: string; header?: unknown };
    const objectId = String(body.objectId ?? '');
    const nonce = String(body.nonce ?? '');
    if (!/^[0-9a-fA-F-]{36}$/.test(objectId)) throw badRequest('object_required');
    if (!nonce.length || nonce.length > MAX_NONCE_B64) throw badRequest('invalid_nonce');

    // менять можно только собственный активный объект
    const obj = await one<{ id: string; owner_id: string }>(
      'SELECT id, owner_id FROM objects WHERE id = $1 AND state = $2',
      [objectId, 'active'],
    );
    if (!obj || obj.owner_id !== me) throw notFound('object');

    const oldHeader = msg.header && typeof msg.header === 'object' && !Array.isArray(msg.header)
      ? (msg.header as Record<string, unknown>)
      : {};
    const extraHeader = body.header && typeof body.header === 'object' && !Array.isArray(body.header)
      ? (body.header as Record<string, unknown>)
      : {};
    const headerObj: Record<string, unknown> = { ...oldHeader, ...extraHeader, nonce, edited: true };

    // доступ участников к новому объекту
    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
    for (const m of members) {
      await query('INSERT INTO object_grants (object_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
        objectId,
        m.user_id,
      ]);
    }

    await query('UPDATE messages SET object_id = $2, header = $3 WHERE id = $1', [
      messageId,
      objectId,
      JSON.stringify(headerObj),
    ]);
    publishMany(members.map((m) => m.user_id), { type: 'message_edited', chatId, messageId });
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------------------ реакции -- */
  app.put('/chats/:id/messages/:messageId/reactions', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const me = req.auth!.userId;
    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
    if (!member) throw forbidden('not_a_member');

    const msg = await one('SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
    if (!msg) throw notFound('message');

    const body = (req.body ?? {}) as { emoji?: string };
    const emoji = typeof body.emoji === 'string' ? body.emoji : '';
    if (!emoji.length || emoji.length > 8) throw badRequest('invalid_emoji');

    // toggle: была реакция — убираем, иначе ставим
    const removed = await one(
      'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING 1 AS ok',
      [messageId, me, emoji],
    );
    if (!removed) {
      await query(
        `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
        [messageId, me, emoji],
      );
    }

    const reactions = await query<{ emoji: string; count: number; mine: boolean }>(
      `SELECT emoji, count(*)::int AS count, bool_or(user_id = $2) AS mine
         FROM message_reactions WHERE message_id = $1
        GROUP BY emoji ORDER BY emoji`,
      [messageId, me],
    );
    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
    publishMany(members.map((m) => m.user_id), { type: 'message_reaction', chatId, messageId });
    return reply.send(reactions);
  });

  /* ------------------------------------------------------- доставка ------ */
  app.post('/chats/:chatId/messages/:messageId/receipt', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { chatId, messageId } = req.params as { chatId: string; messageId: string };
    const me = req.auth!.userId;
    const deviceId = req.auth!.deviceId;

    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
    if (!member) throw forbidden('not_a_member');
    const msg = await one<{ sender_user_id: string }>('SELECT sender_user_id FROM messages WHERE id = $1 AND chat_id = $2', [
      messageId,
      chatId,
    ]);
    if (!msg) throw notFound('message');
    if (msg.sender_user_id === me) return reply.send({ ok: true });

    await query(
      `INSERT INTO message_receipts (message_id, user_id, device_id) VALUES ($1,$2,$3)
       ON CONFLICT (message_id, user_id, device_id) DO NOTHING`,
      [messageId, me, deviceId],
    );
    publish(msg.sender_user_id, { type: 'message_delivered', chatId, messageId, userId: me });
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------------------ удаление - */
  app.delete('/chats/:id/messages/:messageId', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const msg = await one<{ sender_user_id: string; object_id: string | null }>(
      'SELECT sender_user_id, object_id FROM messages WHERE id = $1 AND chat_id = $2',
      [messageId, chatId],
    );
    if (!msg) throw notFound('message');
    if (msg.sender_user_id !== req.auth!.userId) throw forbidden('not_your_message');

    await query('DELETE FROM messages WHERE id = $1', [messageId]);
    if (msg.object_id) {
      // объект помечается удалённым; очистка реплик на узлах делает монитор
      await query("UPDATE objects SET state = 'deleted' WHERE id = $1", [msg.object_id]);
    }
    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
    for (const m of members) {
      publish(m.user_id, { type: 'message_deleted', chatId, messageId });
    }
    return reply.send({ ok: true });
  });
};

interface NotifyRecipientsInput {
  chatId: string;
  chatTitle: string;
  messageId: string;
  kind: string;
  senderId: string;
  senderUsername: string;
  members: string[];
}

/**
 * Ставит push-уведомления получателям сообщения. Приватный текст и содержимое
 * не передаются — только факт нового сообщения и метаданные чата.
 */
async function notifyMessageRecipients(input: NotifyRecipientsInput): Promise<void> {
  const recipients = input.members.filter((id) => id !== input.senderId);
  if (!recipients.length) return;

  const users = await query<{ id: string; status: string; muted_chats: unknown }>(
    'SELECT id, status, muted_chats FROM users WHERE id = ANY($1::uuid[])',
    [recipients],
  );

  const title = (input.chatTitle
    ? `@${input.senderUsername || 'user'} в ${input.chatTitle}`
    : 'Новое сообщение').slice(0, 200);
  const body = input.kind === 'media' ? 'Медиа' : 'Новое сообщение';

  for (const user of users) {
    // Заблокированные/удалённые аккаунты уведомления не получают.
    if (user.status !== 'active') continue;
    const muted = Array.isArray(user.muted_chats) ? (user.muted_chats as unknown[]) : [];
    if (muted.includes(input.chatId)) continue;

    await enqueueNotification(user.id, {
      kind: 'message',
      title,
      body,
      data: { chatId: input.chatId, messageId: input.messageId, kind: input.kind },
    });
  }
}

function extractNonce(header: unknown): string {
  if (header && typeof header === 'object' && typeof (header as any).nonce === 'string') return (header as any).nonce;
  return '';
}

/** Активная блокировка пользователя в чате. */
async function banActive(chatId: string, userId: string): Promise<boolean> {
  const row = await one(
    'SELECT 1 FROM chat_bans WHERE chat_id = $1 AND user_id = $2 AND (until IS NULL OR until > now())',
    [chatId, userId],
  );
  return Boolean(row);
}

/** Метаданные конверта, которые клиент читает при истории/дедупликации. */
function headerMeta(header: unknown): { scheme: 'server' | 'e2e'; keyVersion: number | null; edited: boolean } {
  const h = header && typeof header === 'object' ? (header as Record<string, unknown>) : {};
  const scheme = h.scheme === 'server' ? 'server' : 'e2e';
  const keyVersion = typeof h.keyVersion === 'number' ? h.keyVersion : Number.isFinite(Number(h.keyVersion)) && h.keyVersion !== undefined
    ? Number(h.keyVersion)
    : null;
  return { scheme, keyVersion, edited: h.edited === true };
}

interface MsgRow {
  id: string;
  seq: number;
  kind: string;
  header: unknown;
  object_id: string | null;
  size_bytes: number | null;
  reply_to: string | null;
  created_at: string;
  as_channel: boolean;
  sender_user_id: string;
  sender_username: string;
  sender_device_id: string;
}

export default messageRoutes;
