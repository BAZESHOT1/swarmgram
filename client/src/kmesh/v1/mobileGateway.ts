/**
 * Мобильный шлюз KMesh_v1.
 *
 * Когда телефон подключён к модулю и имеет интернет, приложение само
 * выполняет роль шлюза кластера:
 *   uplink:  модуль → PROXY_UP → этот сервис → Hub (/kmesh/v1/mobile/relay)
 *   downlink: Hub (/kmesh/v1/mobile/downlink) → этот сервис → модуль (PROXY_DOWN)
 *
 * Прошивка узнаёт о доступности интернета через INET_STATUS и начинает слать
 * uplink-пакеты в BLE-клиент вместо ожидания ESP32-шлюза.
 */
import { api } from '../../data/api';
import { useStore } from '../../state/useStore';
import { setMeshCapabilities } from '../../modules/meshLink';
import { b64ToBytes, bytesToB64 } from './crypto';
import {
  decodeMeshPacket,
  msgUuidHex,
  type MeshPacket,
} from './protocol';
import type { KMeshV1Client } from './client';

interface UplinkItem {
  gatewayId: number;
  msgUuid: string;
  packetB64: string;
  srcId: number;
  packetId: number;
  rssi: number;
  iface: number;
}

const MAX_QUEUE = 60;

export interface MobileGatewayHandle {
  stop: () => void;
  /** Отправить актуальный INET_STATUS (например, сразу после подключения). */
  refresh: () => void;
}

/**
 * Запускает мобильный шлюз для уже подключённого KMesh_v1 клиента.
 * Возвращает handle для остановки при отключении модуля.
 */
export function startMobileGateway(client: KMeshV1Client): MobileGatewayHandle {
  let stopped = false;
  let cursor = 0;
  let lastGatewayId = 0;
  const queue: UplinkItem[] = [];
  let flushing = false;

  const isOnline = (): boolean => {
    const state = useStore.getState();
    if (state.transportOnline) return true;
    // Пока WebSocket не подтвердил Hub, верим системному состоянию сети,
    // но не включаем мобильный шлюз «наугад» при явном офлайне.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    return false;
  };

  const gatewayId = (): number => client.getNodeId() || 0;

  /** Пока телефон выступает шлюзом, кластер имеет доступ к Hub. */
  const markGateway = (online: boolean): void => {
    if (!online) return; // офлайн телефона не отменяет ESP32-шлюз в кластере
    const state = useStore.getState();
    if (state.transportGateway !== true) state.setTransportGateway(true);
    setMeshCapabilities({ connected: true, gateway: true });
  };

  const sendInet = (): void => {
    if (stopped) return;
    const online = isOnline();
    const id = gatewayId();
    if (!id) return;
    markGateway(online);
    void client.setInetStatus(online, online ? 80 : 0, true).catch(() => undefined);
    if (online) {
      void flushUplink();
      void pollDownlink();
    }
  };

  const enqueue = (item: UplinkItem): void => {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(item);
    void flushUplink();
  };

  const flushUplink = async (): Promise<void> => {
    if (flushing || stopped || !isOnline()) return;
    flushing = true;
    try {
      while (queue.length && !stopped) {
        const item = queue[0];
        try {
          await api.kmeshV1MobileRelay({
            gateway_id: item.gatewayId,
            msg_uuid: item.msgUuid,
            packet_b64: item.packetB64,
            src_id: item.srcId,
            packet_id: item.packetId,
            rssi: item.rssi,
            iface: item.iface,
          });
          queue.shift();
        } catch {
          // сеть пропала/401 — повторим на следующем heartbeat
          break;
        }
      }
    } finally {
      flushing = false;
    }
  };

  const pollDownlink = async (): Promise<void> => {
    if (stopped || !isOnline()) return;
    const id = gatewayId();
    if (!id) return;
    if (id !== lastGatewayId) {
      lastGatewayId = id;
      cursor = 0;
    }
    try {
      const res = await api.kmeshV1MobileDownlink(id, cursor);
      cursor = Number(res.cursor) || cursor;
      for (const item of res.items) {
        if (!item.packet_b64) continue;
        const packet = decodeMeshPacket(b64ToBytes(item.packet_b64));
        if (!packet) continue;
        await client.proxyDownlink(packet).catch(() => undefined);
      }
    } catch {
      /* повторим позже */
    }
  };

  // PROXY_UP от прошивки: presence → метрики, остальное → relay в Hub.
  client.setProxyUplinkHandler((packet: MeshPacket, raw: Uint8Array) => {
    if (stopped) return;
    const id = gatewayId();
    if (!id) return;
    if (packet.type === 6) {
      const rssi = packet.payload.length >= 6 ? (packet.payload[5] << 24) >> 24 : 0;
      const battery = packet.payload.length >= 5 ? packet.payload[4] : 0;
      const role = packet.payload.length >= 7 ? packet.payload[6] : 0;
      const fwBuild = packet.payload.length >= 10
        ? packet.payload[8] | (packet.payload[9] << 8)
        : 0;
      void api
        .kmeshV1MobilePresence({
          gateway_id: id,
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
    enqueue({
      gatewayId: id,
      msgUuid: msgUuidHex(packet.msgUuid),
      packetB64: bytesToB64(raw),
      srcId: packet.srcId,
      packetId: packet.packetId,
      rssi: 0,
      iface: 1,
    });
  });

  const heartbeat = setInterval(() => {
    sendInet();
    void flushUplink();
    void pollDownlink();
  }, 15_000);
  const downlinkTimer = setInterval(() => {
    void pollDownlink();
  }, 5_000);

  const unsubscribe = useStore.subscribe((state, prev) => {
    if (state.transportOnline !== prev.transportOnline) sendInet();
  });

  // Первый INET_STATUS сразу: прошивка должна узнать про интернет до того,
  // как приложение отправит первое сообщение через KMesh.
  sendInet();
  // Первый downlink — после того, как node/bind успеет сохраниться на Hub.
  const firstPoll = setTimeout(() => {
    void pollDownlink();
  }, 2500);

  return {
    stop: () => {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(downlinkTimer);
      clearTimeout(firstPoll);
      markGateway(false);
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      const id = gatewayId();
      if (id) void client.setInetStatus(false, 0, true).catch(() => undefined);
    },
    refresh: sendInet,
  };
}
