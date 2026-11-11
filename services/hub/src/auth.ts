/** Аутентификация и сессии Hub. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID, createHash } from 'node:crypto';
import { signToken, verifyToken, uuid } from './crypto.js';
import { config } from './config.js';
import { one, query } from './db.js';
import { unauthorized } from './util.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { userId: string; deviceId: string };
    admin?: { via: 'token' | 'user'; userId?: string };
  }
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function issueTokens(
  userId: string,
  deviceId: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<TokenPair> {
  const accessToken = signToken(
    { sub: userId, did: deviceId, type: 'access', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 15 * 60 },
    config.jwtSecret,
  );

  const jti = uuid();
  const refreshTtlSec = 30 * 24 * 3600;
  const refreshToken = signToken(
    { sub: userId, did: deviceId, type: 'refresh', jti, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + refreshTtlSec },
    config.jwtSecret,
  );

  await query(
    `INSERT INTO refresh_tokens (id, user_id, device_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
    [jti, userId, deviceId, hashOpaque(refreshToken), meta.userAgent ?? '', meta.ip ?? '', String(refreshTtlSec)],
  );

  return { accessToken, refreshToken, expiresIn: 900 };
}

function hashOpaque(token: string): string {
  // refresh-токен подписан сервером, в БД храним только хеш
  return createHash('sha256').update(token).digest('hex');
}

export async function revokeRefresh(jti: string, rotatedTo?: string): Promise<void> {
  await query('UPDATE refresh_tokens SET revoked_at = now(), rotated_to = $2 WHERE id = $1', [jti, rotatedTo ?? null]);
}

/** Кэш последней записи last_seen_at (userId -> timestamp), чтобы не писать в БД на каждый запрос. */
const lastSeenWrites = new Map<string, number>();
const LAST_SEEN_INTERVAL_MS = 60_000;

export function requireAuth(opts: { optional?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    const fromQuery = (req.query as Record<string, unknown>)?.access_token;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice(7)
        : typeof fromQuery === 'string'
          ? fromQuery
          : null;

    if (!token) {
      if (opts.optional) return;
      throw unauthorized();
    }
    const claims = verifyToken(token, config.jwtSecret);
    if (!claims || claims.type !== 'access' || !claims.did) {
      if (opts.optional) return;
      throw unauthorized('invalid_token');
    }
    req.auth = { userId: claims.sub, deviceId: claims.did };

    // Обновляем last_seen_at не чаще раза в 60 секунд на пользователя.
    const now = Date.now();
    const prev = lastSeenWrites.get(claims.sub) ?? 0;
    if (now - prev >= LAST_SEEN_INTERVAL_MS) {
      lastSeenWrites.set(claims.sub, now);
      void query('UPDATE users SET last_seen_at = now() WHERE id = $1', [claims.sub]).catch(() => undefined);
    }

    void reply;
  };
}

export function requireAdmin() {
  return async (req: FastifyRequest): Promise<void> => {
    // а) магический админ-токен из .env (bootstrap), б) сессия пользователя с ролью admin
    if (config.adminToken && typeof req.headers['x-admin-token'] === 'string' && req.headers['x-admin-token'] === config.adminToken) {
      req.admin = { via: 'token' };
      return;
    }
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      const claims = verifyToken(token, config.jwtSecret);
      if (claims && claims.type === 'access') {
        const row = await one<{ role: string }>('SELECT role FROM users WHERE id = $1', [claims.sub]);
        if (row?.role === 'admin') {
          req.admin = { via: 'user', userId: claims.sub };
          return;
        }
      }
    }
    throw unauthorized('admin_required');
  };
}

export function newId(): string {
  return randomUUID();
}
