/** Ключевой материал устройств: бандлы для установления E2E-сессии, prekeys. */
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { one, query } from '../db.js';
import { badRequest, notFound, str } from '../util.js';

const keyRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Публичный бандл пользователя — нужен, чтобы начать с ним чат,
   * даже если его устройство сейчас офлайн (X3DH-подобная схема).
   */
  app.get('/users/:username/bundle', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { username } = req.params as { username: string };
    const user = await one<{ id: string; username: string; account_pub: string }>(
      `SELECT id, username, account_pub FROM users WHERE lower(username) = $1 AND status = 'active'`,
      [username.toLowerCase()],
    );
    if (!user) throw notFound('user');

    const devices = await query<{ id: string; identity_pub: string; ecdh_pub: string; signed_prekey: string; prekey_sig: string }>(
      `SELECT id, identity_pub, ecdh_pub, signed_prekey, prekey_sig
         FROM devices WHERE user_id = $1 AND revoked_at IS NULL AND ecdh_pub <> ''`,
      [user.id],
    );

    const out = [];
    for (const d of devices) {
      // один одноразовый prekey на каждое устройство (расходуется при выдаче)
      const prekey = await one<{ id: number; public_key: string }>(
        `SELECT id, public_key FROM prekeys WHERE device_id = $1 AND consumed_at IS NULL ORDER BY id LIMIT 1`,
        [d.id],
      );
      if (prekey) {
        await query('UPDATE prekeys SET consumed_at = now() WHERE id = $1', [prekey.id]);
      }
      out.push({
        deviceId: d.id,
        identityPub: d.identity_pub,
        ecdhPub: d.ecdh_pub,
        signedPrekey: d.signed_prekey,
        prekeySig: d.prekey_sig,
        oneTimePrekey: prekey?.public_key ?? null,
      });
    }

    return reply.send({ userId: user.id, username: user.username, accountPub: user.account_pub, devices: out });
  });

  /** Дозагрузка одноразовых prekeys своим устройством. */
  app.post('/devices/:id/prekeys', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { prekeys?: string[] };
    const prekeys = Array.isArray(body.prekeys) ? body.prekeys.slice(0, 100) : [];
    if (!prekeys.length) throw badRequest('prekeys_required');

    const dev = await one<{ user_id: string }>('SELECT user_id FROM devices WHERE id = $1 AND revoked_at IS NULL', [id]);
    if (!dev || dev.user_id !== req.auth!.userId) throw notFound('device');

    for (const pk of prekeys) {
      if (typeof pk === 'string' && pk.length > 0 && pk.length < 4096) {
        await query('INSERT INTO prekeys (device_id, public_key) VALUES ($1,$2)', [id, pk]);
      }
    }
    return reply.send({ added: prekeys.length });
  });

  /** Ротация signed prekey устройства. */
  app.post('/devices/:id/rotate-prekey', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { signedPrekey?: string; prekeySig?: string; ecdhPub?: string; identityPub?: string };
    const dev = await one<{ user_id: string }>('SELECT user_id FROM devices WHERE id = $1 AND revoked_at IS NULL', [id]);
    if (!dev || dev.user_id !== req.auth!.userId) throw notFound('device');

    await query(
      `UPDATE devices
          SET signed_prekey = COALESCE(NULLIF($2,''), signed_prekey),
              prekey_sig    = COALESCE(NULLIF($3,''), prekey_sig),
              ecdh_pub      = COALESCE(NULLIF($4,''), ecdh_pub),
              identity_pub  = COALESCE(NULLIF($5,''), identity_pub)
        WHERE id = $1`,
      [id, str(body.signedPrekey ?? '', 'signedPrekey', { max: 4096 }), body.prekeySig ?? '', body.ecdhPub ?? '', body.identityPub ?? ''],
    );
    return reply.send({ ok: true });
  });
};

export default keyRoutes;
