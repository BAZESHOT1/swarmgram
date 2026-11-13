/** Регистрация, логин, сессии, восстановление доступа. */
import type { FastifyPluginAsync } from 'fastify';
import { issueTokens, revokeRefresh, requireAuth } from '../auth.js';
import { config } from '../config.js';
import { hashCode, randomCode, uuid, verifyPassword, verifyToken } from '../crypto.js';
import { one, query, tx } from '../db.js';
import { sendMail } from '../mailer.js';
import { deriveMeshRelayKey } from '../secrets.js';
import {
  ApiError,
  EMAIL_RE,
  USERNAME_RE,
  badRequest,
  clientIp,
  conflict,
  log,
  notFound,
  rateLimit,
  str,
  unauthorized,
} from '../util.js';

interface DevicePayload {
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  identityPub?: string;
  ecdhPub?: string;
  signedPrekey?: string;
  prekeySig?: string;
  prekeys?: string[];
}

interface UserRow {
  id: string;
  email: string;
  username: string;
  display_name: string;
  plan: string;
  status: string;
  password_hash: string;
  email_verified: boolean;
  quota_bytes: number;
  used_bytes: number;
  username_changed_at: string;
}

const RESERVED = new Set([
  'admin', 'root', 'support', 'klinto', 'klinto', 'system', 'help', 'api', 'me', 'about', 'node', 'hub',
]);

function normalizeUsername(raw: string): string {
  const u = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw badRequest('invalid_username');
  if (RESERVED.has(u)) throw conflict('username_reserved');
  return u;
}

/** Создаёт (или обновляет) устройство с ключами. Приватные ключи на сервер не передаются. */
async function upsertDevice(userId: string, payload: DevicePayload): Promise<string> {
  if (payload.deviceId) {
    const existing = await one<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM devices WHERE id = $1 AND revoked_at IS NULL',
      [payload.deviceId],
    );
    if (existing && existing.user_id === userId) {
      await query('UPDATE devices SET name = $2, platform = $3, last_seen_at = now() WHERE id = $1', [
        existing.id,
        payload.deviceName ?? 'Unknown device',
        payload.platform ?? 'web',
      ]);
      return existing.id;
    }
  }

  const id = payload.deviceId && payload.deviceId.length === 36 ? payload.deviceId : uuid();
  await tx(async ({ query: q }) => {
    await q(
      `INSERT INTO devices (id, user_id, name, platform, identity_pub, ecdh_pub, signed_prekey, prekey_sig)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, last_seen_at = now()`,
      [
        id,
        userId,
        payload.deviceName ?? 'Unknown device',
        payload.platform ?? 'web',
        payload.identityPub ?? '',
        payload.ecdhPub ?? '',
        payload.signedPrekey ?? '',
        payload.prekeySig ?? '',
      ],
    );
    for (const pk of payload.prekeys ?? []) {
      await q('INSERT INTO prekeys (device_id, public_key) VALUES ($1,$2)', [id, pk]);
    }
  });
  return id;
}

