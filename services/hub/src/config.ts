import { randomBytes } from 'node:crypto';
import { b64u, hmac, unb64u } from './crypto.js';

/* ------------------------------------------------------------------ конфиг */

function str(name: string, def?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (def !== undefined) return def;
  throw new Error(`Missing required env: ${name}`);
}

function num(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function bool(name: string, def: boolean): boolean {
  const v = (process.env[name] ?? '').toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return def;
}

function ensureSecret(): string {
  let s = process.env.HUB_JWT_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('HUB_JWT_SECRET must be set in production');
    }
    s = randomBytes(32).toString('hex');
  }
  return s;
}

export const config = {
  nodeEnv: str('NODE_ENV', 'development'),
  port: num('PORT', 8080),
  publicUrl: str('HUB_PUBLIC_URL', 'http://localhost:8080').replace(/\/+$/, ''),
  databaseUrl: str('DATABASE_URL', 'postgres://swarm:swarm@localhost:5432/swarm'),
  jwtSecret: ensureSecret(),
  adminToken: str('HUB_ADMIN_TOKEN', ''),

  /** Жёсткий лимит смены username — 90 дней. */
  usernameChangeCooldownDays: 90,
  /** Старое имя не доступно для захвата другими, месяцев. */
  usernameReserveMonths: 12,

  replicas: Math.max(1, Math.min(num('HUB_REPLICAS', 3), 5)),
  maxUploadBytes: num('HUB_MAX_UPLOAD_MB', 25) * 1024 * 1024,
  ticketTtlSec: 300,

  /** Разрешить регистрацию узлов без claim-токена (только для dev). */
  allowOpenNodes: bool('HUB_ALLOW_OPEN_NODES', false),

  nodeHeartbeatIntervalSec: 30,
  nodeDegradedAfterMs: 90_000,
  nodeOfflineAfterMs: 300_000,
  monitorIntervalMs: 20_000,
  repairIntervalMs: 60_000,

  tmpDir: str('TMP_DIR', '/tmp/swarm'),
  sqlDir: str('SQL_DIR', '/app/sql'),

  smtp: {
    host: process.env.SMTP_HOST || '',
    port: num('SMTP_PORT', 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'Kinto <noreply@swarmgram.local>',
  },
} as const;

export type Config = typeof config;

/* ------------------------------------------------------------------ тикеты */

export type TicketOp = 'get' | 'put' | 'del';

export interface Ticket {
  v: 1;
  op: TicketOp;
  /** object id */
  oid: string;
  /** номер фрагмента */
  idx: number;
  /** субъект (user id) */
  sub: string;
  exp: number;
}

/** Маршрутный билет: узел проверяет его сам, Hub в отдаче данных не участвует. */
export function mintTicket(secret: string, ticket: Omit<Ticket, 'v' | 'exp'> & { ttlSec?: number }): string {
  const payload: Ticket = {
    v: 1,
    op: ticket.op,
    oid: ticket.oid,
    idx: ticket.idx,
    sub: ticket.sub,
    exp: Math.floor(Date.now() / 1000) + (ticket.ttlSec ?? config.ticketTtlSec),
  };
  const body = b64u(JSON.stringify(payload));
  return `${body}.${hmac(secret, body).toString('base64url')}`;
}

export function readTicket(token: string, secret: string): Ticket | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (hmac(secret, body).toString('base64url') !== sig) return null;
  try {
    const t = JSON.parse(unb64u(body).toString('utf8')) as Ticket;
    if (t.exp * 1000 < Date.now()) return null;
    return t;
  } catch {
    return null;
  }
}
