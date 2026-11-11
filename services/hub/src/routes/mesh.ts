/**
 * Mailbag-протокол модулей расширения (esp-wifi-mesh / lora-mesh).
 *
 * Типы модулей (см. ARCHITECTURE.md):
 *  - personal  — носимый, привязан к пользователю; is_public=false → релеит
 *                только конверты чатов, где у владельца и адресата есть диалог;
 *                is_public=true → релеит для всех (проверка по username на downlink).
 *  - public    — автономный ретранслятор с WiFi-роутером (интернет-шлюз) для всех.
 *  - latent    — расширитель радиуса mesh; интернета нет, только telemetry.
 *
 * Поток:
 *   Uplink   POST /v1/mesh/relay     тело = шифроконверт (octet-stream), метаданные в headers
 *   Downlink GET  /v1/mesh/inbox     очередь адресата по username (последовательный seq)
 *   Ack      POST /v1/mesh/ack       подтверждение доставки по радио
 *   Sync     POST /v1/mesh/sync     клиент выставил сеть: слил локальные mesh-сообщения
 *                                    в серверную историю (идемпотентно по client_id)
 *
 * Хеш и подпись конверта: sha256(chatId|ciphertext) подписывается ECDSA-P256
 * устройством отправителя; Hub проверяет по identity_pub этого устройства.
 */
import type { FastifyPluginAsync } from 'fastify';
import { Readable } from 'node:stream';
import { mintTicket } from '../config.js';
import { requireAuth } from '../auth.js';
import { requireModule } from './modules.js';
import { verifyEcdsaP256 } from '../crypto.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { storeEncrypted } from '../storageRelay.js';
import { badRequest, forbidden, notFound, str } from '../util.js';

const MAX_RELAY_BYTES = 8 * 1024 * 1024;

/* ---------------------------------------------------------------- helpers */

function extractNonce(header: unknown): string {
  if (header && typeof header === 'object' && typeof (header as any).nonce === 'string') return (header as any).nonce;
  return '';
}

/** Модуль имеет право ретрансляции для указанного пользователя? */
function relayAllowed(
  module: { ownerId: string; moduleType: string; isPublic: boolean },
  targetUserId: string,
  hasSharedDialog: boolean,
): boolean {
  if (module.ownerId === targetUserId) return true;
  if (module.moduleType === 'public') return true;
  if (module.moduleType === 'personal' && module.isPublic) return true;
  // личный приватный модуль: только чаты владельца
  return hasSharedDialog;
}

interface ParsedEnvelope {
  chatId: string;
  nonce: string;
  kind: string;
  clientId: string;
  header: Record<string, unknown>;
  sig: string;
  bytes: Uint8Array;
}

function envelopeFromHeadersOrError(
  headers: Record<string, unknown>,
  body: Buffer,
): ParsedEnvelope {
  const chatId = String(headers['x-sg-chat-id'] ?? '');
  const nonce = String(headers['x-sg-nonce'] ?? '');
  const kind = String(headers['x-sg-kind'] ?? 'text');
  const clientId = String(headers['x-sg-client-id'] ?? '');
  const headerB64 = String(headers['x-sg-header'] ?? '');
  const sig = String(headers['x-sg-sig'] ?? '');
  if (!/^[0-9a-fA-F-]{36}$/.test(chatId)) throw badRequest('chat_required');
  if (!nonce.length || nonce.length > 64) throw badRequest('nonce_required');
  if (body.length === 0) throw badRequest('empty_payload');
  let header: Record<string, unknown> = {};
  try {
    header = headerB64 ? (JSON.parse(Buffer.from(headerB64, 'base64').toString('utf8')) as Record<string, unknown>) : {};
  } catch {
    header = {};
  }
  return { chatId, nonce, kind, clientId, header, sig, bytes: new Uint8Array(body) };
}

