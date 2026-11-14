/**
 * Сервис KMesh_v1 для приложения.
 *
 * Один экземпляр на сессию. UI вызывает:
 *   await connectKMeshV1()    — открыть BLE GATT;
 *   await sendMeshText(...)   — сохранить локально и передать;
 *   await syncKMeshV1()       — выгрузить очередь при восстановлении сети.
 */
import { KMeshV1Client, type KMeshV1ClientOptions } from './client';
import { BleKMeshV1Link } from '../../modules/bleKMeshV1';
import { api } from '../../data/api';
import { bytesToB64 } from './crypto';
import { msgUuidHex } from './protocol';
import { loadCachedIdentity, refreshCachedIdentity } from './identity';

let link: BleKMeshV1Link | null = null;
let client: KMeshV1Client | null = null;
let connecting: Promise<KMeshV1Client> | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let boundNodeId = 0;

export function kmeshV1Client(): KMeshV1Client | null {
  return client;
}

export function kmeshV1Supported(): boolean {
  return BleKMeshV1Link.supported();
}

export async function connectKMeshV1(
  callbacks: Pick<
    KMeshV1ClientOptions,
    'onMessage' | 'onStatus' | 'onInfo' | 'onSearch' | 'onFeed' | 'onHistory' | 'resolveChatByRef'
  > = {},
): Promise<KMeshV1Client> {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    link = new BleKMeshV1Link();
    // Префикс своего модуля читаем до сканирования: KL-<USER8>-<MOD6>.
    const identity = (await loadCachedIdentity()) ?? (await refreshCachedIdentity().catch(() => null));
    const prefix = identity?.blePrefix ? `KL-${identity.blePrefix}-` : 'KL-';
    await link.connect(12000, prefix);
    const instance = new KMeshV1Client({
      link: {
        send: (frame) => link!.send(frame),
      },
      ...callbacks,
      onInfo: (info) => {
        if (info.nodeId && info.nodeId !== boundNodeId) {
          boundNodeId = info.nodeId;
          void api.kmeshV1NodeBind(info.nodeId).catch(() => undefined);
        }
        callbacks.onInfo?.(info);
      },
      onProxyUplink: (packet, raw) => {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
        if (packet.type === 6) {
          const rssi = packet.payload.length >= 6 ? (packet.payload[5] << 24) >> 24 : 0;
          const battery = packet.payload.length >= 5 ? packet.payload[4] : 0;
          const role = packet.payload.length >= 7 ? packet.payload[6] : 0;
          const fwBuild = packet.payload.length >= 10
            ? packet.payload[8] | (packet.payload[9] << 8)
            : 0;
          void api
            .kmeshV1MobilePresence({
              gateway_id: instance.getNodeId(),
              node_id: packet.srcId,
              rssi,
              hops: packet.hopCount,
              battery,
              role,
              fw_build: fwBuild,
              chip_arch: packet.payload.length >= 11 ? packet.payload[10] : 0,
              node_role: packet.payload.length >= 12 ? packet.payload[11] : 0,
              radio_caps: packet.payload.length >= 13 ? packet.payload[12] : 0,
              ota_state: packet.payload.length >= 14 ? packet.payload[13] : 0,
              battery_pct: packet.payload.length >= 15 ? packet.payload[14] : battery,
            })
            .catch(() => undefined);
          return;
        }
        void api
          .kmeshV1MobileArchive({
            gateway_id: instance.getNodeId(),
            msg_uuid: msgUuidHex(packet.msgUuid),
            packet_b64: bytesToB64(raw),
          })
          .catch(() => undefined);
      },
    });
    link.onData((chunk) => instance.handleData(chunk));
    client = instance;
    await instance.hello();
    startInetHeartbeat(instance);
    return instance;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

function startInetHeartbeat(instance: KMeshV1Client): void {
  if (heartbeat) clearInterval(heartbeat);
  const send = () => {
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    void instance.setInetStatus(online, online ? 80 : 0, true).catch(() => undefined);
  };
  send();
  heartbeat = setInterval(send, 15000);
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', send);
    window.addEventListener('offline', send);
  }
}

export async function disconnectKMeshV1(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  await link?.disconnect();
  link = null;
  client = null;
}

export async function sendMeshText(input: {
  chatId: string;
  chatRef: number;
  peerNodeId: number;
  text: string;
  toInternet?: boolean;
  group?: boolean;
}): Promise<{ msgUuid: string; state: string }> {
  if (!client) await connectKMeshV1();
  return client!.sendText(input);
}

export async function syncKMeshV1(): Promise<{ synced: number; remaining: number }> {
  if (!client) return { synced: 0, remaining: 0 };
  return client.syncOutbox();
}
