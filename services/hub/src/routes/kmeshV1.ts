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
import { requireAdmin } from '../auth.js';
import { buildDeltaPatch, signManifest, otaSigningAvailable, type OtaManifest } from '../ota.js';

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

async function storeArchive(body: Record<string, unknown>, gatewayId: number) {
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
  return { uuid, status: result[0]?.status ?? 'pending' };
}

async function mapEntity(entityType: string, entityUuid: string): Promise<number> {
  const rows = await query<{ entity_id: string }>(
    `INSERT INTO kmesh_v1_entity_map (entity_type, entity_uuid)
     VALUES ($1,$2)
     ON CONFLICT (entity_type, entity_uuid) DO UPDATE SET entity_type = EXCLUDED.entity_type
     RETURNING entity_id`,
    [entityType, entityUuid],
  );
  return Number(rows[0]?.entity_id ?? 0) >>> 0;
}

const CHIP_BY_ARCH: Record<number, string> = { 1: 'esp32', 2: 'esp32c3', 3: 'esp32s3', 4: 'esp32c6' };
const ARCH_BY_CHIP: Record<string, number> = { esp32: 1, esp32c3: 2, esp32s3: 3, esp32c6: 4 };
const ROLE_NAME: Record<number, string> = { 0: 'client', 1: 'hybrid', 2: 'router', 3: 'gateway' };
const ROLE_BY_NAME: Record<string, number> = { client: 0, hybrid: 1, router: 2, gateway: 3 };

async function firmwareVersionFor(chip: string, build: number): Promise<string> {
  if (!chip || !build) return '';
  const row = await one<{ version: string }>(
    `SELECT version FROM kmesh_ota_releases
      WHERE chip = $1 AND build_number = $2 LIMIT 1`,
    [chip, build],
  );
  return row?.version ?? '';
}

