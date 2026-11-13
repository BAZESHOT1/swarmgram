/**
 * Серверный контракт KMesh_v1.
 *
 * Шлюз (токен модуля):
 *   POST /v1/kmesh/v1/archive     shadow copy (шифртекст временного ключа)
 *   POST /v1/kmesh/v1/presence    привязка node_id -> gateway_id
 *
 * Клиент (сессия пользователя):
 *   POST /v1/kmesh/v1/sync        постоянная переподписанная запись (идемпотентно по msg_uuid)
 *   GET  /v1/kmesh/v1/messages    история шифртекста для чата
 *   GET  /v1/kmesh/v1/presence/:nodeId
 *   POST /v1/kmesh/v1/ack         подтверждения доставки
 *
 * Каноническая строка подписи (UTF-8, хэшируется один раз перед ECDSA/Ed25519):
 *   KLINTO-KMESH1-PERM|<msg_uuid hex>|<sender_id>|<receiver_id>|<timestamp_ms>|<cipher hex>
 */
import { createHash, createPublicKey, verify as verifyRawSignature } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { requireModule } from './modules.js';
import { config } from '../config.js';
import { verifyEcdsaP256 } from '../crypto.js';
import { one, query } from '../db.js';
import { badRequest, forbidden, notFound, rateLimit, str } from '../util.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID64_RE = /^[0-9a-f]{16}$/i;
const HEX_RE = /^[0-9a-f]+$/i;
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';
const MAX_ARCHIVE_B64 = 512;
const MAX_CIPHERTEXT_B64 = 1024;

function isHex(value: string, bytes?: number): boolean {
  return HEX_RE.test(value) && value.length % 2 === 0 && (bytes === undefined || value.length === bytes * 2);
}

function canonicalDigest(input: {
  msgUuid: string;
  senderId: number;
  receiverId: number;
  timestamp: number;
  ciphertextHex: string;
}): string {
  return `KLINTO-KMESH1-PERM|${input.msgUuid.toLowerCase()}|${input.senderId >>> 0}|${input.receiverId >>> 0}|${input.timestamp}|${input.ciphertextHex.toLowerCase()}`;
}

