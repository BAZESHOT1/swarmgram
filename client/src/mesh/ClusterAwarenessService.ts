/**
 * Отслеживание текущего кластера через данные подключённого модуля.
 * Сервис не привязан к React: UI подписывается через getSnapshot/useStore.
 */
import {
  computeClusterId,
  electBorderNodes,
  nextHandoverState,
  type BorderCandidate,
  type ClusterNeighbor,
  type HandoverState,
} from './cluster';

export interface ClusterSnapshot {
  clusterId: string;
  neighborClusters: string[];
  borderNodes: BorderCandidate[];
  ownBorder: boolean;
  handover: HandoverState;
  targetCluster: string | null;
  updatedAt: number;
}

const listeners = new Set<() => void>();

let snapshot: ClusterSnapshot = {
  clusterId: '',
  neighborClusters: [],
  borderNodes: [],
  ownBorder: false,
  handover: 'IN_CLUSTER',
  targetCluster: null,
  updatedAt: 0,
};

function emit(): void {
  snapshot = { ...snapshot, updatedAt: Date.now() };
  for (const listener of listeners) listener();
}

export const clusterAwareness = {
  getSnapshot(): ClusterSnapshot {
    return snapshot;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Обновление по beacon/INFO от носимого модуля или шлюза. */
  update(input: {
    selfMeshAddr: string;
    anchors: string[];
    neighbors: ClusterNeighbor[];
    currentRssi: number;
    targetRssi: number;
    targetStreak: number;
    preferredTarget?: string | null;
  }): ClusterSnapshot {
    // Кластер считаем по якорям, которых видим; собственный адрес тоже якорь,
    // если модуль стационарный (gateway/repeater).
    const clusterId = computeClusterId(input.anchors);
    const neighborClusters = [...new Set(input.neighbors.map((n) => n.clusterId).filter((id) => id && id !== clusterId))];
    const borderNodes = electBorderNodes(input.neighbors);
    const ownBorder = borderNodes.some((b) => b.meshAddr === input.selfMeshAddr);
    const targetCluster = input.preferredTarget ?? neighborClusters[0] ?? null;
    const handover = nextHandoverState(snapshot.handover, {
      currentCluster: clusterId,
      targetCluster: targetCluster ?? '',
      currentRssi: input.currentRssi,
      targetRssi: input.targetRssi,
      targetStreak: input.targetStreak,
      borderAvailable: borderNodes.some(
        (b) => b.clusterA === targetCluster || b.clusterB === targetCluster,
      ),
      now: Date.now(),
    });

    snapshot = {
      clusterId,
      neighborClusters,
      borderNodes,
      ownBorder,
      handover,
      targetCluster,
      updatedAt: Date.now(),
    };
    emit();
    return snapshot;
  },

  reset(): void {
    snapshot = {
      clusterId: '',
      neighborClusters: [],
      borderNodes: [],
      ownBorder: false,
      handover: 'IN_CLUSTER',
      targetCluster: null,
      updatedAt: Date.now(),
    };
    emit();
  },
};