const authRoutes: FastifyPluginAsync = async (app) => {
  /* ------------------------------------------------------------ register -- */
  app.post('/register', async (req, reply) => {
    const ip = clientIp(req);
    rateLimit(`reg:${ip}`, 5, 60 * 60 * 1000);

    const body = (req.body ?? {}) as {
      email?: string;
      username?: string;
      password?: string;
      displayName?: string;
      device?: DevicePayload;
    };

    const email = str(body.email, 'email').toLowerCase();
    if (!EMAIL_RE.test(email)) throw badRequest('invalid_email');
    const username = normalizeUsername(str(body.username, 'username'));
    const password = str(body.password, 'password', { min: 8, max: 200 });
    const displayName = str(body.displayName ?? '', 'displayName', { max: 64 }) || username;

    const exists = await one<{ email: string; username: string }>(
      'SELECT email, username FROM users WHERE lower(email) = $1 OR lower(username) = $2',
      [email, username],
    );
    if (exists) {
      if (exists.email.toLowerCase() === email) throw conflict('email_taken');
      throw conflict('username_taken');
    }

    const { hashPassword } = await import('../crypto.js');
    const userId = uuid();
    await query(
      `INSERT INTO users (id, email, username, display_name, password_hash, username_changed_at)
       VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' days')::interval)`,
      [userId, email, username, displayName, await hashPassword(password), String(config.usernameChangeCooldownDays)],
    );

    const deviceId = await upsertDevice(userId, body.device ?? {});
    await query('INSERT INTO username_history (user_id, username) VALUES ($1,$2)', [userId, username]);

    const code = randomCode(6);
    await query(
      `INSERT INTO email_codes (email, code_hash, purpose, expires_at) VALUES ($1,$2,'verify', now() + interval '24 hours')`,
      [email, await hashCode(code)],
    );
    await sendMail(email, 'Добро пожаловать в Klinto', `Код подтверждения: ${code}`);

    const tokens = await issueTokens(userId, deviceId, {
      userAgent: String(req.headers['user-agent'] ?? ''),
      ip,
    });

    log('info', 'user_registered', { userId, username });
    void reply.code(201).send({
      user: { id: userId, email, username, displayName, plan: 'free', emailVerified: false },
      deviceId,
      ...tokens,
      meshRelayKey: deriveMeshRelayKey(userId, deviceId),
      ...(config.nodeEnv !== 'production' ? { devEmailCode: code } : {}),
    });
  });

  /* --------------------------------------------------------------- login -- */
  app.post('/login', async (req, reply) => {
    const ip = clientIp(req);
    rateLimit(`login:${ip}`, 20, 5 * 60 * 1000);

    const body = (req.body ?? {}) as { login?: string; password?: string; device?: DevicePayload };
    const login = str(body.login, 'login').toLowerCase();
    const password = str(body.password, 'password', { min: 1, max: 200 });

    const user = await one<UserRow>(
      'SELECT * FROM users WHERE lower(email) = $1 OR lower(username) = $1',
      [login],
    );
    if (!user) throw unauthorized('invalid_credentials');
    if (user.status !== 'active') throw unauthorized('account_disabled');
    if (!(await verifyPassword(password, user.password_hash))) throw unauthorized('invalid_credentials');

    const deviceId = await upsertDevice(user.id, body.device ?? {});
    await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);

    const tokens = await issueTokens(user.id, deviceId, {
      userAgent: String(req.headers['user-agent'] ?? ''),
      ip,
    });

    void reply.send({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.display_name,
        plan: user.plan,
        emailVerified: user.email_verified,
      },
      deviceId,
      ...tokens,
      meshRelayKey: deriveMeshRelayKey(user.id, deviceId),
    });
  });

  /* ------------------------------------------------------------- refresh -- */
  app.post('/refresh', async (req, reply) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    const token = str(body.refreshToken, 'refreshToken');
    const claims = verifyToken(token, config.jwtSecret);
    if (!claims || claims.type !== 'refresh' || !claims.jti || !claims.did) throw unauthorized('invalid_token');

    const stored = await one<{ revoked_at: string | null }>('SELECT revoked_at FROM refresh_tokens WHERE id = $1', [claims.jti]);
    if (!stored) throw unauthorized('token_not_found');
    if (stored.revoked_at) throw unauthorized('token_revoked');

    const newJti = uuid();
    await revokeRefresh(claims.jti, newJti);

    const tokens = await issueTokens(claims.sub, claims.did, { ip: clientIp(req) });
    void reply.send({ ...tokens, meshRelayKey: deriveMeshRelayKey(claims.sub, claims.did) });
  });

  /* -------------------------------------------------------------- logout -- */
  app.post('/logout', { onRequest: [requireAuth()] }, async (req, reply) => {
    const body = (req.body ?? {}) as { refreshToken?: string };
    if (body.refreshToken) {
      const claims = verifyToken(body.refreshToken, config.jwtSecret);
      if (claims?.jti) await revokeRefresh(claims.jti);
    }
    void reply.send({ ok: true });
  });

  /* ------------------------------------------------------- verify email --- */
  app.post('/verify-email', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; code?: string };
    const email = str(body.email, 'email').toLowerCase();
    const code = str(body.code, 'code');

    const row = await one<{ id: string; code_hash: string; expires_at: string }>(
      `SELECT id, code_hash, expires_at FROM email_codes
        WHERE lower(email) = $1 AND purpose = 'verify' AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    if (!row || row.code_hash !== (await hashCode(code))) throw badRequest('invalid_code');

    await query('UPDATE users SET email_verified = true WHERE lower(email) = $1', [email]);
    await query('DELETE FROM email_codes WHERE lower(email) = $1 AND purpose = $2', [email, 'verify']);
    void reply.send({ ok: true });
  });

  /* ------------------------------------------------------- reset пароля --- */
  app.post('/reset/request', async (req, reply) => {
    rateLimit(`reset:${clientIp(req)}`, 5, 60 * 60 * 1000);
    const body = (req.body ?? {}) as { email?: string };
    const email = str(body.email, 'email').toLowerCase();
    const code = randomCode(8);
    await query(
      `INSERT INTO email_codes (email, code_hash, purpose, expires_at) VALUES ($1,$2,'reset', now() + interval '1 hour')`,
      [email, await hashCode(code)],
    );
    await sendMail(email, 'Восстановление доступа Klinto', `Код сброса пароля: ${code}`);
    void reply.send({ ok: true, ...(config.nodeEnv !== 'production' ? { devCode: code } : {}) });
  });

  app.post('/reset/confirm', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; code?: string; password?: string };
    const email = str(body.email, 'email').toLowerCase();
    const code = str(body.code, 'code');
    const password = str(body.password, 'password', { min: 8, max: 200 });

    const row = await one<{ id: string; code_hash: string }>(
      `SELECT id, code_hash FROM email_codes
        WHERE lower(email) = $1 AND purpose = 'reset' AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    if (!row || row.code_hash !== (await hashCode(code))) throw badRequest('invalid_code');

    const { hashPassword } = await import('../crypto.js');
    await query('UPDATE users SET password_hash = $2 WHERE lower(email) = $1', [email, await hashPassword(password)]);
    await query('DELETE FROM email_codes WHERE lower(email) = $1 AND purpose = $2', [email, 'reset']);
    // все сессии аннулируем
    await query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = (SELECT id FROM users WHERE lower(email) = $1)',
      [email],
    );
    void reply.send({ ok: true });
  });

  /* ------------------------------------------------------- смена пароля --- */
  app.post(
    '/password',
    { onRequest: [requireAuth()] },
    async (req, reply) => {
      const body = (req.body ?? {}) as { oldPassword?: string; newPassword?: string };
      const userId = req.auth!.userId;
      const user = await one<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
      if (!user) throw notFound('user');
      if (!(await verifyPassword(str(body.oldPassword, 'oldPassword'), user.password_hash))) {
        throw new ApiError(400, 'invalid_password', 'invalid_password');
      }
      const { hashPassword } = await import('../crypto.js');
      await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
        userId,
        await hashPassword(str(body.newPassword, 'newPassword', { min: 8, max: 200 })),
      ]);
      void reply.send({ ok: true });
    },
  );

  /* --------------------------------------------------- проверка username -- */
  app.get('/check-username', async (req, reply) => {
    const username = normalizeUsername(str((req.query as { username?: string }).username, 'username'));
    const taken = await one('SELECT 1 FROM users WHERE lower(username) = $1', [username]);
    const reserved = await one(
      `SELECT 1 FROM username_history WHERE username = $1 AND changed_at > now() - interval '12 months'`,
      [username],
    );
    void reply.send({ username, available: !taken && !reserved });
  });
};

export default authRoutes;
