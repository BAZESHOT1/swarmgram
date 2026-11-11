/**
 * Репликатор и целостность.
 *
 * Каждый объект живёт в `replicas_desired` (по умолчанию 3) полномсловых копиях.
 * Падение узла → копия восстанавливается с живой реплики на новый узел,
 * побайтовая целостность проверяется по SHA-256. Реплика с несовпадением хэша
 * считается скомпрометированной и вычёркивается.
 */
import { createHash } from 'node:crypto';
import { config } from './config.js';
import { one, query } from './db.js';
import { bumpNodeUsage, copyFragment, getFragment, nodeEvent, pickNodes, adjustReputation, type NodeRow } from './nodes.js';
import { log } from './util.js';

export async function repairObject(objectId: string): Promise<number> {
  const obj = await one<{ id: string; owner_id: string; size_bytes: number; sha256: string; replicas_desired: number; state: string }>(
    'SELECT id, owner_id, size_bytes, sha256, replicas_desired, state FROM objects WHERE id = $1 AND state = $2',
    [objectId, 'active'],
  );
  if (!obj) return 0;

  const frags = await query<Frags>(
    `SELECT f.node_id, f.index, f.state, n.id, n.public_url, n.ticket_secret, n.status,
            n.capacity_bytes, n.used_bytes, n.free_bytes, n.reputation, n.owner_id, n.name, n.region, n.subnet, n.hw_hash
       FROM fragments f JOIN nodes n ON n.id = f.node_id
      WHERE f.object_id = $1`,
    [objectId],
  );

  const good = frags.filter((f) => f.state === 'ok' && f.status === 'online');
  const need = obj.replicas_desired - good.length;
  if (need <= 0) return 0;

  if (!good.length) {
    log('error', 'object_no_live_replica', { objectId });
    return 0;
  }

  let moved = 0;
  let attempts = 0;
  let nextIndex = Math.max(...frags.map((f) => f.index)) + 1;

  while (moved < need && attempts < good.length + need) {
    attempts += 1;
    const target = (await pickNodes(1, obj.size_bytes, frags.map((f) => f.node_id)))[0];
    if (!target) {
      log('warn', 'repair_no_target_node', { objectId });
      break;
    }
    const source = good[attempts % good.length] as Frags;
    try {
      const res = await copyFragment(source, target as NodeRow, objectId, source.index, obj.owner_id, obj.sha256);
      if (!res.ok) {
        await query(`UPDATE fragments SET state = 'corrupt' WHERE object_id = $1 AND node_id = $2 AND index = $3`, [
          objectId,
          source.id,
          source.index,
        ]);
        await nodeEvent(source.id, 'replica_corrupt', `${objectId} (index ${source.index})`);
        await adjustReputation(source.id, -5);
        const i = good.findIndex((g) => g.id === source.id);
        if (i >= 0) good.splice(i, 1);
        if (!good.length) {
          log('error', 'object_unrecoverable', { objectId });
          break;
        }
        nextIndex += 1;
        continue;
      }
      const inserted = await query(
        `INSERT INTO fragments (object_id, node_id, index, size_bytes, sha256)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (object_id, node_id, index) DO NOTHING
         RETURNING id`,
        [objectId, target.id, nextIndex, res.size, res.sha256],
      );
      if (inserted?.length) {
        await bumpNodeUsage(target.id, obj.size_bytes);
        await nodeEvent(target.id, 'replica_restored', objectId);
        moved += 1;
        nextIndex += 1;
      }
    } catch (e) {
      log('warn', 'repair_failed', { objectId, target: target.id, error: String(e).slice(0, 200) });
    }
  }

  if (moved) log('info', 'object_repaired', { objectId, moved, live: good.length });
  return moved;
}

interface Frags extends NodeRow {
  node_id: string;
  index: number;
  state: string;
}

/**
 * Выборочная верификация: Hub стримит случайный фрагмент и сверяет хэш.
 * Несовпадение = реплика битая/подменённая: она вычёркивается.
 */
export async function auditReplicas(limit = 2): Promise<void> {
  const rows = await query<{ object_id: string; node_id: string; index: number; sha256: string; state: string; public_url: string; ticket_secret: string; id: string }>(
    `SELECT f.object_id, f.node_id, f.index, f.sha256, f.state,
            n.public_url, n.ticket_secret, n.id
       FROM fragments f JOIN nodes n ON n.id = f.node_id
       WHERE f.state = 'ok' AND n.status = 'online'
      ORDER BY random() LIMIT $1`,
    [limit],
  );

  for (const r of rows) {
    try {
      const started = Date.now();
      const stream = await getFragment(r, r.object_id, r.index, 'audit');
      const hash = createHash('sha256');
      await (async () => {
        for await (const chunk of stream) hash.update(chunk as Buffer);
      })();
      const sha = hash.digest('hex');
      const elapsed = Date.now() - started;
      if (sha !== r.sha256) {
        await query(`UPDATE fragments SET state = 'corrupt' WHERE object_id = $1 AND node_id = $2 AND index = $3`, [
          r.object_id,
          r.node_id,
          r.index,
        ]);
        await nodeEvent(r.node_id, 'audit_corrupt', `${r.object_id} (${r.index}) diverged in ${elapsed}ms`);
        await adjustReputation(r.node_id, -5);
        log('warn', 'audit_replica_corrupt', { objectId: r.object_id, nodeId: r.node_id, elapsed });
        await repairObject(r.object_id);
      } else {
        await query('UPDATE nodes SET reputation = LEAST(100, reputation + 1) WHERE id = $1', [r.node_id]);
      }
    } catch (e) {
      log('warn', 'audit_fragment_failed', { objectId: r.object_id, nodeId: r.node_id, error: String(e).slice(0, 160) });
    }
  }
}

async function sweep(): Promise<void> {
  const rows = await query<{ id: string; replicas_desired: number; live: number }>(
    `SELECT o.id, o.replicas_desired,
            COALESCE((SELECT COUNT(*) FROM fragments f JOIN nodes n ON n.id = f.node_id
                       WHERE f.object_id = o.id AND n.status = 'online' AND f.state = 'ok'),0)::int AS live
       FROM objects o
      WHERE o.state = 'active'`,
  );

  const broken = rows.filter((r) => r.live < r.replicas_desired);
  if (!broken.length) return;
  log('info', 'repair_sweep', { candidates: broken.length });

  for (const r of broken.slice(0, 25)) {
    try {
      await repairObject(r.id);
    } catch (e) {
      log('error', 'repair_object_failed', { objectId: r.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

export function startReplicator(): void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        await auditReplicas(2);
      } catch (e) {
        log('error', 'audit_failed', { error: String(e).slice(0, 200) });
      }
      try {
        await sweep();
      } catch (e) {
        log('error', 'replicator_sweep_failed', { error: String(e).slice(0, 200) });
      }
    })();
  }, config.repairIntervalMs);
  timer.unref();
  log('info', 'replicator_started', { intervalMs: config.repairIntervalMs, replicas: config.replicas });
}
