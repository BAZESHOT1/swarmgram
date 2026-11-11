/**
 * Плавный вывод узла из эксплуатации.
 *
 * Порядок:
 *  1. узел получает статус 'draining' (новые реплики на него не выбираются,
 *     т.к. pickNodes берёт только status='online');
 *  2. для каждого объекта, лежащего на узле, запускается repairObject —
 *     он досоздаёт копии на живых узлах;
 *  3. если у каждого активного объекта появилась живая реплика вне узла,
 *     фрагменты узла удаляются, статус → 'offline', drained_at = now();
 *  4. иначе данные НЕ трогаем: узел остаётся 'draining', пишем drain_blocked.
 *
 * Фонового интервала нет: drain — разовая асинхронная задача, запускаемая
 * из POST /v1/nodes/:id/drain. Повторные вызовы защищены inFlight-набором.
 */
import { one, query, tx } from './db.js';
import { nodeEvent } from './nodes.js';
import { repairObject } from './replicator.js';
import { log } from './util.js';

const inFlight = new Set<string>();

/** Выполняется ли сейчас вывод конкретного узла (для диагностики/тестов). */
export function isDrainInFlight(nodeId: string): boolean {
  return inFlight.has(nodeId);
}

export async function drainNode(nodeId: string): Promise<void> {
  if (inFlight.has(nodeId)) {
    log('debug', 'node_drain_already_running', { nodeId });
    return;
  }
  inFlight.add(nodeId);

  try {
    const node = await one<{ id: string; status: string; drain_requested_at: string | null; drained_at: string | null }>(
      'SELECT id, status, drain_requested_at, drained_at FROM nodes WHERE id = $1',
      [nodeId],
    );
    if (!node) {
      log('warn', 'node_drain_missing', { nodeId });
      return;
    }
    if (node.drained_at) {
      log('info', 'node_drain_already_done', { nodeId });
      return;
    }
    if (node.status === 'banned') {
      log('warn', 'node_drain_banned', { nodeId });
      return;
    }

    // Объекты, у которых на этом узле есть фрагменты. Удалённые объекты
    // (state <> 'active') не требуют сохранности — их вычищает monitor.
    const objects = await query<{ object_id: string }>(
      `SELECT DISTINCT f.object_id
         FROM fragments f JOIN objects o ON o.id = f.object_id
        WHERE f.node_id = $1 AND o.state = 'active'`,
      [nodeId],
    );

    log('info', 'node_drain_started', { nodeId, objects: objects.length });

    let repairFailed = 0;
    for (const { object_id } of objects) {
      try {
        await repairObject(object_id);
      } catch (e) {
        repairFailed += 1;
        log('warn', 'node_drain_repair_failed', {
          nodeId,
          objectId: object_id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // Проверяем, что у каждого активного объекта есть хотя бы одна живая
    // реплика ВНЕ выводимого узла.
    const blocked = await query<{ object_id: string }>(
      `SELECT DISTINCT f.object_id
         FROM fragments f JOIN objects o ON o.id = f.object_id
        WHERE f.node_id = $1 AND o.state = 'active'
          AND NOT EXISTS (
            SELECT 1
              FROM fragments g JOIN nodes n ON n.id = g.node_id
             WHERE g.object_id = f.object_id
               AND g.node_id <> $1
               AND g.state = 'ok'
               AND n.status = 'online'
          )`,
      [nodeId],
    );

    if (blocked.length) {
      const ids = blocked.slice(0, 10).map((r) => r.object_id).join(', ');
      await nodeEvent(
        nodeId,
        'drain_blocked',
        `${blocked.length} object(s) have no live replica outside this node: ${ids}`,
      );
      log('warn', 'node_drain_blocked', {
        nodeId,
        blocked: blocked.length,
        objects: ids,
        repairFailed,
      });
      return;
    }

    // Все копии продублированы — можно сносить локальные фрагменты.
    await tx(async ({ query: q }) => {
      await q('DELETE FROM fragments WHERE node_id = $1', [nodeId]);
      await q(
        `UPDATE nodes
            SET status = 'offline',
                drained_at = now(),
                used_bytes = 0,
                free_bytes = capacity_bytes
          WHERE id = $1`,
        [nodeId],
      );
    });
    await nodeEvent(nodeId, 'drained', `${objects.length} object(s) migrated`);

    log('info', 'node_drained', { nodeId, objects: objects.length, repairFailed });
  } catch (e) {
    log('error', 'node_drain_failed', {
      nodeId,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  } finally {
    inFlight.delete(nodeId);
  }
}
