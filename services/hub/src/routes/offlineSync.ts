/**
 * Offline sync outbox flush.
 *
 * Клиент после обычной отправки сообщений может «дослать» пакеты, которые
 * были переданы по mesh в офлайне. Hub не перешифровывает и не хранит сами
 * сообщения — здесь только проверка подлинности Ed25519-подписи и
 * аудит в offline_sync_batches.
 *
 * Подпись: Ed25519 над ASCII-строкой payloadHash (то есть
 * crypto.verify(null, Buffer.from(payloadHash), key, signature)).
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { query } from '../db.js';
import { badRequest, rateLimit } from '../util.js';

/** Максимум пакетов за один flush. */
const MAX_PACKETS = 20;

/** DER SPKI префикс для raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = '302a300506032b6570032100';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]+$/i;

interface OfflinePacket {
  clientId?: unknown;
  chatId?: unknown;
  createdAt?: unknown;
  payloadHash?: unknown;
  ephemeralPubkey?: unknown;
  signature?: unknown;
  transitional?: unknown;
}

interface AuditRow {
  clientId: string;
  chatId: string | null;
  ephemeralPubkey: string;
  signature: string;
  accepted: boolean;
  reason: string | null;
}

const isHex = (v: string, bytes?: number): boolean =>
  HEX_RE.test(v) && v.length % 2 === 0 && (bytes === undefined || v.length === bytes * 2);

/** Проверка Ed25519-подписи. Никогда не бросает: кривой ключ/подпись -> false. */
function verifyPacket(pubkeyHex: string, payloadHash: string, signatureHex: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(ED25519_SPKI_PREFIX + pubkeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(null, Buffer.from(payloadHash), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

const offlineSyncRoutes: FastifyPluginAsync = async (app) => {
  app.post('/mesh/outbox/flush', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    // Лимит на пользователя: 20 flush-запросов в минуту (не более 400 пакетов).
    rateLimit(`offline-sync:${me}`, 20, 60_000);

    const body = (req.body ?? {}) as { packets?: unknown };
    if (!Array.isArray(body.packets)) throw badRequest('packets_required');
    if (body.packets.length > MAX_PACKETS) throw badRequest('too_many_packets');

    const audits: AuditRow[] = [];
    const rejected: Array<{ clientId: string; reason: string }> = [];

    for (const raw of body.packets as OfflinePacket[]) {
      const clientId = typeof raw?.clientId === 'string' ? raw.clientId.slice(0, 128) : '';
      const chatId = typeof raw?.chatId === 'string' && UUID_RE.test(raw.chatId) ? raw.chatId : null;
      const pubkey = typeof raw?.ephemeralPubkey === 'string' ? raw.ephemeralPubkey.trim() : '';
      const signature = typeof raw?.signature === 'string' ? raw.signature.trim() : '';
      const payloadHash = typeof raw?.payloadHash === 'string' ? raw.payloadHash.trim() : '';

      let reason: string | null = null;
      if (!clientId) {
        reason = 'invalid_client_id';
      } else if (!chatId) {
        reason = 'invalid_chat_id';
      } else if (!isHex(payloadHash) || payloadHash.length > 128) {
        reason = 'invalid_payload_hash';
      } else if (!isHex(pubkey, 32)) {
        reason = 'invalid_ephemeral_pubkey';
      } else if (!isHex(signature, 64)) {
        reason = 'invalid_signature';
      } else if (!verifyPacket(pubkey, payloadHash, signature)) {
        reason = 'signature_mismatch';
      }

      if (reason) rejected.push({ clientId, reason });
      audits.push({
        clientId,
        chatId,
        ephemeralPubkey: pubkey.slice(0, 128),
        signature: signature.slice(0, 256),
        accepted: reason === null,
        reason,
      });
    }

    if (audits.length > 0) {
      const values: unknown[] = [];
      const tuples = audits.map((a, i) => {
        const b = i * 7;
        values.push(me, a.clientId, a.chatId, a.ephemeralPubkey, a.signature, a.accepted, a.reason);
        return `($${b + 1},$${b + 2},$${b + 3}::uuid,$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
      });
      await query(
        `INSERT INTO offline_sync_batches
           (user_id, client_id, chat_id, ephemeral_pubkey, signature, accepted, reason)
         VALUES ${tuples.join(',')}`,
        values,
      );
    }

    req.log.info(
      { userId: me, total: audits.length, accepted: audits.length - rejected.length, rejected: rejected.length },
      'offline_sync_flush',
    );

    return reply.send({
      ok: true,
      accepted: audits.length - rejected.length,
      rejected,
    });
  });
};

export default offlineSyncRoutes;
