/**
 * Klinto Node — узел хранения, который пользователь поднимает на своём сервере.
 *
 * Что делает:
 *  1. При старте сам регистрируется на главном сервере (MAIN_SERVER_URL из .env),
 *     передавая username владельца и claim-токен.
 *  2. Получает nodeId, nodeToken и ticket_secret — секрет подписи маршрутных билетов.
 *  3. Принимает/отдаёт фрагменты ТОЛЬКО по билету, подписанному этим секретом
 *     (Hub в отдаче данных не участвует: клиент ходит напрямую к узлу).
 *  4. Каждые 30 секунд шлёт heartbeat с телеметрией.
 *
 * Узел не имеет ключей расшифровки: всё, что он хранит — шифротексты.
 */
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { createHash } from 'node:crypto';
import os from 'node:os';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  promises as fsp,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { verifyTicket, type Ticket } from './ticket.js';

/* ------------------------------------------------------------------ конфиг */

const env = (name: string, def = ''): string => (process.env[name] ?? def).trim();

const config = {
  mainServerUrl: env('MAIN_SERVER_URL', 'https://api.kinto.is-a.dev').replace(/\/+$/, ''),
  ownerUsername: env('OWNER_USERNAME'),
  claimToken: env('NODE_CLAIM_TOKEN'),
  publicUrl: env('NODE_PUBLIC_URL'),
  name: env('NODE_NAME', 'klinto-node'),
  region: env('NODE_REGION', 'unknown'),
  capacityGb: Number(env('NODE_CAPACITY_GB', '20')) || 20,
  port: Number(env('NODE_PORT', '9090')) || 9090,
  dataDir: env('NODE_DATA_DIR', '/data'),
  version: '1.0.0',
  heartbeatSec: Number(env('NODE_HEARTBEAT_SEC', '30')) || 30,
};

const IDENTITY_FILE = path.join(config.dataDir, 'node.json');
const FRAGMENT_DIR = path.join(config.dataDir, 'fragments');

/** Отпечаток железа: приоритет — NODE_HW_HASH из .env, иначе machine-id/hostname. */
function hardwareHash(): string {
  const explicit = env('NODE_HW_HASH', '');
  if (explicit) return explicit.toLowerCase();
  let seed = `${os.hostname()}|${os.arch()}|${os.platform()}`;
  try {
    if (existsSync('/etc/machine-id')) seed += `|${readFileSync('/etc/machine-id', 'utf8').trim()}`;
  } catch {
    /* machine-id недоступен */
  }
  return createHash('sha256').update(seed).digest('hex');
}

const HW_HASH = hardwareHash();

interface Identity {
  nodeId: string;
  nodeToken: string;
  ticketSecret: string;
  ownerUsername: string;
  registeredAt: string;
}

let identity: Identity | null = null;
let usedBytes = 0;
/** Плановый вывод: Hub попросил больше не принимать новые фрагменты. */
let draining = false;

/* ------------------------------------------------------------------- логи - */

function log(level: 'info' | 'warn' | 'error' | 'debug', msg: string, meta: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: 'node', msg, ...meta });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/* -------------------------------------------------------------- хранилище - */

function fragmentPath(objectId: string, index: number): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(objectId)) throw new Error('invalid object id');
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx > 99) throw new Error('invalid index');
  const shard = objectId.slice(0, 2);
  const dir = path.join(FRAGMENT_DIR, shard);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${objectId}.${idx}`);
}

async function scanUsage(): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          total += statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  await walk(FRAGMENT_DIR);
  return total;
}

const capacityBytes = Math.floor(config.capacityGb * 1024 ** 3);

/* ------------------------------------------------------------- регистрация */

async function detectPublicUrl(): Promise<string> {
  if (config.publicUrl) return config.publicUrl;
  try {
    const res = await fetch('https://api.ipify.org?format=text', { signal: AbortSignal.timeout(5000) });
    const ip = (await res.text()).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      log('info', 'public_ip_detected', { ip });
      return `http://${ip}:${config.port}`;
    }
  } catch {
    /* ignore */
  }
  return `http://127.0.0.1:${config.port}`;
}

