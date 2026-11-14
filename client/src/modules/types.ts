/**
 * Общие типы подключения к ESP32-модулю.
 * Один и тот же интерфейс используют USB (Web Serial), Web Bluetooth
 * и нативный BLE (react-native-ble-plx).
 */

export type ConnectionKind = 'usb' | 'ble';

export type ModuleRole = 'wearable' | 'repeater' | 'gateway';

/** Данные, которые модуль отдаёт в INFO после HELLO. */
export interface ModuleInfo {
  hardwareId: string;
  /** BLE MAC как алиас; основной идентификатор — hardwareId (Wi-Fi MAC). */
  bleMac?: string;
  /** 8-значный публичный ID модуля для добавления в аккаунт. */
  publicId?: string;
  role: ModuleRole | string;
  firmware: string;
  battery: number;
  meshRole?: string;
  attached: boolean;
  /** Есть ли путь к серверам через шлюз. */
  gateway?: boolean;
  queue: number;
  rssi: number;
  /** Сколько соседей модуль видит в mesh-кластере. */
  neighbors?: number;
  /** ID mesh-кластера. */
  clusterId?: string;
  /** Является ли модуль пограничным узлом кластера. */
  border?: boolean;
  /** Состояние handover (0 — нет перехода). */
  handover?: number;
  /** Постоянный owner_net_id (users.id -> uint32). */
  ownerNetId?: number;
  /** 8 hex префикса владельца. */
  ownerPrefix?: string;
  /** Последние 6 hex MAC. */
  bleMod6?: string;
}

/** Входящий конверт из mesh-сети. */
export interface ModuleEnvelope {
  chatId: string;
  envelope: unknown;
}

/** Wi-Fi роутера для шлюза: отправляется в модуль кадром SET_CONFIG. */
export interface ModuleWifiConfig {
  wifiSsid: string;
  wifiPassword: string;
}

export interface ModuleOwnerClaim {
  prefix: string;
  netId: number;
  epoch: number;
  signature: string;
}

/** Универсальное подключение к модулю. */
export interface ModuleConnection {
  readonly kind: ConnectionKind;
  /** Поддерживает ли текущая платформа/браузер этот транспорт. */
  readonly supported: boolean;
  readonly isOpen: boolean;
  readonly info: ModuleInfo | null;
  /** Открыть с явным запросом устройства у пользователя и пройти handshake. */
  open(): Promise<ModuleInfo>;
  /** Подключиться к уже известному устройству без запроса (автовосстановление). */
  openKnown?(hardwareId?: string, timeoutMs?: number): Promise<ModuleInfo | null>;
  /** Подключиться к конкретному BLE device id (после скана/claim). */
  openDevice?(deviceId: string, timeoutMs?: number): Promise<ModuleInfo>;
  /** Необязательный скан nearby-устройств (native BLE) для уведомлений. */
  scan?(durationMs?: number): Promise<{ id: string; name: string; rssi: number }[]>;
  sendEnvelope(chatId: string, envelope: unknown): Promise<void>;
  /**
   * Передать шлюзу SSID/пароль Wi-Fi роутера (кадр SET_CONFIG).
   * Необязателен: заглушки и старые прошивки могут его не поддерживать.
   */
  sendConfig?(config: ModuleWifiConfig): Promise<void>;
  /** Подтверждённая Hub смена владельца (BRIDGE_CMD_SET_OWNER). */
  setOwner?(claim: ModuleOwnerClaim): Promise<void>;
  /** Подписка на входящие конверты; возвращает функцию отписки. */
  onEnvelope(callback: (message: ModuleEnvelope) => void): () => void;
  /**
   * Подписка на обновления INFO/STATUS (gateway, RSSI, соседи, очередь).
   * Необязательна: старые транспорты могут её не реализовывать.
   */
  onInfo?(callback: (info: ModuleInfo) => void): () => void;
  /** Подписка на разрыв связи; возвращает функцию отписки. */
  onDisconnect(callback: () => void): () => void;
  close(): Promise<void>;
}

