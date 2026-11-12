/** Три состояния присутствия в гибридной сети. */
import React from 'react';
import { useStore } from '../state/useStore';
import { meshOutbox } from './OutboxSyncService';

export type PresenceState = 'ONLINE_SERVER' | 'ONLINE_MESH' | 'OFFLINE_QUEUED';

export function computePresence(input: {
  transportOnline: boolean;
  heartbeatAgeMs: number;
  meshPeers: number;
  outboxCount: number;
  meshAck: boolean;
}): PresenceState {
  if (input.transportOnline && input.heartbeatAgeMs < 5000) return 'ONLINE_SERVER';
  if (input.meshPeers > 0 && (input.meshAck || input.outboxCount === 0)) return 'ONLINE_MESH';
  return 'OFFLINE_QUEUED';
}

export const PRESENCE_LABEL: Record<PresenceState, string> = {
  ONLINE_SERVER: 'онлайн · сервер',
  ONLINE_MESH: 'онлайн · mesh',
  OFFLINE_QUEUED: 'офлайн · в очереди',
};

export function usePresenceState(): PresenceState {
  const transportOnline = useStore((s) => s.transportOnline);
  const meshPeerCount = useStore((s) => Object.keys(s.meshPeers).length);
  const [outboxCount, setOutboxCount] = React.useState(0);
  const [heartbeatAge, setHeartbeatAge] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    const tick = () => {
      void meshOutbox.size().then((n) => alive && setOutboxCount(n)).catch(() => undefined);
      setHeartbeatAge(0);
    };
    tick();
    const timer = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [transportOnline]);

  return React.useMemo(
    () =>
      computePresence({
        transportOnline,
        heartbeatAgeMs: heartbeatAge,
        meshPeers: meshPeerCount,
        outboxCount,
        meshAck: meshPeerCount > 0,
      }),
    [transportOnline, heartbeatAge, meshPeerCount, outboxCount],
  );
}
