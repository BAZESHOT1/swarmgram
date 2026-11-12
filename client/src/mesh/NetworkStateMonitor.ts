/**
 * NetworkStateMonitor — три состояния транспорта:
 *  - ONLINE_SERVER: есть прямой интернет (WebSocket/HTTP живы);
 *  - ONLINE_MESH: интернета нет, но есть получатель в mesh (ACK/peer);
 *  - OFFLINE_QUEUED: ни сервера, ни mesh — сообщения в outbox.
 */
import { useStore } from '../state/useStore';
import { getOutboxDepth } from './OutboxSyncService';

export type NetworkState = 'ONLINE_SERVER' | 'ONLINE_MESH' | 'OFFLINE_QUEUED';

export interface NetworkSnapshot {
  state: NetworkState;
  serverOnline: boolean;
  meshOnline: boolean;
  outboxDepth: number;
  updatedAt: number;
}

let snapshot: NetworkSnapshot = {
  state: 'OFFLINE_QUEUED',
  serverOnline: false,
  meshOnline: false,
  outboxDepth: 0,
  updatedAt: 0,
};
const listeners = new Set<(value: NetworkSnapshot) => void>();

function computeState(serverOnline: boolean, meshOnline: boolean): NetworkState {
  if (serverOnline) return 'ONLINE_SERVER';
  if (meshOnline) return 'ONLINE_MESH';
  return 'OFFLINE_QUEUED';
}

async function refresh(): Promise<NetworkSnapshot> {
  const state = useStore.getState();
  const serverOnline = Boolean(state.transportOnline);
  const meshOnline = Boolean(state.transportDirectPeer || state.transportModule);
  const outboxDepth = await getOutboxDepth();
  snapshot = {
    state: computeState(serverOnline, meshOnline),
    serverOnline,
    meshOnline,
    outboxDepth,
    updatedAt: Date.now(),
  };
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      /* ignore */
    }
  }
  return snapshot;
}

let started = false;
let unsubscribe: (() => void) | null = null;

/** Подписка на store + периодическое обновление глубины outbox. */
export function startNetworkStateMonitor(intervalMs = 15_000): () => void {
  if (started) return () => stopNetworkStateMonitor();
  started = true;
  unsubscribe = useStore.subscribe(() => {
    void refresh();
  });
  const timer = setInterval(() => void refresh(), intervalMs);
  void refresh();
  return () => {
    clearInterval(timer);
    stopNetworkStateMonitor();
  };
}

export function stopNetworkStateMonitor(): void {
  started = false;
  unsubscribe?.();
  unsubscribe = null;
}

export function getNetworkSnapshot(): NetworkSnapshot {
  return snapshot;
}

export function onNetworkStateChange(listener: (value: NetworkSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ручной пинг после flush/подключения модуля. */
export const refreshNetworkState = refresh;
