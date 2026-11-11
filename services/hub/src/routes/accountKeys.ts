/** Ключ аккаунта (публичная часть) — используется для мультиустройства. */
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { one, query } from '../db.js';
import { badRequest, notFound, str } from '../util.js';

const accountKeyRoutes: FastifyPluginAsync = async (app) => {
  app.put('/me/account-key', { onRequest: [requireAuth()] }, async (req, reply) => {
    const body = (req.body ?? {}) as { accountPub?: string };
    const accountPub = str(body.accountPub, 'accountPub', { max: 2048 });
    if (!accountPub.startsWith('{')) throw badRequest('accountPub_invalid');
    await query('UPDATE users SET account_pub = $2 WHERE id = $1', [req.auth!.userId, accountPub]);
    return reply.send({ ok: true });
  });

  app.get('/users/:username/account-key', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { username } = req.params as { username: string };
    const row = await one<{ id: string; username: string; account_pub: string }>(
      'SELECT id, username, account_pub FROM users WHERE lower(username) = $1 AND status = $2',
      [username.toLowerCase(), 'active'],
    );
    if (!row) throw notFound('user');
    return reply.send({ userId: row.id, username: row.username, accountPub: row.account_pub });
  });
};

export default accountKeyRoutes;
