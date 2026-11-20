/**
 * Мониторинг узлов: перевод в degraded/offline по heartbeat,
 * проверка доступности публичного URL, суточное начисление кредитов.
 */
import { config } from './config.js';
import { query } from './db.js';
import { adjustReputation, bumpNodeUsage, deleteFragment, nodeEvent, pingNode } from './nodes.js';
import { log } from './util.js';

/** Удаляем объекты, помеченные пользователем: сгружаем реплики с узлов. */
async function purgeDeletedObjects(): Promise<void> {
  const objs = await query<{ id: string; owner_id: string; size_bytes: number }>(
    `SELECT o.id, o.owner_id, o.size_bytes FROM objects o WHERE o.state = 'deleted' LIMIT 25`,
  );
  for (const o of objs) {
    const frags = await query<{ index: number; id: string; node_id: string; public_url: string; ticket_secret: string }>(
      `SELECT f.index, n.id, f.node_id, n.public_url, n.ticket_secret
         FROM fragments f JOIN nodes n ON n.id = f.node_id WHERE f.object_id = $1`,
      [o.id],
    );
    for (const f of frags) {
      try {
        await deleteFragment(f, o.id, f.index, o.owner_id);
        await bumpNodeUsage(f.node_id, -o.size_bytes);
      } catch (e) {
        log('warn', 'purge_fragment_failed', { nodeId: f.node_id, error: String(e).slice(0, 160) });
      }
    }
    await query('DELETE FROM objects WHERE id = $1', [o.id]);
    log('info', 'object_purged', { objectId: o.id, replicas: frags.length });
  }
}

let ticks = 0;

async function sweepStatuses(): Promise<void> {
  const degraded = await query(
    `UPDATE nodes SET status = 'degraded'
      WHERE status IN ('online','pending')
        AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - ($1 || ' milliseconds')::interval)
      RETURNING id, name`,
    [String(config.nodeDegradedAfterMs)],
  );
  for (const n of degraded) {
    await nodeEvent(n.id, 'degraded', 'heartbeat timeout');
    await adjustReputation(n.id, -1);
  }

  const offline = await query(
    `UPDATE nodes SET status = 'offline'
      WHERE status IN ('online','degraded','pending')
        AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - ($1 || ' milliseconds')::interval)
      RETURNING id, name`,
    [String(config.nodeOfflineAfterMs)],
  );
  for (const n of offline) {
    await nodeEvent(n.id, 'offline', 'heartbeat lost');
    await adjustReputation(n.id, -3);
    log('warn', 'node_offline', { nodeId: n.id, name: n.name });
  }
}

/** Hub сам проверяет, что узел реально доступен извне (важно для узлов за NAT). */
async function pingOnlineNodes(): Promise<void> {
  const nodes = await query<{ id: string; public_url: string; ticket_secret: string; status: string }>(
    `SELECT id, public_url, ticket_secret, status FROM nodes
      WHERE status IN ('online','degraded') AND public_url <> ''
        AND (last_ping_ok_at IS NULL OR last_ping_ok_at < now() - interval '60 seconds')`,
  );

  for (const node of nodes) {
    const { ok, ms } = await pingNode(node);
    if (ok) {
      await query('UPDATE nodes SET last_ping_ok_at = now(), reputation = LEAST(100, reputation + 1) WHERE id = $1', [
        node.id,
      ]);
    } else {
      await query(
        `UPDATE nodes SET status = CASE WHEN status = 'online' THEN 'degraded' ELSE status END,
                reputation = GREATEST(0, reputation - 2)
          WHERE id = $1`,
        [node.id],
      );
      await nodeEvent(node.id, 'ping_failed', `unreachable in ${ms}ms`);
      await adjustReputation(node.id, 0);
    }
  }
}

/** Начисление кредитов владельцам узлов: GB·день + аптайм. */
export async function accrueCredits(): Promise<void> {
  const rows = await query<{ node_id: string; owner_id: string; bytes_stored: number; uptime_seconds: number }>(
    `SELECT nc.node_id, n.owner_id,
            COALESCE(MAX(nc.bytes_stored),0) AS bytes_stored,
            COALESCE(SUM(nc.uptime_seconds),0) AS uptime_seconds
       FROM node_contributions nc JOIN nodes n ON n.id = nc.node_id
      WHERE n.owner_id IS NOT NULL
      GROUP BY nc.node_id, n.owner_id`,
  );

  for (const r of rows) {
    const credits = (Number(r.bytes_stored) / 1024 ** 3) * 1 + Number(r.uptime_seconds) / 21600;
    if (credits <= 0) continue;
    const exists = await query('SELECT 1 FROM ledger WHERE user_id = $1 AND type = $2 AND meta->>\'nodeId\' = $3 AND created_at > current_date - 1', [
      r.owner_id,
      'node_contribution',
      r.node_id,
    ]);
    if (exists.length) continue;
    await query('INSERT INTO ledger (user_id, type, amount, meta) VALUES ($1,$2,$3,$4)', [
      r.owner_id,
      'node_contribution',
      credits,
      { nodeId: r.node_id },
    ]);
  }
}

/**
 * Заготовки загрузок (objects.state='pending'), которые так и не подтвердили: телефон не смог
 * писать на узел по http и загрузил файл через Hub. Они держат «обещанные» фрагменты на узлах —
 * удаляем всё старше часа, на что не ссылаются сообщения/комментарии/аватары/фоны.
 */
async function purgeStalePending(): Promise<void> {
  const rows = await query<{ id: string }>(
    `DELETE FROM objects o
      WHERE o.state = 'pending' AND o.created_at < now() - interval '1 hour'
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.object_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM post_comments pc WHERE pc.object_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_object_id = o.id OR u.background_object_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.avatar_object_id = o.id OR c.background_object_id = o.id)
      RETURNING o.id`,
  );
  if (rows.length) log('info', 'stale_pending_purged', { count: rows.length });
}

export function startMonitor(): void {
  const timer = setInterval(() => {
    ticks += 1;
    void (async () => {
      try {
        await sweepStatuses();
        await purgeDeletedObjects();
        await pingOnlineNodes();
        if (ticks % 180 === 0) await accrueCredits(); // ~раз в час
        if (ticks % 45 === 1) await purgeStalePending(); // ~раз в 15 минут
      } catch (e) {
        log('error', 'monitor_failed', { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, config.monitorIntervalMs);
  timer.unref();
  log('info', 'monitor_started', { intervalMs: config.monitorIntervalMs });
}