async function register(): Promise<Identity> {
  const publicUrl = await detectPublicUrl();
  const res = await fetch(`${config.mainServerUrl}/v1/nodes/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ownerUsername: config.ownerUsername,
      claimToken: config.claimToken,
      name: config.name,
      publicUrl,
      capacityBytes,
      region: config.region,
      version: config.version,
      hardwareId: HW_HASH,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    throw new Error(body?.message || body?.error || `register failed: ${res.status}`);
  }

  const id: Identity = {
    nodeId: body.nodeId,
    nodeToken: body.nodeToken,
    ticketSecret: body.ticketSecret,
    ownerUsername: config.ownerUsername,
    registeredAt: new Date().toISOString(),
  };
  mkdirSync(config.dataDir, { recursive: true });
  await fsp.writeFile(IDENTITY_FILE, JSON.stringify(id, null, 2), 'utf8');
  log('info', 'node_registered', { nodeId: id.nodeId, owner: id.ownerUsername, publicUrl });
  return id;
}

async function ensureIdentity(): Promise<void> {
  if (existsSync(IDENTITY_FILE)) {
    try {
      identity = JSON.parse(await fsp.readFile(IDENTITY_FILE, 'utf8')) as Identity;
      if (identity?.nodeId && identity?.ticketSecret) {
        log('info', 'identity_loaded', { nodeId: identity.nodeId });
        return;
      }
    } catch {
      /* файл повреждён — регистрируемся заново */
    }
  }

  if (!config.ownerUsername) {
    log('error', 'owner_username_missing', { hint: 'Set OWNER_USERNAME in .env' });
  }

  // повторяем попытки: контейнер может стартовать раньше главного сервера
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    try {
      identity = await register();
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/blocked/.test(msg)) {
        log('error', 'node_blocked', { error: msg, hint: 'Регистрация запрещена: IP или железо в блок-листе Hub' });
        return;
      }
      log('warn', 'register_retry', { attempt, error: msg });
      await new Promise((r) => setTimeout(r, Math.min(30_000, 3000 * attempt)));
    }
  }
  log('error', 'register_gave_up', {});
}

/* ------------------------------------------------------------- heartbeat -- */

async function heartbeat(): Promise<void> {
  if (!identity) return;
  try {
    usedBytes = await scanUsage();
    const free = Math.max(0, capacityBytes - usedBytes);
    const res = await fetch(`${config.mainServerUrl}/v1/nodes/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${identity.nodeToken}` },
      body: JSON.stringify({
        freeBytes: free,
        usedBytes,
        version: config.version,
        publicUrl: await detectPublicUrl(),
        hardwareId: HW_HASH,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      if (body?.error === 'node_blocked') {
        log('error', 'node_blocked', { hint: 'Hub заблокировал узел по IP/железу' });
        identity = null;
        await fsp.rm(IDENTITY_FILE, { force: true }).catch(() => {});
        return;
      }
      log('warn', 'heartbeat_failed', { status: res.status, error: body?.message ?? '' });
      return;
    }

    // Hub начал плановый вывод: перестаём принимать новые фрагменты.
    if (body?.drain === true && !draining) {
      draining = true;
      log('info', 'node_draining', { hint: 'new PUT /fragments requests are rejected with 503' });
    }

    // Вывод завершён: локальные фрагменты больше не нужны.
    if (body?.stop === true) {
      await stopAfterDrain();
    }
  } catch (e) {
    log('warn', 'heartbeat_error', { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Плановое выключение после drain: удаляем только файлы фрагментов.
 * node.json (identity) лежит в корне dataDir и сознательно сохраняется.
 */
async function stopAfterDrain(): Promise<void> {
  try {
    if (existsSync(FRAGMENT_DIR)) {
      await fsp.rm(FRAGMENT_DIR, { recursive: true, force: true });
    }
    usedBytes = 0;
    mkdirSync(FRAGMENT_DIR, { recursive: true });
  } catch (e) {
    // не гасим процесс, если не смогли почистить диск — попробуем на следующем heartbeat
    log('error', 'drain_cleanup_failed', { error: e instanceof Error ? e.message : String(e) });
    return;
  }
  log('info', 'node_stopped_after_drain', {
    dataDir: config.dataDir,
    identityKept: existsSync(IDENTITY_FILE),
  });
  process.exit(0);
}

/* ----------------------------------------------------------------- сервер - */

function ticketFrom(req: FastifyRequest): Ticket | null {
  if (!identity) return null;
  const raw = req.headers['x-sg-ticket'];
  const token = Array.isArray(raw) ? raw[0] : typeof raw === 'string' ? raw : '';
  if (!token) return null;
  const ticket = verifyTicket(token, identity.ticketSecret);
  if (!ticket) return null;
  const oid = (req.params as { oid?: string; objectId?: string }).oid ?? (req.params as any).objectId;
  const idx = Number((req.params as { idx?: string; index?: string }).idx ?? (req.params as any).index ?? -1);
  if (ticket.oid !== oid || ticket.idx !== idx) return null;
  return ticket;
}

const app = Fastify({ logger: false, bodyLimit: 512 * 1024 * 1024, trustProxy: true });

// CORS: браузерный клиент распределяет шифротексты напрямую на узлы,
// поэтому PUT/GET/OPTIONS с чужим origin обязаны работать (preflight включительно).
void app.register(cors, {
  origin: true,
  methods: ['GET', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['content-type', 'x-sg-ticket', 'x-sg-size', 'x-sg-filename', 'authorization'],
  exposedHeaders: ['content-length', 'x-sg-node'],
});

// Шифротекст приходит сырым потоком от Hub — не буферизуем в памяти узла.
app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
  done(null, payload);
});

app.get('/health', async (_req, reply) => {
  return reply.send({
    ok: true,
    service: 'klinto-node',
    version: config.version,
    registered: Boolean(identity),
    nodeId: identity?.nodeId ?? null,
    draining,
    usedBytes,
    freeBytes: Math.max(0, capacityBytes - usedBytes),
    capacityBytes,
    mainServer: config.mainServerUrl,
  });
});

app.get('/n/ping', async (req, reply) => {
  const ticket = ticketFrom(req) ?? verifyTicket(String(req.headers['x-sg-ticket'] ?? ''), identity?.ticketSecret ?? '');
  if (!ticket) return reply.status(401).send({ error: 'invalid_ticket' });
  return reply.send({ ok: true, nodeId: identity?.nodeId, ts: Date.now() });
});

app.put('/fragments/:oid/:idx', async (req: FastifyRequest, reply: FastifyReply) => {
  // узел выводится из эксплуатации: новые реплики не принимаем
  if (draining) return reply.status(503).send({ error: 'draining' });

  const ticket = ticketFrom(req);
  if (!ticket || ticket.op !== 'put') return reply.status(401).send({ error: 'invalid_ticket' });

  const declared = Number(req.headers['x-sg-size'] ?? 0);
  if (declared > 0 && usedBytes + declared > capacityBytes) {
    return reply.status(507).send({ error: 'insufficient_storage' });
  }

  const file = fragmentPath(ticket.oid, ticket.idx);
  const tmp = `${file}.tmp`;
  let size = 0;
  const hash = createHash('sha256');

  try {
    await pipeline(
      req.body as any,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          if (declared > 0 && size > declared + 1024) throw new Error('size_mismatch');
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
    await fsp.rename(tmp, file);
    usedBytes += size;

    if (!identity) return reply.status(500).send({ error: 'not_registered' });
    return reply.code(201).send({ ok: true, size, sha256: hash.digest('hex'), nodeId: identity.nodeId });
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    log('warn', 'fragment_put_failed', { objectId: ticket.oid, error: e instanceof Error ? e.message : String(e) });
    return reply.status(400).send({ error: 'put_failed' });
  }
});

app.get('/fragments/:oid/:idx', async (req: FastifyRequest, reply: FastifyReply) => {
  const ticket = ticketFrom(req);
  if (!ticket || ticket.op !== 'get') return reply.status(401).send({ error: 'invalid_ticket' });

  const file = fragmentPath(ticket.oid, ticket.idx);
  if (!existsSync(file)) return reply.status(404).send({ error: 'not_found' });

  const stat = statSync(file);
  reply.header('content-type', 'application/octet-stream');
  reply.header('content-length', String(stat.size));
  reply.header('cache-control', 'private, max-age=3600');
  return reply.send(createReadStream(file));
});

app.delete('/fragments/:oid/:idx', async (req: FastifyRequest, reply: FastifyReply) => {
  const ticket = ticketFrom(req);
  if (!ticket || ticket.op !== 'del') return reply.status(401).send({ error: 'invalid_ticket' });

  const file = fragmentPath(ticket.oid, ticket.idx);
  if (!existsSync(file)) return reply.status(404).send({ error: 'not_found' });
  const size = statSync(file).size;
  await fsp.rm(file, { force: true });
  usedBytes = Math.max(0, usedBytes - size);
  return reply.send({ ok: true, freed: size });
});

app.get('/stats', async (_req, reply) => {
  return reply.send({
    nodeId: identity?.nodeId ?? null,
    owner: identity?.ownerUsername ?? config.ownerUsername,
    usedBytes,
    capacityBytes,
    fragments: existsSync(FRAGMENT_DIR) ? (await fsp.readdir(FRAGMENT_DIR)).length : 0,
    uptimeSec: Math.floor(process.uptime()),
  });
});

/* ------------------------------------------------------------------ старт - */

async function main(): Promise<void> {
  mkdirSync(FRAGMENT_DIR, { recursive: true });
  usedBytes = await scanUsage();

  await app.listen({ host: '0.0.0.0', port: config.port });
  log('info', 'node_listening', { port: config.port, dataDir: config.dataDir, capacityGb: config.capacityGb });

  void ensureIdentity().then(() => {
    void heartbeat();
    setInterval(() => void heartbeat(), config.heartbeatSec * 1000).unref();
  });

  const shutdown = async (): Promise<void> => {
    log('info', 'shutting_down', {});
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((e) => {
  log('error', 'fatal', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  process.exit(1);
});
