/** Детерминированный Cluster ID и выбор Border Node (зеркало прошивки). */

export const HANDOVER_THRESHOLD = -85;
export const HANDOVER_TARGET = -75;
export const HANDOVER_HYSTERESIS = 3;
export const BORDER_MIN_RSSI = -95;
export const BORDER_MAX_QUEUE = 8;
export const BORDER_COOLDOWN_MS = 60_000;

export interface ClusterNeighbor {
  meshAddr: string;
  clusterId: string;
  rssi: number;
  queueDepth: number;
  anchor?: boolean;
  lastSeen: number;
}

export interface BorderCandidate {
  meshAddr: string;
  clusterA: string;
  clusterB: string;
  score: number;
  primary: boolean;
}

/** FNV-1a 32-bit → 8 hex chars. */
export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Cluster ID — хеш отсортированного списка якорных mesh-адресов. */
export function computeClusterId(anchorMeshAddrs: string[]): string {
  const anchors = [...new Set(anchorMeshAddrs.map((a) => a.trim().toLowerCase()).filter(Boolean))].sort();
  return fnv1a32(anchors.join('|'));
}

/** Выбор до 2 Border Node между двумя кластерами. */
export function electBorderNodes(neighbors: ClusterNeighbor[], now = Date.now()): BorderCandidate[] {
  const byCluster = new Map<string, ClusterNeighbor[]>();
  for (const n of neighbors) {
    if (now - n.lastSeen > 12_000) continue;
    const list = byCluster.get(n.clusterId) ?? [];
    list.push(n);
    byCluster.set(n.clusterId, list);
  }
  const clusters = [...byCluster.keys()];
  const candidates: BorderCandidate[] = [];
  if (clusters.length < 2) return candidates;

  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      const a = byCluster.get(clusters[i])!;
      const b = byCluster.get(clusters[j])!;
      const pair: BorderCandidate[] = [];
      for (const na of a) {
        for (const nb of b) {
          if (na.meshAddr === nb.meshAddr) continue;
          // Модуль-кандидат должен видеть оба кластера сам: считаем по худшему RSSI.
          const rssi = Math.min(na.rssi, nb.rssi);
          const queue = Math.max(na.queueDepth, nb.queueDepth);
          if (rssi < BORDER_MIN_RSSI || queue > BORDER_MAX_QUEUE) continue;
          pair.push({
            meshAddr: na.meshAddr,
            clusterA: clusters[i],
            clusterB: clusters[j],
            score: rssi - queue * 4,
            primary: false,
          });
        }
      }
      pair.sort((x, y) => y.score - x.score);
      // Дедупликация по адресу, top-2: основной + резервный.
      const picked: BorderCandidate[] = [];
      for (const candidate of pair) {
        if (picked.some((p) => p.meshAddr === candidate.meshAddr)) continue;
        picked.push(candidate);
        if (picked.length === 2) break;
      }
      if (picked[0]) picked[0].primary = true;
      candidates.push(...picked);
    }
  }
  return candidates;
}

export type HandoverState = 'IN_CLUSTER' | 'PENDING' | 'TRANSITIONAL' | 'COMPLETE' | 'RETRY';

export interface HandoverInput {
  currentCluster: string;
  targetCluster: string;
  currentRssi: number;
  targetRssi: number;
  /** Сколько beacon-интервалов подряд цель сильнее порога. */
  targetStreak: number;
  borderAvailable: boolean;
  now: number;
  lastRetryAt?: number;
}

/** Простой детерминированный переход состояния хендовера. */
export function nextHandoverState(state: HandoverState, input: HandoverInput): HandoverState {
  const strongTarget = input.targetRssi >= HANDOVER_TARGET && input.targetStreak >= HANDOVER_HYSTERESIS;
  const weakCurrent = input.currentRssi <= HANDOVER_THRESHOLD;
  if (state === 'IN_CLUSTER') {
    return weakCurrent && strongTarget && input.borderAvailable ? 'PENDING' : 'IN_CLUSTER';
  }
  if (state === 'PENDING') {
    if (!input.borderAvailable) {
      return input.now - (input.lastRetryAt ?? 0) > 15_000 ? 'RETRY' : 'PENDING';
    }
    return 'TRANSITIONAL';
  }
  if (state === 'TRANSITIONAL') return 'COMPLETE';
  if (state === 'COMPLETE' || state === 'RETRY') return 'IN_CLUSTER';
  return state;
}