/** UPSERT телеметрии из NODE_PRESENCE (без отдельных пакетов в эфире). */
async function upsertTelemetry(params: {
  nodeId: number;
  gatewayId: number;
  chipArch: number;
  nodeRole: number;
  radioCaps: number;
  fwBuild: number;
  otaState: number;
  batteryPct: number;
  hops: number;
  rssi: number;
  version?: string;
}): Promise<void> {
  const chip = CHIP_BY_ARCH[params.chipArch] ?? '';
  const version =
    params.version && params.version.length
      ? params.version.slice(0, 24)
      : await firmwareVersionFor(chip, params.fwBuild);
  await query(
    `INSERT INTO kmesh_nodes_telemetry
       (node_id, chip_arch, node_role, radio_caps, fw_build, fw_version_str, ota_state,
        battery_pct, last_gateway_id, hops_to_gw, last_rssi, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), now())
     ON CONFLICT (node_id) DO UPDATE SET
       chip_arch = EXCLUDED.chip_arch,
       node_role = EXCLUDED.node_role,
       radio_caps = EXCLUDED.radio_caps,
       fw_build = EXCLUDED.fw_build,
       fw_version_str = COALESCE(NULLIF(EXCLUDED.fw_version_str, ''),
                                 kmesh_nodes_telemetry.fw_version_str),
       ota_state = EXCLUDED.ota_state,
       battery_pct = EXCLUDED.battery_pct,
       last_gateway_id = EXCLUDED.last_gateway_id,
       hops_to_gw = EXCLUDED.hops_to_gw,
       last_rssi = EXCLUDED.last_rssi,
       last_seen_at = now()`,
    [
      params.nodeId, params.chipArch, params.nodeRole, params.radioCaps, params.fwBuild,
      version, params.otaState, params.batteryPct, params.gatewayId, params.hops, params.rssi,
    ],
  );
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
    if (num(body.fw_build) > 0 || num(body.chip_arch) > 0) {
      await upsertTelemetry({
        nodeId,
        gatewayId,
        chipArch: num(body.chip_arch),
        nodeRole: num(body.node_role),
        radioCaps: num(body.radio_caps),
        fwBuild: num(body.fw_build),
        otaState: num(body.ota_state),
        batteryPct: num(body.battery_pct),
        hops: num(body.hops),
        rssi: num(body.rssi),
        version: typeof body.fw_version === 'string' ? body.fw_version : undefined,
      });
    }
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

  /* ------------------------------------- мобильный шлюз (телефон) ------- */
  app.post('/kmesh/v1/mobile/archive', { onRequest: [requireAuth()] }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gatewayId = num(body.gateway_id);
    const result = await storeArchive(body, gatewayId);
    return reply.code(202).send({ ok: true, msg_uuid: result.uuid, status: result.status });
  });

  app.post('/kmesh/v1/mobile/presence', { onRequest: [requireAuth()] }, async (req, reply) => {
    const auth = req.auth!;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gatewayId = num(body.gateway_id);
    const nodeId = num(body.node_id);
    if (!Number.isInteger(gatewayId) || gatewayId <= 1) throw badRequest('gateway_id_required');
    if (!Number.isInteger(nodeId) || nodeId <= 1) throw badRequest('node_id_required');
    await query(
      `INSERT INTO kmesh_v1_presence
         (node_id, gateway_id, user_id, rssi, hops, iface, battery, role, last_seen_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), now() + interval '5 minutes')
       ON CONFLICT (node_id) DO UPDATE SET
         gateway_id = EXCLUDED.gateway_id,
         user_id = EXCLUDED.user_id,
         rssi = EXCLUDED.rssi,
         hops = EXCLUDED.hops,
         battery = EXCLUDED.battery,
         role = EXCLUDED.role,
         last_seen_at = now(),
         expires_at = EXCLUDED.expires_at`,
      [nodeId, gatewayId, auth.userId, num(body.rssi), num(body.hops), num(body.iface),
       num(body.battery), num(body.role)],
    );
    if (num(body.fw_build) > 0 || num(body.chip_arch) > 0) {
      await upsertTelemetry({
        nodeId,
        gatewayId,
        chipArch: num(body.chip_arch),
        nodeRole: num(body.node_role),
        radioCaps: num(body.radio_caps),
        fwBuild: num(body.fw_build),
        otaState: num(body.ota_state),
        batteryPct: num(body.battery_pct),
        hops: num(body.hops),
        rssi: num(body.rssi),
        version: typeof body.fw_version === 'string' ? body.fw_version : undefined,
      });
    }
    return reply.send({ ok: true, nodeId, gatewayId });
  });

  app.post('/kmesh/v1/node/bind', { onRequest: [requireAuth()] }, async (req, reply) => {    const auth = req.auth!;
    const nodeId = num((req.body as Record<string, unknown>)?.node_id);
    if (!Number.isInteger(nodeId) || nodeId <= 1) throw badRequest('invalid_node_id');
    await query(
      `INSERT INTO kmesh_v1_node_bindings (node_id, user_id, updated_at)
       VALUES ($1,$2, now())
       ON CONFLICT (node_id) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = now()`,
      [nodeId, auth.userId],
    );
    await query(
      `UPDATE kmesh_v1_presence SET user_id = $2 WHERE node_id = $1`,
      [nodeId, auth.userId],
    );
    return reply.send({ ok: true, nodeId, userId: auth.userId });
  });

  /* ------------------------------------------------------- поиск -------- */
  app.get('/kmesh/v1/search', { onRequest: [requireAuth()] }, async (req, reply) => {
    const auth = req.auth!;
    const q = String((req.query as { q?: string }).q ?? '').trim();
    const type = String((req.query as { type?: string }).type ?? 'all');
    if (q.length < 2) throw badRequest('query_too_short');
    const pattern = `%${q.replace(/[%_]/g, '\\$&')}%`;
    const out: Array<{ entityId: number; type: string; name: string; username?: string }> = [];

    if (type === 'all' || type === 'users') {
      const users = await query<{ id: string; username: string; display_name: string }>(
        `SELECT id, username, display_name FROM users
          WHERE status = 'active' AND (username ILIKE $1 OR display_name ILIKE $1)
          ORDER BY last_seen_at DESC NULLS LAST LIMIT 3`,
        [pattern],
      );
      for (const u of users) {
        out.push({
          entityId: await mapEntity('user', u.id),
          type: 'user',
          name: u.display_name || u.username,
          username: u.username,
        });
        if (out.length >= 5) break;
      }
    }
    if (out.length < 5 && (type === 'all' || type === 'groups' || type === 'channels')) {
      const allowed = type === 'groups' ? ['group'] : type === 'channels' ? ['channel'] : ['group', 'channel'];
      const chats = await query<{ id: string; title: string; type: string }>(
        `SELECT id, title, type FROM chats
          WHERE type = ANY($1::text[]) AND visibility <> 'private' AND title ILIKE $2
          ORDER BY updated_at DESC LIMIT $3`,
        [allowed, pattern, 5 - out.length],
      );
      for (const c of chats) {
        out.push({ entityId: await mapEntity(c.type, c.id), type: c.type, name: c.title });
      }
    }
    return reply.send({ ok: true, query: q, results: out.slice(0, 5) });
  });

  /* -------------------------------------------------------- лента ------- */
  app.get('/kmesh/v1/feed', { onRequest: [requireAuth()] }, async (req, reply) => {
    const auth = req.auth!;
    const sinceMs = Number((req.query as { since?: string }).since ?? 0) || 0;
    const rows = await query<{
      id: string; title: string; type: string; unread: string; last_uuid: string | null;
      ts: string | null; preview: string | null;
    }>(
      `SELECT c.id, c.title, c.type,
              (SELECT count(*) FROM messages m
                WHERE m.chat_id = c.id AND m.seq > cm.last_read_seq) AS unread,
              (SELECT m.msg_uuid FROM messages m WHERE m.chat_id = c.id
                ORDER BY m.seq DESC LIMIT 1) AS last_uuid,
              (SELECT m.created_at FROM messages m WHERE m.chat_id = c.id
                ORDER BY m.seq DESC LIMIT 1) AS ts,
              (SELECT m.header->>'preview' FROM messages m WHERE m.chat_id = c.id
                ORDER BY m.seq DESC LIMIT 1) AS preview
         FROM chats c
         JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
        WHERE $2 = 0 OR c.updated_at > to_timestamp($2 / 1000.0)
        ORDER BY c.updated_at DESC LIMIT 5`,
      [auth.userId, sinceMs],
    );
    const items = [];
    for (const r of rows) {
      items.push({
        entityId: await mapEntity('chat', r.id),
        chatId: r.id,
        type: r.type,
        title: r.title,
        unreadCount: Number(r.unread) || 0,
        lastMsgUuid: r.last_uuid ?? '',
        timestamp: r.ts ? new Date(r.ts).getTime() : 0,
        preview: r.preview ?? '',
      });
    }
    return reply.send({ ok: true, items });
  });

  /* --------------------------------------------- история чата ----------- */
  app.get('/kmesh/v1/history', { onRequest: [requireAuth()] }, async (req, reply) => {
    const auth = req.auth!;
    const q = req.query as { chatId?: string; before?: string; limit?: string };
    const chatId = String(q.chatId ?? '');
    if (!UUID_RE.test(chatId)) throw badRequest('invalid_chat_id');
    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, auth.userId]);
    if (!member) throw forbidden('not_a_member');
    const before = Number(q.before) || 0;
    const limit = Math.min(Math.max(Number(q.limit) || 10, 1), 20);
    const rows = await query<{
      msg_uuid: string; sender_node_id: string; ciphertext_b64: string; nonce: string;
      header: unknown; synced_at: string;
    }>(
      `SELECT msg_uuid, sender_node_id, ciphertext_b64, nonce, header, synced_at
         FROM kmesh_v1_messages
        WHERE chat_id = $1 AND ($2 = 0 OR synced_at < to_timestamp($2 / 1000.0))
        ORDER BY synced_at DESC LIMIT $3`,
      [chatId, before, limit],
    );
    return reply.send({
      ok: true,
      chatId,
      items: rows.map((r) => ({
        msgUuid: r.msg_uuid,
        senderNodeId: Number(r.sender_node_id),
        ciphertextB64: r.ciphertext_b64,
        nonce: r.nonce,
        header: r.header,
        timestamp: new Date(r.synced_at).getTime(),
      })),
    });
  });

  /* ------------------------------------ шлюзы для downlink канала ------- */
  app.get('/kmesh/v1/channel/gateways', { onRequest: [requireAuth()] }, async (req, reply) => {
    const auth = req.auth!;
    const chatId = String((req.query as { chatId?: string }).chatId ?? '');
    if (!UUID_RE.test(chatId)) throw badRequest('invalid_chat_id');
    const member = await one('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, auth.userId]);
    if (!member) throw forbidden('not_a_member');
    const rows = await query<{ gateway_id: string; members: string }>(
      `SELECT p.gateway_id, count(DISTINCT cm.user_id)::text AS members
         FROM kmesh_v1_presence p
         JOIN chat_members cm
           ON cm.user_id = COALESCE(p.user_id,
                (SELECT b.user_id FROM kmesh_v1_node_bindings b WHERE b.node_id = p.node_id))
        WHERE cm.chat_id = $1 AND p.expires_at > now() AND p.gateway_id > 1
        GROUP BY p.gateway_id
        ORDER BY count(DISTINCT cm.user_id) DESC`,
      [chatId],
    );
    return reply.send({
      ok: true,
      chatId,
      gateways: rows.map((r) => ({ gatewayId: Number(r.gateway_id), members: Number(r.members) })),
    });
  });

  /* --------------------------------------------- OTA для шлюзов ---------- */
  app.get('/kmesh/v1/ota/latest', { onRequest: [requireModule()] }, async (req, reply) => {
    const q = req.query as { chip?: string; base_build?: string; current_build?: string };
    const chip = String(q.chip ?? '').toLowerCase();
    if (!ARCH_BY_CHIP[chip]) throw badRequest('invalid_chip');
    const base = Number(q.base_build ?? q.current_build ?? 0) || 0;
    if (!Number.isInteger(base) || base <= 0) throw badRequest('invalid_base_build');

    const manifest = await one<{
      patch_id: number; base_build: number; target_build: number; version: string;
      total_chunks: number; patch_size: number; patch_sha256: string; target_sha256: string;
      sig_alg: string; signature: string;
    }>(
      `SELECT patch_id, base_build, target_build, version, total_chunks, patch_size,
              patch_sha256, target_sha256, sig_alg, signature
         FROM kmesh_ota_manifests
        WHERE chip = $1 AND base_build = $2
        ORDER BY target_build DESC LIMIT 1`,
      [chip, base],
    );
    if (manifest) {
      return reply.send({
        ok: true,
        full: false,
        chip,
        patch_id: manifest.patch_id,
        base_build: manifest.base_build,
        target_build: manifest.target_build,
        version: manifest.version,
        total_chunks: manifest.total_chunks,
        patch_size: manifest.patch_size,
        patch_sha256: manifest.patch_sha256,
        target_sha256: manifest.target_sha256,
        sig_alg: manifest.sig_alg,
        signature: manifest.signature,
        patch_url: `/v1/kmesh/v1/ota/patch/${manifest.patch_id}`,
      });
    }
    const full = await one<{
      build_number: number; version: string; full_sha256: string; full_size: number;
    }>(
      `SELECT build_number, version, full_sha256, full_size
         FROM kmesh_ota_releases
        WHERE chip = $1 AND build_number > $2
        ORDER BY build_number DESC LIMIT 1`,
      [chip, base],
    );
    if (!full) return reply.send({ ok: true, up_to_date: true, chip, base_build: base });
    return reply.send({
      ok: true,
      full: true,
      chip,
      base_build: base,
      target_build: full.build_number,
      version: full.version,
      full_size: full.full_size,
      target_sha256: full.full_sha256,
      full_url: `/v1/kmesh/v1/ota/full/${chip}/${full.build_number}`,
    });
  });

  app.get('/kmesh/v1/ota/patch/:id', { onRequest: [requireModule()] }, async (req, reply) => {
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('invalid_patch_id');
    const row = await one<{ patch: Buffer; patch_sha256: string; patch_size: number }>(
      `SELECT patch, patch_sha256, patch_size FROM kmesh_ota_manifests WHERE patch_id = $1`,
      [id],
    );
    if (!row) throw notFound('patch');
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(row.patch_size))
      .header('x-patch-sha256', row.patch_sha256)
      .send(Buffer.from(row.patch));
  });

  app.get('/kmesh/v1/ota/full/:chip/:build', { onRequest: [requireModule()] }, async (req, reply) => {
    const chip = String((req.params as { chip?: string }).chip ?? '').toLowerCase();
    const build = Number((req.params as { build?: string }).build);
    if (!ARCH_BY_CHIP[chip]) throw badRequest('invalid_chip');
    if (!Number.isInteger(build) || build <= 0) throw badRequest('invalid_build');
    const row = await one<{ image: Buffer; full_sha256: string; full_size: number }>(
      `SELECT image, full_sha256, full_size FROM kmesh_ota_releases
        WHERE chip = $1 AND build_number = $2`,
      [chip, build],
    );
    if (!row) throw notFound('release');
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', String(row.full_size))
      .header('x-image-sha256', row.full_sha256)
      .send(Buffer.from(row.image));
  });

  /* ------------------------------- админ: загрузка релиза и генерация --- */
  app.post(
    '/kmesh/v1/admin/ota/release',
    { onRequest: [requireAdmin()], bodyLimit: 24 * 1024 * 1024 },
    async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const chip = String(body.chip ?? '').toLowerCase();
      const build = Number(body.build ?? body.build_number ?? 0);
      const version = String(body.version ?? '').trim();
      const imageB64 = String(body.image_b64 ?? '');
      if (!ARCH_BY_CHIP[chip]) throw badRequest('invalid_chip');
      if (!Number.isInteger(build) || build <= 0 || build > 65535) throw badRequest('invalid_build');
      if (!/^\d+\.\d+(\.\d+)?$/.test(version)) throw badRequest('invalid_version');
      if (!imageB64 || imageB64.length > 16 * 1024 * 1024) throw badRequest('invalid_image');
      const image = Buffer.from(imageB64, 'base64');
      if (image.length < 4096 || image.length > 8 * 1024 * 1024) throw badRequest('invalid_image');
      if (!otaSigningAvailable()) {
        return reply.code(503).send({ ok: false, error: 'ota_signing_unavailable' });
      }
      const latest = await one<{ build: string | null }>(
        `SELECT max(build_number)::text AS build FROM kmesh_ota_releases WHERE chip = $1`,
        [chip],
      );
      const latestBuild = Number(latest?.build ?? 0) || 0;
      if (latestBuild && build < latestBuild) {
        return reply.code(409).send({
          ok: false,
          error: 'build_not_monotonic',
          latest_build: latestBuild,
        });
      }

      const imageSha = createHash('sha256').update(image).digest('hex');
      await query(
        `INSERT INTO kmesh_ota_releases (chip, build_number, version, full_sha256, full_size, image)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (chip, build_number) DO UPDATE SET
           version = EXCLUDED.version,
           full_sha256 = EXCLUDED.full_sha256,
           full_size = EXCLUDED.full_size,
           image = EXCLUDED.image`,
        [chip, build, version, imageSha, image.length, image],
      );

      const previous = await query<{
        build_number: number; version: string; image: Buffer;
      }>(
        `SELECT build_number, version, image FROM kmesh_ota_releases
          WHERE chip = $1 AND build_number < $2
          ORDER BY build_number DESC LIMIT 3`,
        [chip, build],
      );
      const manifests: Array<Record<string, unknown>> = [];
      for (const prev of previous) {
        const delta = buildDeltaPatch(Buffer.from(prev.image), image);
        const totalChunks = Math.ceil(delta.patch.length / 180);
        if (totalChunks <= 0 || totalChunks > 4096) continue;
        const manifest: OtaManifest = {
          chip,
          baseBuild: prev.build_number,
          targetBuild: build,
          version,
          totalChunks,
          patchSize: delta.patch.length,
          patchSha256: delta.patchSha256,
          targetSha256: delta.targetSha256,
          signature: '',
          sigAlg: 'ecdsa-p256',
        };
        manifest.signature = signManifest(manifest);
        const row = await one<{ patch_id: number }>(
          `INSERT INTO kmesh_ota_manifests
             (chip, base_build, target_build, version, total_chunks, patch_size,
              patch_sha256, target_sha256, sig_alg, signature, patch)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (chip, base_build, target_build) DO UPDATE SET
             version = EXCLUDED.version,
             total_chunks = EXCLUDED.total_chunks,
             patch_size = EXCLUDED.patch_size,
             patch_sha256 = EXCLUDED.patch_sha256,
             target_sha256 = EXCLUDED.target_sha256,
             sig_alg = EXCLUDED.sig_alg,
             signature = EXCLUDED.signature,
             patch = EXCLUDED.patch,
             created_at = now()
           RETURNING patch_id`,
          [chip, prev.build_number, build, version, totalChunks, delta.patch.length,
           delta.patchSha256, delta.targetSha256, manifest.sigAlg, manifest.signature,
           delta.patch],
        );
        manifests.push({
          base_build: prev.build_number,
          target_build: build,
          patch_id: row?.patch_id ?? 0,
          patch_size: delta.patch.length,
          total_chunks: totalChunks,
          patch_sha256: delta.patchSha256,
        });
      }
      return reply.send({
        ok: true,
        chip,
        build,
        version,
        target_sha256: imageSha,
        full_size: image.length,
        manifests,
      });
    },
  );

  /* ------------------------- админ: мониторинг версий всех узлов --------- */
  app.get('/kmesh/v1/admin/nodes/status', { onRequest: [requireAdmin()] }, async (req, reply) => {
    const q = req.query as {
      outdated_only?: string; role?: string; chip?: string;
    };
    const latest: Record<string, number> = {};
    const latestRows = await query<{ chip: string; build: string }>(
      `SELECT chip, max(build_number)::text AS build FROM kmesh_ota_releases GROUP BY chip`,
    );
    for (const r of latestRows) latest[r.chip] = Number(r.build) || 0;

    const rows = await query<{
      node_id: string; chip_arch: number; node_role: number; radio_caps: number;
      fw_build: number; fw_version_str: string; ota_state: number; battery_pct: number;
      last_gateway_id: string; hops_to_gw: number; last_rssi: number;
      first_seen_at: string; last_seen_at: string;
    }>(
      `SELECT node_id::text, chip_arch, node_role, radio_caps, fw_build, fw_version_str,
              ota_state, battery_pct, last_gateway_id::text, hops_to_gw, last_rssi,
              first_seen_at, last_seen_at
         FROM kmesh_nodes_telemetry
        WHERE last_seen_at > now() - interval '15 minutes'
        ORDER BY last_seen_at DESC`,
    );

    const roleFilter = String(q.role ?? '').toLowerCase();
    const chipFilter = String(q.chip ?? '').toLowerCase();
    const outdatedOnly = String(q.outdated_only ?? '') === 'true';

    const nodes = rows
      .map((r) => {
        const chip = CHIP_BY_ARCH[r.chip_arch] ?? 'unknown';
        const role = ROLE_NAME[r.node_role] ?? 'unknown';
        const target = latest[chip] ?? 0;
        return {
          nodeId: Number(r.node_id),
          chip,
          role,
          radioCaps: r.radio_caps,
          fwBuild: Number(r.fw_build) || 0,
          fwVersion: r.fw_version_str || '',
          latestBuild: target,
          upToDate: target > 0 && Number(r.fw_build) >= target,
          outdated: target > 0 && Number(r.fw_build) < target,
          otaState: Number(r.ota_state) || 0,
          batteryPct: Number(r.battery_pct),
          lastGatewayId: Number(r.last_gateway_id),
          hopsToGw: Number(r.hops_to_gw),
          lastRssi: Number(r.last_rssi),
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at,
        };
      })
      .filter((n) => (roleFilter ? n.role === roleFilter : true))
      .filter((n) => (chipFilter ? n.chip === chipFilter : true))
      .filter((n) => (outdatedOnly ? n.outdated : true));

    const summary = {
      total: nodes.length,
      upToDate: nodes.filter((n) => n.upToDate).length,
      outdated: nodes.filter((n) => n.outdated).length,
      downloading: nodes.filter((n) => n.otaState === 1).length,
      pendingReboot: nodes.filter((n) => n.otaState === 3).length,
      failed: nodes.filter((n) => n.otaState === 4).length,
      unknownBuild: nodes.filter((n) => !n.fwBuild).length,
      byChip: nodes.reduce<Record<string, number>>((acc, n) => {
        acc[n.chip] = (acc[n.chip] ?? 0) + 1;
        return acc;
      }, {}),
      byRole: nodes.reduce<Record<string, number>>((acc, n) => {
        acc[n.role] = (acc[n.role] ?? 0) + 1;
        return acc;
      }, {}),
      latestByChip: latest,
      signingAvailable: otaSigningAvailable(),
    };
    return reply.send({ ok: true, summary, nodes });
  });



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