function verifyEd25519(publicKeyHex: string, data: Buffer, signatureHex: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(ED25519_SPKI_PREFIX + publicKeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    return verifyRawSignature(null, data, key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

interface SyncBody {
  msg_uuid?: unknown;
  chat_id?: unknown;
  sender_node_id?: unknown;
  receiver_node_id?: unknown;
  timestamp?: unknown;
  ciphertext_b64?: unknown;
  nonce?: unknown;
  kind?: unknown;
  header?: unknown;
  signature?: unknown;
  sig_alg?: unknown;
  resign_mode?: unknown;
  chat_ref?: unknown;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const kmeshV1Routes: FastifyPluginAsync = async (app) => {
  /* --------------------------------------------------------- gateway ---- */

  app.post('/kmesh/v1/presence', { onRequest: [requireModule()] }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gatewayId = num(body.gateway_id);
    const nodeId = num(body.node_id);
    if (!Number.isInteger(gatewayId) || gatewayId <= 1) throw badRequest('gateway_id_required');
    if (!Number.isInteger(nodeId) || nodeId <= 1) throw badRequest('node_id_required');
    const ttlSec = Math.min(Math.max(num(body.ttl_sec) || 600, 60), 3600);

    await query(
      `INSERT INTO kmesh_v1_presence
         (node_id, gateway_id, rssi, hops, iface, battery, role, last_seen_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), now() + (($8)::int || ' seconds')::interval)
       ON CONFLICT (node_id) DO UPDATE SET
         gateway_id = EXCLUDED.gateway_id,
         rssi = EXCLUDED.rssi,
         hops = EXCLUDED.hops,
         iface = EXCLUDED.iface,
         battery = EXCLUDED.battery,
         role = EXCLUDED.role,
         last_seen_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [nodeId, gatewayId, num(body.rssi), num(body.hops), num(body.iface), num(body.battery),
       num(body.role), ttlSec],
    );
    await query(
      `INSERT INTO kmesh_v1_gateways (gateway_id, last_seen_at, uplink_ok, uplink_fail, version)
       VALUES ($1, now(), $2, $3, $4)
       ON CONFLICT (gateway_id) DO UPDATE SET
         last_seen_at = now(),
         uplink_ok = kmesh_v1_gateways.uplink_ok + EXCLUDED.uplink_ok,
         uplink_fail = kmesh_v1_gateways.uplink_fail + EXCLUDED.uplink_fail,
         version = COALESCE(NULLIF(EXCLUDED.version, ''), kmesh_v1_gateways.version)`,
      [gatewayId, num(body.uplink_ok), num(body.uplink_fail), String(body.version ?? '')],
    );
    return reply.send({ ok: true, node_id: nodeId, gateway_id: gatewayId, ttl_sec: ttlSec });
  });

  app.post('/kmesh/v1/archive', { onRequest: [requireModule()] }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gatewayId = num(body.gateway_id);
    const uuid = String(body.msg_uuid ?? '').toLowerCase();
    const packetB64 = String(body.packet_b64 ?? '');
    if (!Number.isInteger(gatewayId) || gatewayId <= 1) throw badRequest('gateway_id_required');
    if (!UUID64_RE.test(uuid)) throw badRequest('invalid_msg_uuid');
    if (!packetB64 || packetB64.length > MAX_ARCHIVE_B64) throw badRequest('invalid_packet');

    let packet: Buffer;
    try {
      packet = Buffer.from(packetB64, 'base64');
    } catch {
      throw badRequest('invalid_packet');
    }
    if (packet.length < 37 || packet[0] !== 0xa7 || packet[1] !== 3) throw badRequest('invalid_packet');
    const wireUuid = packet.subarray(6, 14).reverse().toString('hex');
    if (wireUuid !== uuid) throw badRequest('msg_uuid_mismatch');

    const src = packet.readUInt32LE(14);
    const dst = packet.readUInt32LE(18);
    const packetId = packet.readUInt32LE(2);
    const packetType = packet[30];
    const packetFlags = packet[31];
    const hopCount = packet[33];

    const result = await query<{ status: string }>(
      `INSERT INTO kmesh_v1_archive
         (msg_uuid, gateway_id, src_id, dst_id, packet_id, packet_type, packet_flags,
          chat_ref, rpc_op, rssi, iface, hop_count, packet_b64, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
       ON CONFLICT (msg_uuid) DO UPDATE SET
         gateway_id = EXCLUDED.gateway_id,
         rssi = GREATEST(kmesh_v1_archive.rssi, EXCLUDED.rssi),
         updated_at = now()
       RETURNING status`,
      [uuid, gatewayId, src, dst, packetId, packetType, packetFlags,
       body.chat_ref == null ? null : num(body.chat_ref),
       body.rpc_op == null ? null : num(body.rpc_op), num(body.rssi), num(body.iface),
       hopCount, packetB64],
    );

    return reply.code(202).send({
      ok: true,
      msg_uuid: uuid,
      status: result[0]?.status ?? 'pending',
      note: result[0]?.status === 'permanent' ? 'already_permanent' : 'shadow_stored',
    });
  });

  /* ---------------------------------------------------------- client ---- */

  app.post('/kmesh/v1/sync', { onRequest: [requireAuth()] }, async (req, reply) => {
    const auth = req.auth!;
    const body = (req.body ?? {}) as SyncBody;
    const uuid = String(body.msg_uuid ?? '').toLowerCase();
    const chatId = String(body.chat_id ?? '');
    const senderNode = num(body.sender_node_id);
    const receiverNode = num(body.receiver_node_id);
    const timestamp = num(body.timestamp);
    const ciphertextB64 = String(body.ciphertext_b64 ?? '');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');
    const signature = String(body.signature ?? '');
    const sigAlg = String(body.sig_alg ?? 'ecdsa-p256').toLowerCase();
    const resignMode = String(body.resign_mode ?? 'client').toLowerCase();

    if (!UUID64_RE.test(uuid)) throw badRequest('invalid_msg_uuid');
    if (!UUID_RE.test(chatId)) throw badRequest('invalid_chat_id');
    if (!Number.isInteger(senderNode) || senderNode <= 1) throw badRequest('invalid_sender_node');
    if (!Number.isInteger(receiverNode) || receiverNode <= 1) throw badRequest('invalid_receiver_node');
    if (!Number.isFinite(timestamp) || timestamp <= 0) throw badRequest('invalid_timestamp');
    if (!ciphertext.length || ciphertextB64.length > MAX_CIPHERTEXT_B64) throw badRequest('invalid_ciphertext');
    if (resignMode !== 'client' && resignMode !== 'server') throw badRequest('invalid_resign_mode');

    rateLimit(`kmesh-v1-sync:${auth.userId}`, 60, 60_000);

    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, auth.userId]);
    if (!member) throw forbidden('not_a_member');

    const existing = await one<{ server_seq: number; permanent_signature: string; chat_id: string; sender_user_id: string }>(
      `SELECT server_seq, permanent_signature, chat_id, sender_user_id
         FROM kmesh_v1_messages WHERE msg_uuid = $1`,
      [uuid],
    );
    if (existing) {
      if (existing.chat_id !== chatId || existing.sender_user_id !== auth.userId) {
        throw badRequest('msg_uuid_conflict');
      }
      return reply.send({
        ok: true,
        deduped: true,
        msg_uuid: uuid,
        server_seq: existing.server_seq,
        permanent_signature: existing.permanent_signature,
      });
    }

    const canonical = canonicalDigest({
      msgUuid: uuid,
      senderId: senderNode,
      receiverId: receiverNode,
      timestamp,
      ciphertextHex: ciphertext.toString('hex'),
    });
    const canonicalBytes = Buffer.from(canonical, 'utf8');

    const device = await one<{ id: string; identity_pub: string }>(
      'SELECT id, identity_pub FROM devices WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [auth.deviceId, auth.userId],
    );
    if (!device) throw notFound('device');

    let signatureOk = false;
    if (sigAlg === 'ecdsa-p256' || sigAlg === 'p256') {
      signatureOk = verifyEcdsaP256(device.identity_pub, canonicalBytes.toString('base64'), signature);
    } else if (sigAlg === 'ed25519') {
      signatureOk = isHex(device.identity_pub, 32) &&
        verifyEd25519(device.identity_pub.toLowerCase(), canonicalBytes, signature);
    } else {
      throw badRequest('unsupported_sig_alg');
    }
    if (!signatureOk) throw badRequest('invalid_signature');

    const permanentSignature = resignMode === 'server'
      ? createHash('sha256').update(canonicalBytes).update(config.jwtSecret).digest('hex')
      : signature;
    const storedAlg = resignMode === 'server' ? 'server-hmac-sha256' : sigAlg;

    const header = {
      kmeshV1: true,
      msgUuid: uuid,
      permanentSignature,
      sigAlg: storedAlg,
      resignMode,
      senderNodeId: senderNode,
      receiverNodeId: receiverNode,
      chatRef: body.chat_ref == null ? null : num(body.chat_ref),
      ciphertextB64,
      nonce: String(body.nonce ?? ''),
      clientHeader: body.header && typeof body.header === 'object' ? body.header : {},
    };

    const inserted = await one<{ seq: number; id: string; created_at: string }>(
      `INSERT INTO messages
         (chat_id, sender_user_id, sender_device_id, kind, header, msg_uuid)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (chat_id, msg_uuid) WHERE msg_uuid IS NOT NULL DO NOTHING
       RETURNING seq, id, created_at`,
      [chatId, auth.userId, device.id, str(String(body.kind ?? 'text'), 'kind', { max: 24 }),
       JSON.stringify(header), uuid],
    );

    let row = inserted;
    if (!row) {
      row = await one<{ seq: number; id: string; created_at: string }>(
        'SELECT seq, id, created_at FROM messages WHERE chat_id = $1 AND msg_uuid = $2',
        [chatId, uuid],
      );
    }
    if (!row) throw new Error('kmesh_v1_insert_failed');

    await query(
      `INSERT INTO kmesh_v1_messages
         (msg_uuid, chat_id, sender_user_id, sender_device_id, sender_node_id, receiver_node_id,
          kind, ciphertext_b64, nonce, header, permanent_signature, sig_alg, resign_mode,
          server_seq, archived_via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               CASE WHEN EXISTS (SELECT 1 FROM kmesh_v1_archive a WHERE a.msg_uuid = $1)
                    THEN 'gateway_shadow' ELSE 'direct' END)
       ON CONFLICT (msg_uuid) DO NOTHING`,
      [uuid, chatId, auth.userId, device.id, senderNode, receiverNode,
       str(String(body.kind ?? 'text'), 'kind', { max: 24 }), ciphertextB64,
       String(body.nonce ?? ''), JSON.stringify(header), permanentSignature, storedAlg,
       resignMode, row.seq],
    );

    await query(
      `UPDATE kmesh_v1_archive SET status = 'permanent', updated_at = now() WHERE msg_uuid = $1`,
      [uuid],
    );
    await query('UPDATE chats SET last_seq = GREATEST(last_seq, $2), updated_at = now() WHERE id = $1',
      [chatId, row.seq]);

    await query(
      `INSERT INTO kmesh_v1_sync_events (msg_uuid, user_id, chat_id, accepted, server_seq)
       VALUES ($1,$2,$3,true,$4)`,
      [uuid, auth.userId, chatId, row.seq],
    );

    const members = await query<{ user_id: string }>(
      'SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
    const { publish } = await import('../realtime.js');
    for (const m of members) {
      publish(m.user_id, {
        type: 'mesh_synced',
        chatId,
        msgUuid: uuid,
        serverSeq: row.seq,
        permanentSignature,
        resignMode,
      });
    }

    return reply.code(201).send({
      ok: true,
      deduped: false,
      msg_uuid: uuid,
      message_id: row.id,
      server_seq: row.seq,
      permanent_signature: permanentSignature,
      sig_alg: storedAlg,
      resign_mode: resignMode,
    });
  });

  app.get('/kmesh/v1/messages', { onRequest: [requireAuth()] }, async (req, reply) => {
    const auth = req.auth!;
    const q = req.query as { chatId?: string; since?: string; limit?: string };
    const chatId = String(q.chatId ?? '');
    if (!UUID_RE.test(chatId)) throw badRequest('invalid_chat_id');
    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, auth.userId]);
    if (!member) throw forbidden('not_a_member');
    const since = Number(q.since) || 0;
    const limit = Math.min(Number(q.limit) || 100, 200);
    const rows = await query<{
      msg_uuid: string; sender_user_id: string; sender_node_id: string; receiver_node_id: string;
      kind: string; ciphertext_b64: string; nonce: string; header: unknown;
      permanent_signature: string; sig_alg: string; resign_mode: string; server_seq: string;
      created_at: string; synced_at: string;
    }>(
      `SELECT msg_uuid, sender_user_id, sender_node_id, receiver_node_id, kind, ciphertext_b64,
              nonce, header, permanent_signature, sig_alg, resign_mode, server_seq,
              created_at, synced_at
         FROM kmesh_v1_messages
        WHERE chat_id = $1 AND (server_seq IS NULL OR server_seq > $2)
        ORDER BY synced_at ASC LIMIT $3`,
      [chatId, since, limit],
    );
    return reply.send(rows.map((r) => ({
      msgUuid: r.msg_uuid,
      chatId,
      senderUserId: r.sender_user_id,
      senderNodeId: Number(r.sender_node_id),
      receiverNodeId: Number(r.receiver_node_id),
      kind: r.kind,
      ciphertextB64: r.ciphertext_b64,
      nonce: r.nonce,
      header: r.header,
      permanentSignature: r.permanent_signature,
      sigAlg: r.sig_alg,
      resignMode: r.resign_mode,
      serverSeq: Number(r.server_seq) || 0,
      createdAt: r.created_at,
      syncedAt: r.synced_at,
    })));
  });

  app.get('/kmesh/v1/presence/:nodeId', { onRequest: [requireAuth()] }, async (req, reply) => {
    const nodeId = Number((req.params as { nodeId?: string }).nodeId);
    if (!Number.isInteger(nodeId) || nodeId <= 1) throw badRequest('invalid_node_id');
    const row = await one<{ gateway_id: string; rssi: number; hops: number; last_seen_at: string; expires_at: string }>(
      `SELECT gateway_id, rssi, hops, last_seen_at, expires_at
         FROM kmesh_v1_presence WHERE node_id = $1 AND expires_at > now()`,
      [nodeId],
    );
    if (!row) return reply.send({ nodeId, online: false, gatewayId: 0, fallbackGatewayIds: [] });
    const fallbacks = await query<{ gateway_id: string }>(
      `SELECT gateway_id FROM kmesh_v1_gateways
        WHERE gateway_id <> $1 AND last_seen_at > now() - interval '5 minutes'
        ORDER BY last_seen_at DESC LIMIT 2`,
      [Number(row.gateway_id)],
    );
    return reply.send({
      nodeId,
      online: true,
      gatewayId: Number(row.gateway_id),
      fallbackGatewayIds: fallbacks.map((f) => Number(f.gateway_id)),
      rssi: row.rssi,
      hops: row.hops,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
    });
  });

  app.post('/kmesh/v1/ack', { onRequest: [requireAuth()] }, async (req, reply) => {
    const auth = req.auth!;
    const body = (req.body ?? {}) as { messageUuids?: unknown };
    const uuids = Array.isArray(body.messageUuids)
      ? body.messageUuids.filter((v): v is string => typeof v === 'string' && UUID64_RE.test(v)).slice(0, 200)
      : [];
    if (!uuids.length) throw badRequest('message_uuids_required');

    const rows = await query<{ msg_uuid: string; chat_id: string; sender_user_id: string }>(
      `SELECT m.msg_uuid, m.chat_id, m.sender_user_id
         FROM kmesh_v1_messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
        WHERE m.msg_uuid = ANY($2::text[])`,
      [auth.userId, uuids],
    );
    const { publish } = await import('../realtime.js');
    let accepted = 0;
    for (const row of rows) {
      const msg = await one<{ id: string }>('SELECT id FROM messages WHERE chat_id = $1 AND msg_uuid = $2',
        [row.chat_id, row.msg_uuid]);
      if (!msg) continue;
      await query(
        `INSERT INTO message_receipts (message_id, user_id, device_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (message_id, user_id) WHERE device_id IS NULL DO NOTHING`,
        [msg.id, auth.userId, null],
      );
      publish(row.sender_user_id, {
        type: 'message_delivered',
        chatId: row.chat_id,
        messageId: msg.id,
        msgUuid: row.msg_uuid,
        userId: auth.userId,
      });
      accepted += 1;
    }
    return reply.send({ ok: true, accepted, rejected: uuids.length - accepted });
  });
};

export default kmeshV1Routes;
