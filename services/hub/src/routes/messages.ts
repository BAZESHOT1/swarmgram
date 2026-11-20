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
import { getFragment } from '../nodes.js';
import { crc16 } from '../kmeshRpc.js';
import { queueEnvelopeDownlink } from '../kmeshDownlink.js';

const MAX_NONCE_B64 = 64;

/** KMesh: короткий текст дублируем в downlink-очередь получателей. */
async function mirrorToKmesh(input: {
  chatId: string;
  chatRef: number;
  kind: string;
  nonce: string;
  objectId: string;
  messageId: string;
  createdAt?: string;
  senderUserId: string;
  senderNodeId: number;
}): Promise<void> {
  if (input.kind !== 'text') return;
  const obj = await one<{ size_bytes: number }>(
    'SELECT size_bytes FROM objects WHERE id = $1 AND state = $2',
    [input.objectId, 'active'],
  );
  if (!obj || obj.size_bytes <= 0 || obj.size_bytes > 213) return;
  const frags = await query<{ index: number; id: string; node_id: string; public_url: string; ticket_secret: string }>(
    `SELECT f.index, n.id, f.node_id, n.public_url, n.ticket_secret
       FROM fragments f JOIN nodes n ON n.id = f.node_id
      WHERE f.object_id = $1 AND f.state = 'ok' AND n.status = 'online'
      ORDER BY n.reputation DESC`,
    [input.objectId],
  );
  for (const frag of frags) {
    try {
      const stream = await getFragment(frag, input.objectId, frag.index, input.senderUserId);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        total += buf.length;
        if (total > 213) return;
        chunks.push(buf);
      }
      const ciphertext = Buffer.concat(chunks);
      if (!ciphertext.length) return;
      await queueEnvelopeDownlink({
        chatId: input.chatId,
        chatRef: input.chatRef,
        kind: input.kind,
        nonceB64: input.nonce,
        ciphertextB64: ciphertext.toString('base64'),
        messageId: input.messageId,
        createdAt: input.createdAt,
        excludeUserId: input.senderUserId,
        srcNodeId: input.senderNodeId,
      });
      return;
    } catch {
      /* попробуем следующую реплику */
    }
  }
}

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
      /** Короткий текст для push (не хранится в истории; можно отключить настройкой). */
      pushText?: string;
    };

    // Канал: писать может только владелец/админ с правом publish, и всегда
    // от имени канала. В сообществе (группе) публикация от имени сообщества
    // остаётся переключаемой, в личном чате — запрещена.
    let asChannel = body.asChannel === true;
    if (chat.type === 'channel') {
      if (!(await can(chatId, me, 'publish'))) throw forbidden('no_publish_permission');
      asChannel = true;
    } else if (asChannel && chat.type !== 'group') {
      throw forbidden('as_channel_not_allowed');
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
    const user = await one<{ username: string; display_name: string }>(
      'SELECT username, display_name FROM users WHERE id = $1',
      [me],
    );
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

    // Мосты KMesh: получатели с активным модулем получат тот же конверт через
    // downlink, даже если приложение офлайн. Не блокируем ответ пользователю.
    void (async () => {
      try {
        const senderNode = await one<{ node_id: string }>(
          `SELECT node_id::text FROM kmesh_v1_presence
            WHERE user_id = $1 AND expires_at > now()
            ORDER BY last_seen_at DESC LIMIT 1`,
          [me],
        ) ?? await one<{ node_id: string }>(
          `SELECT node_id::text FROM kmesh_v1_node_bindings
            WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
          [me],
        );
        await mirrorToKmesh({
          chatId,
          chatRef: crc16(Buffer.from(chatId, 'utf8')) || 1,
          kind,
          nonce,
          objectId,
          messageId: id,
          createdAt: row!.created_at,
          senderUserId: me,
          senderNodeId: senderNode ? Number(senderNode.node_id) : 0,
        });
      } catch {
        /* KMesh — best-effort, HTTP-доставка уже выполнена */
      }
    })();

    // Push получателям — best-effort и без ожидания: отправка сообщения не
    // должна зависеть от FCM. Текст уведомления не содержит содержимого.
    void notifyMessageRecipients({
      chatId,
      chatType: chat.type,
      chatTitle: chat.title,
      messageId: id,
      kind,
      senderId: me,
      senderUsername: user?.username ?? '',
      senderDisplayName: user?.display_name ?? '',
      asChannel,
      pushText: typeof body.pushText === 'string' ? body.pushText.slice(0, 500) : '',
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
    const meParam = params.length + 1;
    params.push(me);

    const rows = await query<MsgRow>(
      `SELECT m.id, m.seq, m.kind, m.header, m.object_id, o.size_bytes, m.reply_to, m.created_at,
              m.as_channel, m.sender_user_id, u.username AS sender_username, m.sender_device_id, m.client_id,
              m.msg_uuid,
              EXISTS(SELECT 1 FROM message_receipts rc
                      WHERE rc.message_id = m.id AND rc.user_id <> m.sender_user_id) AS is_delivered,
              EXISTS(SELECT 1 FROM chat_members cmr
                      WHERE cmr.chat_id = m.chat_id AND cmr.user_id <> m.sender_user_id
                        AND cmr.last_read_seq >= m.seq) AS is_read
         FROM messages m
         JOIN users u ON u.id = m.sender_user_id
         LEFT JOIN objects o ON o.id = m.object_id
        WHERE m.chat_id = $1${cond}
          AND NOT EXISTS (SELECT 1 FROM message_hidden h
                           WHERE h.message_id = m.id AND h.user_id = $${meParam})
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

    // Mesh-клиент не может скачать object с узлов: для небольших текстовых
    // сообщений отдаём шифротекст inline.
    const inlineMap = new Map<string, string>();
    if (req.headers['x-sg-mesh'] === '1' && rows.length) {
      for (const r of rows.slice(0, 30)) {
        if (!r.object_id || !r.size_bytes || r.size_bytes > 4096) continue;
        try {
          const frag = await one<{ index: number; node_id: string; public_url: string; ticket_secret: string }>(
            `SELECT f.index, n.id AS node_id, n.public_url, n.ticket_secret
               FROM fragments f JOIN nodes n ON n.id = f.node_id
              WHERE f.object_id = $1 AND f.state = 'ok' AND n.status <> 'banned'
              ORDER BY (n.status = 'online') DESC, n.reputation DESC
              LIMIT 1`,
            [r.object_id],
          );
          if (!frag) continue;
          const stream = await getFragment(
            { id: frag.node_id, public_url: frag.public_url, ticket_secret: frag.ticket_secret },
            r.object_id,
            frag.index,
            me,
          );
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of stream) {
            const buf = chunk as Buffer;
            total += buf.length;
            if (total > 4096) break;
            chunks.push(buf);
          }
          if (total > 0 && total <= 4096) {
            inlineMap.set(r.id, Buffer.concat(chunks).toString('base64url'));
          }
        } catch {
          /* клиент попробует object позже */
        }
      }
    }

    return reply.send(
      rows.reverse().map((r) => {
        const meta = headerMeta(r.header);
        return {
          id: r.id,
          seq: r.seq,
          chatId,
          kind: r.kind,
          // У системных сообщений нет объекта на узлах — ключ не отдаём.
          ...(r.kind === 'system' ? {} : { objectId: r.object_id }),
          ...(inlineMap.has(r.id) ? { envelopeB64: inlineMap.get(r.id) } : {}),
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
          clientId: r.client_id ?? extractClientId(r.header),
          ...(r.msg_uuid ? { msgUuid: r.msg_uuid } : {}),
          delivered: Boolean(r.is_delivered),
          read: Boolean(r.is_read),
        };
      }),
    );
  });

  /* ------------------------------------------- одно сообщение (превью) ----- */
  app.get('/chats/:id/messages/:messageId', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id: chatId, messageId } = req.params as { id: string; messageId: string };
    const me = req.auth!.userId;
    if (!/^[0-9a-fA-F-]{36}$/.test(messageId)) throw notFound('message');
    const membership = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
    if (!membership) throw forbidden('not_a_member');
    const r = await one<MsgRow>(
      `SELECT m.id, m.seq, m.kind, m.header, m.object_id, o.size_bytes, m.reply_to, m.created_at,
              m.as_channel, m.sender_user_id, u.username AS sender_username, m.sender_device_id, m.client_id
         FROM messages m
         JOIN users u ON u.id = m.sender_user_id
         LEFT JOIN objects o ON o.id = m.object_id
        WHERE m.chat_id = $1 AND m.id = $2`,
      [chatId, messageId],
    );
    if (!r) throw notFound('message');
    const meta = headerMeta(r.header);
    return reply.send({
      id: r.id,
      seq: r.seq,
      chatId,
      kind: r.kind,
      // У системных сообщений нет объекта на узлах — ключ не отдаём.
      ...(r.kind === 'system' ? {} : { objectId: r.object_id }),
      sizeBytes: r.size_bytes,
      nonce: extractNonce(r.header),
      header: r.header,
      replyTo: r.reply_to,
      asChannel: r.as_channel,
      scheme: meta.scheme,
      keyVersion: meta.keyVersion,
      edited: meta.edited,
      reactions: [],
      createdAt: r.created_at,
      senderUserId: r.sender_user_id,
      senderUsername: r.sender_username,
      senderDeviceId: r.sender_device_id,
      clientId: r.client_id ?? extractClientId(r.header),
    });
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
    const me = req.auth!.userId;
    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, me]);
    if (!member) throw forbidden('not_a_member');
    const msg = await one<{ sender_user_id: string; object_id: string | null; kind: string }>(
      'SELECT sender_user_id, object_id, kind FROM messages WHERE id = $1 AND chat_id = $2',
      [messageId, chatId],
    );
    if (!msg) throw notFound('message');
    const chat = await one<{ type: string }>('SELECT type FROM chats WHERE id = $1', [chatId]);
    // В каналах удаление всегда «для всех»; остальное — по запросу.
    let scope = String((req.query as { scope?: string }).scope ?? 'all') === 'me' ? 'me' : 'all';
    if (chat?.type === 'channel') scope = 'all';

    if (scope === 'me') {
      await query(
        `INSERT INTO message_hidden (message_id, user_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [messageId, me],
      );
      // Другие устройства этого же пользователя тоже скрывают сообщение.
      publish(me, { type: 'message_deleted', chatId, messageId, scope: 'me' });
      return reply.send({ ok: true, scope: 'me' });
    }

    const canDeleteAny = await can(chatId, me, 'deleteMessages').catch(() => false);
    if (msg.sender_user_id !== me && !canDeleteAny) throw forbidden('not_your_message');

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
  chatType: string;
  chatTitle: string;
  messageId: string;
  kind: string;
  senderId: string;
  senderUsername: string;
  senderDisplayName: string;
  asChannel: boolean;
  pushText: string;
  members: string[];
}

/**
 * Ставит push-уведомления получателям сообщения.
 * pushText — короткий предпросмотр, переданный отправителем; хранится только
 * в push-записи и может быть скрыт настройкой получателя.
 */
async function notifyMessageRecipients(input: NotifyRecipientsInput): Promise<void> {
  const recipients = input.members.filter((id) => id !== input.senderId);
  if (!recipients.length) return;

  const users = await query<{ id: string; status: string; muted_chats: unknown }>(
    'SELECT id, status, muted_chats FROM users WHERE id = ANY($1::uuid[])',
    [recipients],
  );

  const sender = (input.senderDisplayName || input.senderUsername || 'Пользователь').slice(0, 120);
  const chatTitle = String(input.chatTitle || '').slice(0, 160);
  const title = (
    input.chatType === 'direct'
      ? sender
      : input.chatType === 'channel' && input.asChannel
        ? chatTitle || sender
        : chatTitle
          ? `${sender} · ${chatTitle}`
          : sender
  ).slice(0, 200);
  const fallbackBody = input.kind === 'media' ? 'Медиа' : 'Новое сообщение';
  const body = (input.pushText.trim() || fallbackBody).slice(0, 300);

  for (const user of users) {
    // Заблокированные/удалённые аккаунты уведомления не получают.
    if (user.status !== 'active') continue;
    const muted = Array.isArray(user.muted_chats) ? (user.muted_chats as unknown[]) : [];
    if (muted.includes(input.chatId)) continue;

    await enqueueNotification(user.id, {
      kind: 'message',
      title,
      body,
      data: {
        chatId: input.chatId,
        chatType: input.chatType,
        chatTitle,
        messageId: input.messageId,
        kind: input.kind,
        senderUsername: input.senderUsername,
        senderDisplayName: input.senderDisplayName,
        asChannel: input.asChannel ? '1' : '0',
        title,
        body,
      },
    });
  }
}

function extractNonce(header: unknown): string {
  if (header && typeof header === 'object' && typeof (header as any).nonce === 'string') return (header as any).nonce;
  return '';
}

/** clientId из header: нужен для склейки оптимистичного сообщения и архива. */
function extractClientId(header: unknown): string | null {
  if (!header || typeof header !== 'object') return null;
  const h = header as Record<string, unknown>;
  const direct = h.clientId;
  if (typeof direct === 'string' && direct) return direct;
  const nested = h.clientHeader;
  if (nested && typeof nested === 'object') {
    const value = (nested as Record<string, unknown>).clientId;
    if (typeof value === 'string' && value) return value;
  }
  return null;
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
  client_id: string | null;
  msg_uuid: string | null;
  is_delivered?: boolean;
  is_read?: boolean;
}

export default messageRoutes;
