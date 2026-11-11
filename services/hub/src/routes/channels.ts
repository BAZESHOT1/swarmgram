/** Новостные каналы и группы: каталог, подписки, комментарии под постами. */
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { uuid } from '../crypto.js';
import { one, query, tx } from '../db.js';
import { publish, publishMany } from '../realtime.js';
import { badRequest, forbidden, notFound, str } from '../util.js';
import { audit, can, chatInfo, createJoinRequest } from './chats.js';

const MAX_NONCE_B64 = 64;

const channelRoutes: FastifyPluginAsync = async (app) => {
  /* ----------------------------------------------------- группы: поиск ---- */
  app.get('/groups', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const q = String((req.query as { search?: string }).search ?? '').trim();
    const params: unknown[] = [];
    let where = `c.type = 'group' AND c.visibility IN ('public','closed') AND c.blocked_reason IS NULL`;
    if (q.length >= 2) {
      params.push(`%${q.toLowerCase()}%`);
      where += ` AND lower(c.title) LIKE $${params.length}`;
    }
    params.push(me);
    const rows = await query<{
      id: string;
      title: string;
      description: string;
      visibility: string;
      members_count: number;
      joined: boolean;
    }>(
      `SELECT c.id, c.title, c.description, c.visibility,
              (SELECT count(*)::int FROM chat_members mm WHERE mm.chat_id = c.id) AS members_count,
              EXISTS (SELECT 1 FROM chat_members j WHERE j.chat_id = c.id AND j.user_id = $${params.length})::bool AS joined
         FROM chats c
        WHERE ${where}
        ORDER BY members_count DESC, c.updated_at DESC
        LIMIT 30`,
      params,
    );
    return reply.send(
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        visibility: r.visibility === 'closed' ? 'closed' : 'public',
        membersCount: r.members_count,
        joined: r.joined,
      })),
    );
  });

  /* ------------------------------------------------- каталог публичных ---- */
  app.get('/channels', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const q = String((req.query as { search?: string }).search ?? '').trim();
    const params: unknown[] = [];
    // Публичные и закрытые каналы видны в каталоге; частные — только по ссылке.
    let where = `c.type = 'channel' AND c.visibility IN ('public','closed') AND c.blocked_reason IS NULL`;
    if (q.length >= 2) {
      params.push(`%${q.toLowerCase()}%`);
      where += ` AND (lower(c.title) LIKE $${params.length})`;
    }
    const rows = await query<{
      id: string;
      title: string;
      description: string;
      visibility: string;
      is_public: boolean;
      owner_username: string;
      subscribers: number;
      subscribed: boolean;
      posts: number;
      last_post: string | null;
    }>(
      `SELECT c.id, c.title, c.description, c.visibility, c.is_public, u.username AS owner_username,
              COUNT(DISTINCT cm.user_id)::int AS subscribers,
              EXISTS (SELECT 1 FROM chat_members mm WHERE mm.chat_id = c.id AND mm.user_id = $${params.length + 1})::bool AS subscribed,
              (SELECT COUNT(*)::int FROM messages m WHERE m.chat_id = c.id) AS posts,
              (SELECT m2.created_at FROM messages m2 WHERE m2.chat_id = c.id ORDER BY m2.seq DESC LIMIT 1) AS last_post
         FROM chats c
         LEFT JOIN users u ON u.id = c.owner_id
         LEFT JOIN chat_members cm ON cm.chat_id = c.id
        WHERE ${where}
        GROUP BY c.id, c.title, c.description, c.visibility, c.is_public, u.username
        ORDER BY posts DESC LIMIT 100`,
      [...params, me],
    );
    return reply.send(rows);
  });

  /** Мои подписки. */
  app.get('/channels/subscriptions', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const rows = await query<{ chat_id: string }>(
      `SELECT cm.chat_id FROM chat_members cm
         JOIN chats c ON c.id = cm.chat_id
        WHERE cm.user_id = $1 AND c.type = 'channel'`,
      [me],
    );
    const out = [];
    for (const r of rows) out.push(await chatInfo(r.chat_id, me));
    return reply.send(out);
  });

  /* ------------------------------------------------------ создание канала - */
  app.post('/channels', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const body = (req.body ?? {}) as { title?: string };
    const title = str(body.title, 'title', { max: 64 });
    const rate = await one<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM chats WHERE type = 'channel' AND owner_id = $1`,
      [me],
    );
    if ((rate?.c ?? 0) >= 10) throw badRequest('channel_limit_reached');

    const chatId = uuid();
    await tx(async ({ query: q }) => {
      await q(`INSERT INTO chats (id, type, title, owner_id, is_public) VALUES ($1,'channel',$2,$3,true)`, [
        chatId,
        title,
        me,
      ]);
      await q('INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1,$2,$3)', [chatId, me, 'owner']);
    });
    publish(me, { type: 'chat_added', chatId });
    return reply.code(201).send(await chatInfo(chatId, me));
  });

  /* ------------------------------------------------------------ подписка -- */
  app.post('/channels/:id/subscribe', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const chat = await one<{ id: string; is_public: boolean; visibility: string; type: string }>(
      'SELECT id, is_public, visibility, type FROM chats WHERE id = $1 AND type = $2',
      [id, 'channel'],
    );
    if (!chat) throw notFound('channel');
    // Частный канал: вход только по ссылке или прямому приглашению.
    if (chat.visibility === 'private') throw forbidden('invite_required');

    const banned = await one(
      'SELECT 1 FROM chat_bans WHERE chat_id = $1 AND user_id = $2 AND (until IS NULL OR until > now())',
      [id, me],
    );
    if (banned) throw forbidden('banned');

    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, me]);
    if (member) return reply.send(await chatInfo(id, me));

    // Закрытый канал: подписка через заявку.
    if (chat.visibility === 'closed') {
      await createJoinRequest(id, me, 'member');
      return reply.send({ status: 'requested', chatId: id });
    }

    await tx(async ({ query: q }) => {
      await q('INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, me]);
    });
    publish(me, { type: 'chat_added', chatId: id });
    return reply.send(await chatInfo(id, me));
  });

  app.delete('/channels/:id/subscribe', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const owner = await one<{ owner_id: string }>('SELECT owner_id FROM chats WHERE id = $1 AND type = $2', [id, 'channel']);
    if (owner && owner.owner_id === me) throw forbidden('owner_cannot_unsubscribe');
    await tx(async ({ query: q }) => {
      await q('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [id, me]);
    });
    return reply.send({ ok: true });
  });

  /* ------------------------------------------------ комментарии к постам -- */

  /** Список комментариев под постом канала (только участники). */
  app.get('/chats/:id/posts/:messageId/comments', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const me = req.auth!.userId;
    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
    if (!member) throw forbidden('not_a_member');
    const post = await one('SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
    if (!post) throw notFound('message');

    const canModerate =
      (await can(chatId, me, 'deleteMessages')) || (await can(chatId, me, 'manageBans'));

    const rows = await query<{
      id: string;
      user_id: string;
      username: string;
      created_at: string;
      object_id: string | null;
      header: unknown;
    }>(
      `SELECT pc.id, pc.user_id, u.username, pc.created_at, pc.object_id, pc.header
         FROM post_comments pc JOIN users u ON u.id = pc.user_id
        WHERE pc.chat_id = $1 AND pc.message_id = $2
        ORDER BY pc.created_at ASC LIMIT 500`,
      [chatId, messageId],
    );
    return reply.send(
      rows.map((r) => ({
        id: r.id,
        messageId,
        userId: r.user_id,
        username: r.username,
        createdAt: new Date(r.created_at).toISOString(),
        objectId: r.object_id,
        nonce: extractNonce(r.header),
        header: r.header,
        canDelete: canModerate || r.user_id === me,
      })),
    );
  });

  /** Оставить комментарий под постом канала. */
  app.post('/chats/:id/posts/:messageId/comments', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const me = req.auth!.userId;
    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
    if (!member) throw forbidden('not_a_member');

    const chat = await one<{ type: string }>('SELECT type FROM chats WHERE id = $1', [chatId]);
    if (!chat) throw notFound('chat');
    if (chat.type !== 'channel') throw badRequest('comments_only_for_channels');
    const post = await one('SELECT 1 FROM messages WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
    if (!post) throw notFound('message');

    const banned = await one(
      'SELECT 1 FROM chat_bans WHERE chat_id = $1 AND user_id = $2 AND (until IS NULL OR until > now())',
      [chatId, me],
    );
    if (banned) throw forbidden('banned');

    const body = (req.body ?? {}) as { objectId?: unknown; nonce?: unknown; header?: unknown };
    const objectId = String(body.objectId ?? '');
    const nonce = String(body.nonce ?? '');
    if (!/^[0-9a-fA-F-]{36}$/.test(objectId)) throw badRequest('object_required');
    if (!nonce.length || nonce.length > MAX_NONCE_B64) throw badRequest('invalid_nonce');

    const obj = await one<{ id: string; owner_id: string }>(
      'SELECT id, owner_id FROM objects WHERE id = $1 AND state = $2',
      [objectId, 'active'],
    );
    if (!obj || obj.owner_id !== me) throw notFound('object');

    const headerObj: Record<string, unknown> =
      body.header && typeof body.header === 'object' && !Array.isArray(body.header)
        ? { ...(body.header as Record<string, unknown>) }
        : {};
    if (typeof headerObj.nonce !== 'string' || !headerObj.nonce) headerObj.nonce = nonce;

    // всем участникам канала — право читать объект комментария с узлов
    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
    for (const m of members) {
      await query('INSERT INTO object_grants (object_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
        objectId,
        m.user_id,
      ]);
    }

    const commentId = uuid();
    const row = await one<{ created_at: string }>(
      `INSERT INTO post_comments (id, chat_id, message_id, user_id, object_id, header)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING created_at`,
      [commentId, chatId, messageId, me, objectId, JSON.stringify(headerObj)],
    );
    publishMany(members.map((m) => m.user_id), {
      type: 'comment_added',
      chatId,
      messageId,
      commentId,
      userId: me,
    });
    return reply.code(201).send({
      id: commentId,
      messageId,
      userId: me,
      username: (await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [me]))?.username ?? '',
      createdAt: new Date(row!.created_at).toISOString(),
      objectId,
      nonce,
      header: headerObj,
      canDelete: true,
    });
  });

  /** Удалить комментарий: автор либо модератор с правом удаления сообщений. */
  app.delete('/chats/:id/posts/:messageId/comments/:commentId', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id: chatId, messageId, commentId } = req.params as { id: string; messageId: string; commentId: string };
    const me = req.auth!.userId;
    const comment = await one<{ user_id: string }>(
      'SELECT user_id FROM post_comments WHERE id = $1 AND chat_id = $2 AND message_id = $3',
      [commentId, chatId, messageId],
    );
    if (!comment) throw notFound('comment');

    const allowed =
      comment.user_id === me ||
      (await can(chatId, me, 'deleteMessages')) ||
      (await can(chatId, me, 'manageBans'));
    if (!allowed) throw forbidden('no_permission');

    await query('DELETE FROM post_comments WHERE id = $1', [commentId]);
    await audit(chatId, me, 'comment_deleted', commentId, { messageId });
    publishMany(await membersOf(chatId), { type: 'comment_deleted', chatId, messageId, commentId });
    return reply.send({ ok: true });
  });
};

async function membersOf(chatId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  return rows.map((r) => r.user_id);
}

function extractNonce(header: unknown): string {
  if (header && typeof header === 'object' && typeof (header as Record<string, unknown>).nonce === 'string') {
    return (header as Record<string, string>).nonce;
  }
  return '';
}

export default channelRoutes;
