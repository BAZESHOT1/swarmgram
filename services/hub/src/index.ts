/**
 * Kinto Hub — главный сервер (оркестратор).
 *
 * Отвечает за: аккаунты и username, каталог чатов, маршрутизацию к узлам,
 * репликацию «в 3 экземплярах», мониторинг узлов, квоты и биллинг.
 * Полезная нагрузка — только шифротексты; секреты остаются на устройствах.
 */
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { mkdirSync } from 'node:fs';
import { config } from './config.js';
import { migrate, pool, query } from './db.js';
import { attachRealtime } from './realtime.js';
import { startMonitor } from './monitor.js';
import { startReplicator } from './replicator.js';
import { startPushWorker } from './push.js';
import { errorHandler, log } from './util.js';
import { decryptSecret, keySecretWarning } from './secrets.js';

import authRoutes from './routes/auth.js';
import meRoutes from './routes/users.js';
import keyRoutes from './routes/devices.js';
import chatRoutes from './routes/chats.js';
import messageRoutes from './routes/messages.js';
import objectRoutes from './routes/objects.js';
import nodeRoutes from './routes/nodes.js';
import meshRoutes from './routes/mesh.js';
import statsRoutes from './routes/stats.js';
import channelRoutes from './routes/channels.js';
import moduleRoutes, { backfillPublicIds } from './routes/modules.js';
import adminRoutes from './routes/admin.js';
import keyBackupRoutes from './routes/keys.js';
import accountKeyRoutes from './routes/accountKeys.js';
import firmwareRoutes from './routes/firmware.js';
import networkRoutes from './routes/network.js';
import notificationRoutes from './routes/notifications.js';

/**
 * Проверка при старте: предупреждаем, если HUB_KEY_SECRET не задан, и
 * пробуем расшифровать все сохранённые ключи чатов. Это ловит ситуацию
 * «секрет подменили» до того, как пользователи увидят пустую историю.
 */
async function verifyKeyMaterial(): Promise<void> {
  const warning = keySecretWarning();
  if (warning) log('warn', 'hub_key_secret_missing', { warning });

  const rows = await query<{ chat_id: string; version: number; key_enc: string }>(
    'SELECT chat_id, version, key_enc FROM chat_key_versions',
  ).catch(() => [] as { chat_id: string; version: number; key_enc: string }[]);

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      decryptSecret(row.key_enc);
      ok += 1;
    } catch {
      failed += 1;
      log('error', 'chat_key_decrypt_failed_on_boot', { chatId: row.chat_id, version: row.version });
    }
  }
  log(failed ? 'error' : 'info', 'key_material_check', { total: rows.length, ok, failed });
}


async function main(): Promise<void> {  mkdirSync(config.tmpDir, { recursive: true });
  await migrate();
  // Backfill публичных 8-значных ID для модулей, созданных до миграции 019.
  await backfillPublicIds();
  await verifyKeyMaterial();

  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: config.maxUploadBytes + 1024 * 1024,
    requestTimeout: 120_000,
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(async (req, reply) => {
    void reply.status(404).send({ error: 'not_found', path: req.url });
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 2 } });

  // Нативные клиенты шлют шифротекст сырым потоком — отдаём его как stream,
  // чтобы не буферизовать файл в памяти Hub.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  app.get('/health', async (_req, reply) => {
    const dbOk = await query('SELECT 1 AS ok').then(() => true).catch(() => false);
    void reply.send({ ok: dbOk, service: 'swarmgram-hub', version: '1.0.0', time: new Date().toISOString() });
  });

  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(meRoutes, { prefix: '/v1' });
  await app.register(keyRoutes, { prefix: '/v1' });
  await app.register(chatRoutes, { prefix: '/v1' });
  await app.register(messageRoutes, { prefix: '/v1' });
  await app.register(objectRoutes, { prefix: '/v1' });
  await app.register(nodeRoutes, { prefix: '/v1' });
  await app.register(meshRoutes, { prefix: '/v1' });
  await app.register(statsRoutes, { prefix: '/v1' });
  await app.register(channelRoutes, { prefix: '/v1' });
  await app.register(moduleRoutes, { prefix: '/v1' });
  await app.register(adminRoutes, { prefix: '/v1' });
  await app.register(keyBackupRoutes, { prefix: '/v1' });
  await app.register(accountKeyRoutes, { prefix: '/v1' });
  await app.register(firmwareRoutes, { prefix: '/v1' });
  await app.register(networkRoutes, { prefix: '/v1' });
  await app.register(notificationRoutes, { prefix: '/v1' });

  try {
    await app.listen({ host: '0.0.0.0', port: config.port });
    attachRealtime(app.server);
    log('info', 'hub_started', { port: config.port, publicUrl: config.publicUrl, replicas: config.replicas });
  } catch (e) {
    log('error', 'listen_failed', { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }

  startMonitor();
  startReplicator();
  startPushWorker();

  const shutdown = async (signal: string): Promise<void> => {
    log('info', 'shutting_down', { signal });
    try {
      await app.close();
      await pool.end();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  log('error', 'fatal', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  process.exit(1);
});
