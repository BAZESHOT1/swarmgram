/**
 * Резервные копии ключей: шифрованный blob на сервере.
 * Ключ шифрования = PBKDF2-SHA512(passsword, kdf_salt, 210k) на устройстве.
 * Сервер видит только ciphertext и соль; пароль и приватные ключи не уходят.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { badRequest, notFound, str } from '../util.js';

const MAX_BLOB = 128 * 1024;

/** Гарантирует, что у пользователя есть KDF-соль (генерируем лениво, публичные данные). */
export async function ensureKdfSalt(userId: string): Promise<string> {
  const row = await one<{ kdf_salt: string }>('SELECT kdf_salt FROM users WHERE id = $1', [userId]);
  if (!row) throw notFound('user');
  if (row.kdf_salt) return row.kdf_salt;
  const salt = Buffer.from((await import('node:crypto')).randomBytes(16)).toString('base64');
  await query('UPDATE users SET kdf_salt = $2 WHERE id = $1', [userId, salt]);
  return salt;
}

const keyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me/backup', { onRequest: [requireAuth()] }, async (req, reply) => {
    const kdfSalt = await ensureKdfSalt(req.auth!.userId);
    const row = await one<{ blob: string; updated_at: string }>(
      'SELECT blob, updated_at FROM key_backups WHERE user_id = $1',
      [req.auth!.userId],
    );
    return reply.send({
      kdfSalt,
      blob: row?.blob ?? null,
      updatedAt: row?.updated_at ?? null,
    });
  });

  app.put('/me/backup', { onRequest: [requireAuth()] }, async (req, reply) => {
    const body = (req.body ?? {}) as { blob?: string };
    const blob = str(body.blob, 'blob', { max: MAX_BLOB });
    // blob = JSON-строка {v,kdf,salt,nonce,ct}
    if (!blob.startsWith('{')) throw badRequest('blob_invalid');

    await ensureKdfSalt(req.auth!.userId);
    await query(
      `INSERT INTO key_backups (user_id, blob) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET blob = EXCLUDED.blob, updated_at = now()`,
      [req.auth!.userId, blob],
    );
    const row = await one<{ updated_at: string }>('SELECT updated_at FROM key_backups WHERE user_id = $1', [req.auth!.userId]);
    return reply.send({ ok: true, updatedAt: row?.updated_at ?? null });
  });
};

export default keyRoutes;
