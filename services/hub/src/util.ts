import type { FastifyReply, FastifyRequest } from 'fastify';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (msg = 'bad_request', details?: unknown) => new ApiError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'unauthorized') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (msg = 'forbidden') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'not_found') => new ApiError(404, 'not_found', msg);
export const conflict = (msg = 'conflict') => new ApiError(409, 'conflict', msg);
export const tooMany = (msg = 'too_many_requests') => new ApiError(429, 'too_many_requests', msg);
export const serviceUnavailable = (msg = 'service_unavailable') => new ApiError(503, 'service_unavailable', msg);

/* ------------------------------------------------------------------- логи -- */

type Level = 'info' | 'warn' | 'error' | 'debug';

export function log(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    service: 'hub',
    ...(meta ?? {}),
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

/* -------------------------------------------------------------- rate limit */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Простой in-memory лимитер (token bucket). Для кластера заменить на Redis. */
export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  b.count += 1;
  if (b.count > limit) throw tooMany('too_many_requests');
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
  }
}

/* --------------------------------------------------------------- валидация */

export const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function str(value: unknown, field: string, opts: { min?: number; max?: number } = {}): string {
  if (typeof value !== 'string') throw badRequest(`${field}_required`);
  const v = value.trim();
  if (opts.min && v.length < opts.min) throw badRequest(`${field}_too_short`);
  if (opts.max && v.length > opts.max) throw badRequest(`${field}_too_long`);
  return v;
}

export function clientIp(req: FastifyRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip ?? '0.0.0.0';
}

export function errorHandler(err: unknown, _req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ApiError) {
    if (err.status >= 400) {
      log('warn', 'api_error', {
        status: err.status,
        code: err.code,
        message: err.message,
        url: _req.url,
        ip: _req.ip,
      });
    }
    void reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    return;
  }
  log('error', 'unhandled_error', { error: err instanceof Error ? err.message : String(err) });
  void reply.status(500).send({ error: 'internal_error' });
}
