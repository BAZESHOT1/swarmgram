/**
 * Транспортный контракт Kinto. Реализации: WebSocket на Hub и BLE к модулю
 * ESP32. Один и тот же интерфейс для web/iOS/Android.
 */
export interface TransportStatus {
  online: boolean;
  gateway: boolean;
  model: string | null;
}

export interface MeshNeighbor {
  uuid: string;
  rssi: number;
  channel: 'ble' | 'lora';
  hasGateway: boolean;
}

/** Сервис/характеристики ESP32-модуля — совпадают с прошивкой `firmware/`. */
export const MODULE_UUIDS = {
  service: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
  write: 'beb5483e-36e1-4685-b7f5-ea07361b26a8',
  info: '2c94b3f4-7b1e-4bc8-a6b4-c72e7a9b6f0d',
} as const;

export type ModulePacket =
  | { type: 'hello'; boardUuid: string; firmware: string; kind: 'wifi' | 'lora' }
  | { type: 'status'; battery: number; gateway: boolean; neighbors: number }
  | { type: 'neighbors'; neighbors: MeshNeighbor[] }
  | { type: 'error'; message: string };

export interface ModuleLink {
  moduleId: string;
  boardUuid: string;
  firmware?: string;
  kind?: 'wifi' | 'lora';
  writeToken(token: string): Promise<void>;
  sendEnvelope(envelope: string): Promise<void>;
  requestScan(): Promise<void>;
  onPacket(cb: (p: ModulePacket) => void): void;
  disconnect(): Promise<void>;
}

export interface Transport {
  /* активность реального канала */
  status(): TransportStatus;
  setOnline(online: boolean): void;
  /* модуль */
  bleSupported(): boolean;
  requestModule(): Promise<ModuleLink | null>;
}

export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedError';
  }
}
