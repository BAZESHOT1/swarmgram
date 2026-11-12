/**
 * Mesh network control plane: DeviceRegistry, HandoverLog, TelemetryAggregator.
 *
 * Идентичность — mesh_addr (заводской MAC Wi-Fi STA). BLE MAC — алиас.
 * Модуль присылает телеметрию и события хендовера через шлюз; Hub
 * агрегирует их для мониторинга сети и диагностики в приложении.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { one, query } from '../db.js';
import { requireModule } from './modules.js';
import { str } from '../util.js';

const meshRoutes: FastifyPluginAsync = async (app) => {
  /** Реестр устройств по MAC (для отладки и UI). */
  app.get('/devices', { onRequest: [requireAuth()] }, async (req) => {
    const me = req.auth!.userId;
    return query(
      `SELECT d.id, d.mesh_addr AS "meshAddr", d.ble_mac AS "bleMac", d.public_id AS "publicId",
              d.role, d.transport, d.kind, d.status, d.last_seen_at AS "lastSeenAt",
              d.cluster_id AS "clusterId", d.border, d.transports, d.neighbors, d.firmware
         FROM mesh_devices d
        WHERE d.user_id = $1
        ORDER BY d.last_seen_at DESC NULLS LAST`,
      [me],
    );
  });

  /** Телеметрия модуля: кластер, соседи, RSSI, outbox, hue. */
  app.post('/mesh/telemetry', { onRequest: [requireModule()] }, async (req, reply) => {
    const mod = req.module!;
    const body = (req.body ?? {}) as {
      clusterId?: string | number;
      cluster_id?: string | number;
      neighbors?: number;
      avgRssi?: number;
      avg_rssi?: number;
      outboxDepth?: number;
      outbox_depth?: number;
      hues?: string[];
      transports?: string[];
      border?: boolean | number;
      meshAddr?: string;
    };
    const clusterId = String(body.clusterId ?? body.cluster_id ?? '').slice(0, 24);
    const neighbors = Math.max(0, Math.min(255, Number(body.neighbors ?? 0) | 0));
    const avgRssi = Math.trunc(Number(body.avgRssi ?? body.avg_rssi ?? 0)) | 0;
    const outboxDepth = Math.max(0, Math.min(10000, Number(body.outboxDepth ?? body.outbox_depth ?? 0) | 0));
    const hues = Array.isArray(body.hues) ? body.hues.filter((h): h is string => typeof h === 'string').slice(0, 8) : [];
    const transports = Array.isArray(body.transports)
      ? body.transports.filter((h): h is string => typeof h === 'string').slice(0, 8)
      : hues;
    const meshAddr = str(body.meshAddr ?? mod.hardwareId, 'meshAddr', { max: 64 }).toLowerCase();
    const border = body.border === true || Number(body.border ?? 0) !== 0;

    await query(
      `INSERT INTO telemetry_reports (module_id, mesh_addr, cluster_id, neighbors, avg_rssi, outbox_depth, hues)
       VALUES ($1,$2,$3,$4,$5,$6,$7::text[])`,
      [mod.moduleId, meshAddr, clusterId, neighbors, avgRssi, outboxDepth, hues],
    );
    await query(
      `UPDATE modules SET cluster_id = $2, neighbors = $3, border = $4,
              transports = CASE WHEN $5::text[] = '{}' THEN transports ELSE $5::text[] END,
              last_seen_at = now(), status = 'online', updated_at = now()
        WHERE id = $1`,
      [mod.moduleId, clusterId, neighbors, border, transports],
    ).catch(() => undefined);

    return reply.send({ ok: true, meshAddr, clusterId });
  });

  /** Лог хендовера: request | accept | complete | abort | retry | reject. */
  app.post('/mesh/handover', { onRequest: [requireModule()] }, async (req, reply) => {
    const mod = req.module!;
    const body = (req.body ?? {}) as {
      meshAddr?: string;
      fromCluster?: string | number;
      toCluster?: string | number;
      state?: string;
    };
    const allowed = new Set(['request', 'accept', 'complete', 'abort', 'retry', 'reject']);
    const state = allowed.has(String(body.state ?? '')) ? String(body.state) : 'request';
    const meshAddr = str(body.meshAddr ?? mod.hardwareId, 'meshAddr', { max: 64 }).toLowerCase();
    const fromCluster = String(body.fromCluster ?? '').slice(0, 24);
    const toCluster = String(body.toCluster ?? '').slice(0, 24);

    const row = await one<{ id: string }>(
      `INSERT INTO handover_events (module_id, mesh_addr, from_cluster, to_cluster, state)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [mod.moduleId, meshAddr, fromCluster, toCluster, state],
    );

    // Аномалия: больше 20 хендоверов за 10 минут у одного модуля.
    const burst = await one<{ count: string }>(
      `SELECT count(*)::text AS count FROM handover_events
        WHERE module_id = $1 AND state = 'request' AND created_at > now() - interval '10 minutes'`,
      [mod.moduleId],
    );
    if (Number(burst?.count ?? 0) > 20) {
      req.log.warn({ moduleId: mod.moduleId, meshAddr, count: burst?.count }, 'handover_burst');
    }
    return reply.send({ ok: true, id: row?.id ?? null });
  });

  /** Агрегат сети для приложения: кластеры, RSSI, хендоверы, outbox. */
  app.get('/mesh/network', { onRequest: [requireAuth()] }, async (req) => {
    const me = req.auth!.userId;
    const clusters = await query<{ clusterId: string; modules: string; avgRssi: string; handovers: string }>(
      `WITH mine AS (
         SELECT id, COALESCE(NULLIF(cluster_id, ''), 'none') AS cluster_id FROM modules WHERE owner_id = $1
       ), h AS (
         SELECT coalesce(nullif(split_part(m.cluster_id, ',', 1), ''), 'none') AS cluster_id, count(*) AS c
           FROM handover_events e
           JOIN modules m ON m.id = e.module_id
          WHERE m.owner_id = $1 AND e.created_at > now() - interval '1 hour'
          GROUP BY 1
       )
       SELECT mine.cluster_id AS "clusterId",
              count(DISTINCT mine.id)::text AS modules,
              coalesce(round(avg(NULLIF(m.rssi, 0))), 0)::text AS "avgRssi",
              coalesce((SELECT c FROM h WHERE h.cluster_id = mine.cluster_id), 0)::text AS handovers
         FROM mine JOIN modules m ON m.id = mine.id
        GROUP BY mine.cluster_id
        ORDER BY mine.cluster_id`,
      [me],
    );
    const totals = await one<{ online: string; handovers: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM modules WHERE owner_id = $1 AND last_seen_at > now() - interval '150 seconds')::text AS online,
         (SELECT count(*) FROM handover_events e JOIN modules m ON m.id = e.module_id
           WHERE m.owner_id = $1 AND e.created_at > now() - interval '1 hour')::text AS handovers,
         (SELECT coalesce(max(outbox_depth), 0) FROM telemetry_reports t JOIN modules m ON m.id = t.module_id
           WHERE m.owner_id = $1 AND t.created_at > now() - interval '5 minutes')::text AS outbox`,
      [me],
    );
    return {
      clusters,
      onlineModules: Number(totals?.online ?? 0),
      handoversLastHour: Number(totals?.handovers ?? 0),
      maxOutboxDepth: Number(totals?.outbox ?? 0),
    };
  });
};

export default meshRoutes;
