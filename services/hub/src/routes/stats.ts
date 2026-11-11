/** Публичная статистика сети и состояние главного сервера. */
import type { FastifyPluginAsync } from 'fastify';
import { one, query } from '../db.js';
import { onlineUsers } from '../realtime.js';

const statsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/stats', async (_req, reply) => {
    const users = await one<{ c: number }>("SELECT COUNT(*)::int AS c FROM users WHERE status = 'active'");
    const nodesTotal = await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM nodes');
    const nodesOnline = await one<{ c: number }>("SELECT COUNT(*)::int AS c FROM nodes WHERE status = 'online'");
    const capacity = await one<{ s: number }>('SELECT COALESCE(SUM(capacity_bytes),0) AS s FROM nodes');
    const stored = await one<{ s: number }>('SELECT COALESCE(SUM(size_bytes),0) AS s FROM objects WHERE deleted_at IS NULL');
    const messages = await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM messages');
    const objects = await one<{ c: number }>('SELECT COUNT(*)::int AS c FROM objects WHERE deleted_at IS NULL');

    return reply.send({
      users: users?.c ?? 0,
      nodes: { total: nodesTotal?.c ?? 0, online: nodesOnline?.c ?? 0 },
      capacityBytes: Number(capacity?.s ?? 0),
      storedBytes: Number(stored?.s ?? 0),
      objects: objects?.c ?? 0,
      messages: messages?.c ?? 0,
      onlineUsers: onlineUsers(),
    });
  });

  app.get('/stats/nodes', async (_req, reply) => {
    const rows = await query<{ region: string; total: number; online: number; capacity: number }>(
      `SELECT COALESCE(region,'unknown') AS region,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'online')::int AS online,
              COALESCE(SUM(capacity_bytes),0) AS capacity
         FROM nodes GROUP BY 1 ORDER BY total DESC`,
    );
    return reply.send(rows);
  });
};

export default statsRoutes;
