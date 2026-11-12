/**
 * ClusterAwarenessService — текущий кластер, border-нода и хендоверы.
 *
 * Данные приходят двумя путями:
 *  - INFO/STATUS модуля по BLE (cluster_id, border, handover);
 *  - агрегат Hub `/v1/mesh/network` и события module_status.
 * Сервис только нормализует состояние; UI и чаты не меняются.
 */
import { api } from '../data/api';

export interface ClusterSnapshot {
  clusterId: string;
  border: boolean;
  handoverState: number;
  neighbors: number;
  updatedAt: number;
}

export interface MeshNetworkSummary {
  clusters: Array<{ clusterId: string; modules: number; avgRssi: number; handovers: number }>;
  onlineModules: number;
  handoversLastHour: number;
  maxOutboxDepth: number;
}

let snapshot: ClusterSnapshot = { clusterId: '', border: false, handoverState: 0, neighbors: 0, updatedAt: 0 };
const listeners = new Set<(value: ClusterSnapshot) => void>();

/** Обновление из STATUS/INFO BLE-кадра. */
export function updateClusterFromModule(raw: Record<string, unknown>): ClusterSnapshot {
  const clusterId = raw.cluster_id != null ? String(raw.cluster_id) : snapshot.clusterId;
  const next: ClusterSnapshot = {
    clusterId: clusterId === '0' ? '' : clusterId,
    border: raw.border === true || Number(raw.border) === 1,
    handoverState: Number(raw.handover ?? 0),
    neighbors: Number(raw.neighbors ?? snapshot.neighbors),
    updatedAt: Date.now(),
  };
  // Смена кластера — это хендовер; логируем только факт, без побочных эффектов.
  if (snapshot.clusterId && next.clusterId && snapshot.clusterId !== next.clusterId) {
    console.info('[cluster] handover', snapshot.clusterId, '->', next.clusterId);
  }
  snapshot = next;
  for (const listener of listeners) {
    try {
      listener(next);
    } catch {
      /* ignore */
    }
  }
  return next;
}

export function getClusterSnapshot(): ClusterSnapshot {
  return snapshot;
}

export function onClusterChange(listener: (value: ClusterSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Агрегат сети с Hub для индикаторов и диагностики. */
export async function fetchMeshNetwork(): Promise<MeshNetworkSummary> {
  try {
    return await api.meshNetwork();
  } catch {
    return { clusters: [], onlineModules: 0, handoversLastHour: 0, maxOutboxDepth: 0 };
  }
}