/** Ошибка транспорта с человекочитаемым сообщением. */
export class ModuleTransportError extends Error {
  constructor(
    message: string,
    public code: 'unsupported' | 'timeout' | 'closed' | 'handshake' | 'io' = 'io',
  ) {
    super(message);
    this.name = 'ModuleTransportError';
  }
}

/** Приводит произвольный info-ответ к строгому ModuleInfo. */
export function normalizeInfo(raw: {
  hardwareId: string;
  bleMac?: string;
  publicId?: string;
  role?: string;
  firmware?: string;
  battery?: number;
  meshRole?: string;
  attached?: boolean | number | string;
  gateway?: boolean | number | string;
  queue?: number;
  rssi?: number;
  neighbors?: number;
  cluster_id?: string | number;
  border?: boolean | number | string;
  handover?: number;
  ownerNetId?: number;
  ownerPrefix?: string;
  bleMod6?: string;
}): ModuleInfo {
  const role = raw.role === 'wearable' || raw.role === 'repeater' || raw.role === 'gateway' ? raw.role : 'gateway';
  // Прошивка отдаёт gateway/border как 0/1, старые версии — как boolean.
  const truthy = (value: unknown): boolean => value === true || value === 1 || value === '1' || value === 'true';
  return {
    hardwareId: raw.hardwareId,
    bleMac: raw.bleMac,
    publicId: raw.publicId,
    role,
    firmware: raw.firmware ?? '',
    battery: Math.max(0, Math.min(100, Number(raw.battery ?? 0))),
    meshRole: raw.meshRole,
    attached: truthy(raw.attached),
    gateway: truthy(raw.gateway),
    queue: Math.max(0, Number(raw.queue ?? 0)),
    rssi: Number(raw.rssi ?? 0),
    neighbors: Math.max(0, Number(raw.neighbors ?? 0)),
    clusterId: raw.cluster_id != null ? String(raw.cluster_id) : undefined,
    border: truthy(raw.border),
    handover: Number(raw.handover ?? 0),
    ownerNetId: raw.ownerNetId != null ? Number(raw.ownerNetId) >>> 0 : undefined,
    ownerPrefix: raw.ownerPrefix != null ? String(raw.ownerPrefix).toLowerCase() : undefined,
    bleMod6: raw.bleMod6 != null ? String(raw.bleMod6).toLowerCase() : undefined,
  };
}

/** Сохранённый последний модуль (sg:module:last). */
export interface LastModuleRecord {
  hardwareId: string;
  publicId?: string;
  moduleId?: string;
  role?: string;
  kind?: ConnectionKind;
  at?: number;
}

export const LAST_MODULE_KEY = 'sg:module:last';

export async function readLastModule(kv: {
  get(key: string): Promise<string | null>;
}): Promise<LastModuleRecord | null> {
  try {
    const raw = await kv.get(LAST_MODULE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastModuleRecord>;
    if (!parsed || typeof parsed.hardwareId !== 'string' || !parsed.hardwareId) return null;
    return {
      hardwareId: parsed.hardwareId,
      publicId: typeof parsed.publicId === 'string' ? parsed.publicId : undefined,
      moduleId: typeof parsed.moduleId === 'string' ? parsed.moduleId : undefined,
      role: typeof parsed.role === 'string' ? parsed.role : undefined,
      kind: parsed.kind === 'ble' || parsed.kind === 'usb' ? parsed.kind : undefined,
      at: typeof parsed.at === 'number' ? parsed.at : undefined,
    };
  } catch {
    return null;
  }
}

export async function writeLastModule(
  kv: { set(key: string, value: string): Promise<void> },
  record: LastModuleRecord,
): Promise<void> {
  try {
    await kv.set(LAST_MODULE_KEY, JSON.stringify({ ...record, at: Date.now() }));
  } catch {
    /* приватный режим / нет места — автовосстановление просто не сработает */
  }
}