async function persistEnvelope(
  ownerId: string,
  deviceId: string,
  env: ParsedEnvelope,
  objectId: string,
  viaMesh: boolean,
): Promise<{ id: string; seq: number; created_at: string }> {
  const chat = await one<{ id: string; blocked_reason: string | null }>(
    'SELECT id, blocked_reason FROM chats WHERE id = $1',
    [env.chatId],
  );
  if (!chat) throw notFound('chat');
  if (chat.blocked_reason) throw forbidden('chat_blocked');

  return (await one<{ id: string; seq: number; created_at: string }>(
    `INSERT INTO messages (id, chat_id, sender_user_id, sender_device_id, kind, header, object_id, client_id)
     VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6, NULLIF($7,'')) RETURNING id, seq, created_at`
    , [
      env.chatId,
      ownerId,
      deviceId,
      str(env.kind, 'kind', { max: 24 }),
      JSON.stringify({ ...env.header, ...(viaMesh ? { viaMesh: true } : { syncedFromMesh: true }), nonce: env.nonce }),
      objectId,
      env.clientId,
    ],
  )) as { id: string; seq: number; created_at: string };
}

const meshRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------- uplink от модулей ---- */
  app.post('/mesh/relay', { onRequest: [requireModule()] }, async (req, reply) => {
    const mod = req.module!;
    const buffers: Buffer[] = [];
    for await (const chunk of req.body as Readable) buffers.push(chunk as Buffer);
    const body = Buffer.concat(buffers);
    const envelope = envelopeFromHeadersOrError(req.headers as Record<string, unknown>, body);

    if (!/^e?[0-9a-fA-F]{64}$/.test(envelope.sig) && envelope.sig.length < 60) throw badRequest('signature_required');

    const chat = await one<{ owner_id: string | null; blocked_reason: string | null }>(
      'SELECT owner_id, blocked_reason FROM chats WHERE id = $1',
      [envelope.chatId],
    );
    if (!chat) throw notFound('chat');
    if (chat.blocked_reason) throw forbidden('chat_blocked');

    const deviceRow = await one<{ id: string; user_id: string; identity_pub: string; revoked_at: Date | null }>(
      'SELECT id, user_id, identity_pub, revoked_at FROM devices WHERE id = $1',
      [String(req.headers['x-sg-device-id'] ?? '')],
    );
    if (!deviceRow || deviceRow.revoked_at) throw notFound('device');

    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [envelope.chatId, deviceRow.user_id]);
    if (!member) throw forbidden('not_a_member');

    const shaOfPayload = (await import('node:crypto')).createHash('sha256').update(envelope.bytes).digest('hex');
    const sigOk = verifyEcdsaP256(deviceRow.identity_pub, `${envelope.chatId}|${shaOfPayload}`, envelope.sig);
    if (!sigOk) throw badRequest('invalid_signature');

    // идемпотентность по client_id
    if (envelope.clientId) {
      const existing = await one<{ id: string; seq: number; created_at: string; header: unknown; object_id: string }>(
        'SELECT id, seq, created_at, header, object_id FROM messages WHERE chat_id = $1 AND client_id = $2',
        [envelope.chatId, envelope.clientId],
      );
      if (existing) return reply.code(200).send(envelopeView(existing, envelope.chatId, deviceRow.user_id, envelope.kind));
    }

    const stored = await storeEncrypted(deviceRow.user_id, Readable.from(envelope.bytes), MAX_RELAY_BYTES, config.replicas);
    
    const row = await persistEnvelope(deviceRow.user_id, deviceRow.id, envelope, stored.objectId, true);

    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [envelope.chatId]);
    for (const m of members) {
      await query('INSERT INTO object_grants (object_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [stored.objectId, m.user_id]);
    }
    await query('UPDATE chats SET last_seq = GREATEST(last_seq, $2), updated_at = now() WHERE id = $1', [envelope.chatId, row.seq]);
    const { publish } = await import('../realtime.js');
    for (const m of members) {
      publish(m.user_id, {
        type: 'message',
        chatId: envelope.chatId,
        message: envelopeView(
          { id: row.id, seq: row.seq, created_at: row.created_at, header: { nonce: envelope.nonce }, object_id: stored.objectId },
          envelope.chatId,
          deviceRow.user_id,
          envelope.kind,
        ),
      });
    }

    return reply.code(201).send(envelopeView(
      { id: row.id, seq: row.seq, created_at: row.created_at, header: { nonce: envelope.nonce }, object_id: stored.objectId },
      envelope.chatId,
      deviceRow.user_id,
      envelope.kind,
    ));
  });

  /* ----------------------------------------------- downlink и подтверждение */
  app.get('/mesh/inbox', { onRequest: [requireModule()] }, async (req, reply) => {
    const mod = req.module!;
    const username = String((req.query as { username?: string }).username ?? '').toLowerCase();
    const since = Number((req.query as { since?: string }).since ?? 0) || 0;
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 20) || 20, 50);
    if (!username) throw badRequest('username_required');

    const user = await one<{ id: string; status: string }>('SELECT id, status FROM users WHERE lower(username) = $1', [username]);
    if (!user) throw notFound('user');
    if (user.status !== 'active') throw forbidden('user_disabled');

    const shared = await one(
      `SELECT 1 FROM chat_members a JOIN chat_members b ON a.chat_id = b.chat_id
        WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`,
      [mod.ownerId, user.id],
    );
    if (!relayAllowed({ ownerId: mod.ownerId, moduleType: mod.moduleType, isPublic: mod.isPublic }, user.id, Boolean(shared))) {
      throw forbidden('not_allowed_to_relay');
    }

    const rows = await query<{
      seq: number; id: string; chat_id: string; kind: string; nonce: string; header: unknown; object_id: string; created_at: string; size_bytes: number;
    }>(
      `SELECT m.seq, m.id, m.chat_id, m.kind, m.header, m.object_id, m.created_at, COALESCE(o.size_bytes,0) AS size_bytes
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
         LEFT JOIN objects o ON o.id = m.object_id
        WHERE m.seq > $3 AND m.sender_user_id <> $2
          AND m.object_id IS NOT NULL
        ORDER BY m.seq ASC LIMIT $4`,
      [user.id, user.id, since, limit],
    );

    const out = [];
    for (const r of rows) {
      const frag = await query<{ index: number; id: string; node_id: string; public_url: string; ticket_secret: string }>(
        `SELECT f.index, n.id, f.node_id, n.public_url, n.ticket_secret
           FROM fragments f JOIN nodes n ON n.id = f.node_id
          WHERE f.object_id = $1 AND f.state = 'ok' AND n.status <> 'banned'
          ORDER BY (n.status = 'online') DESC, n.reputation DESC`,
        [r.object_id],
      );
      const first = frag[0];
      if (!first) continue;
      out.push({
        seq: r.seq,
        id: r.id,
        chatId: r.chat_id,
        kind: r.kind,
        nonce: extractNonce(r.header),
        header: r.header,
        createdAt: r.created_at,
        sizeBytes: r.size_bytes,
        transport: 'module' as const,
        nodeId: first.node_id,
        fragmentUrl: `${first.public_url.replace(/\/+$/, '')}/fragments/${r.object_id}/${first.index}`,
        ticket: mintTicket(first.ticket_secret, { op: 'get' as const, oid: r.object_id!, idx: first.index, sub: user.id }),
      });
    }
    return reply.send(out);
  });

  app.post('/mesh/ack', { onRequest: [requireModule()] }, async (req, reply) => {
    const mod = req.module!;
    const body = (req.body ?? {}) as { username?: string; messageIds?: string[] };
    const username = str(body.username ?? '', 'username').toLowerCase();
    const ids = (body.messageIds ?? []).slice(0, 200);
    if (!ids.length) throw badRequest('messageIds_required');

    const user = await one<{ id: string }>('SELECT id FROM users WHERE lower(username) = $1', [username]);
    if (!user) throw notFound('user');
    const shared = await one(
      `SELECT 1 FROM chat_members a JOIN chat_members b ON a.chat_id = b.chat_id
        WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`,
      [mod.ownerId, user.id],
    );
    if (!relayAllowed({ ownerId: mod.ownerId, moduleType: mod.moduleType, isPublic: mod.isPublic }, user.id, Boolean(shared))) {
      throw forbidden('not_allowed_to_relay');
    }

    let accepted = 0;
    for (const mid of ids) {
      const msg = await one<{ sender_user_id: string; chat_id: string }>('SELECT sender_user_id, chat_id FROM messages WHERE id = $1', [mid]);
      if (!msg) continue;
      await query(
        `INSERT INTO message_receipts (message_id, user_id, device_id) VALUES ($1,$2,NULL)
         ON CONFLICT (message_id, user_id) WHERE device_id IS NULL DO NOTHING`,
        [mid, user.id],
      );
      const { publish } = await import('../realtime.js');
      publish(msg.sender_user_id, { type: 'message_delivered', chatId: msg.chat_id, messageId: mid, userId: user.id });
      accepted += 1;
    }
    return reply.send({ ok: true, accepted, rejected: ids.length - accepted });
  });

  /* ------------------------------------- клиентский sync после интернета -- */
  app.post('/mesh/sync', { onRequest: [requireAuth()] }, async (req, reply) => {
    const meId = req.auth!.userId;
    const deviceId = req.auth!.deviceId;
    const buffers: Buffer[] = [];
    for await (const chunk of req.body as Readable) buffers.push(chunk as Buffer);
    const body = Buffer.concat(buffers);
    const envelope = envelopeFromHeadersOrError(req.headers as Record<string, unknown>, body);
    if (!envelope.clientId) throw badRequest('client_id_required');

    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [envelope.chatId, meId]);
    if (!member) throw forbidden('not_a_member');

    const existing = await one<{ id: string; seq: number; created_at: string; header: unknown; object_id: string }>(
      'SELECT id, seq, created_at, header, object_id FROM messages WHERE chat_id = $1 AND client_id = $2',
      [envelope.chatId, envelope.clientId],
    );
    if (existing) return reply.code(200).send(envelopeView(existing, envelope.chatId, meId, envelope.kind));

    const shaOfPayload = (await import('node:crypto')).createHash('sha256').update(envelope.bytes).digest('hex');
    if (envelope.sig) {
      const dev = await one<{ identity_pub: string }>('SELECT identity_pub FROM devices WHERE id = $1', [deviceId]);
      if (dev?.identity_pub && !verifyEcdsaP256(dev.identity_pub, `${envelope.chatId}|${shaOfPayload}`, envelope.sig)) {
        throw badRequest('invalid_signature');
      }
    }

    const stored = await storeEncrypted(meId, Readable.from(envelope.bytes), MAX_RELAY_BYTES, config.replicas);
    
    const row = await persistEnvelope(meId, deviceId, envelope, stored.objectId, false);

    const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [envelope.chatId]);
    for (const m of members) {
      await query('INSERT INTO object_grants (object_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [stored.objectId, m.user_id]);
    }
    await query('UPDATE chats SET last_seq = GREATEST(last_seq, $2), updated_at = now() WHERE id = $1', [envelope.chatId, row.seq]);
    const { publish } = await import('../realtime.js');
    for (const m of members) {
      publish(m.user_id, {
        type: 'message',
        chatId: envelope.chatId,
        message: envelopeView(
          { id: row.id, seq: row.seq, created_at: row.created_at, header: { nonce: envelope.nonce }, object_id: stored.objectId },
          envelope.chatId,
          meId,
          envelope.kind,
        ),
      });
    }

    return reply.code(201).send(envelopeView(
      { id: row.id, seq: row.seq, created_at: row.created_at, header: { nonce: envelope.nonce }, object_id: stored.objectId },
      envelope.chatId,
      meId,
      envelope.kind,
    ));
  });

  /* -------------------------------------- клиентский outbox (есть сеть) -- */
  app.get('/mesh/outbox', { onRequest: [requireAuth()] }, async (req, reply) => {
    const q = req.query as { since?: string; limit?: string };
    const since = Number(q.since) || 0;
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);
    const me = req.auth!.userId;

    const rows = await query<{
      seq: number; id: string; chat_id: string; kind: string; header: unknown; object_id: string; created_at: string; size_bytes: number;
    }>(
      `SELECT m.seq, m.id, m.chat_id, m.kind, m.header, m.object_id, m.created_at, COALESCE(o.size_bytes,0) AS size_bytes
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
         LEFT JOIN objects o ON o.id = m.object_id
        WHERE m.seq > $2
        ORDER BY m.seq ASC LIMIT $3`,
      [me, since, limit],
    );

    return reply.send(rows.map((r) => ({
      seq: r.seq,
      id: r.id,
      chatId: r.chat_id,
      kind: r.kind,
      objectId: r.object_id,
      sizeBytes: r.size_bytes,
      nonce: extractNonce(r.header),
      header: r.header,
      createdAt: r.created_at,
    })));
  });
};

function envelopeView(
  row: { id: string; seq: number; created_at: string; header: unknown; object_id: string },
  chatId: string,
  senderUserId: string,
  kind: string,
) {
  return {
    id: row.id,
    seq: row.seq,
    chatId,
    kind,
    objectId: row.object_id,
    nonce: extractNonce(row.header),
    header: row.header,
    createdAt: row.created_at,
    senderUserId,
  };
}

export default meshRoutes;
