/**
 * Нативный BLE-транспорт (Android/iOS) поверх react-native-ble-plx.
 *
 * Этот файл попадает только в native-бандл: web-сборка использует ble.web.ts,
 * поэтому react-native-ble-plx никогда не тянется в браузер.
 */
import { BleManager, State, type BleRestoredState, type Device, type Subscription } from 'react-native-ble-plx';
import { PermissionsAndroid, Platform } from 'react-native';
import {
  BLE_SHORT_UUIDS,
  BLE_UUIDS,
  FrameDecoder,
  FrameType,
  configPayload,
  encodeFrame,
  encodeJson,
  helloPayload,
  parseEnvelope,
  parseModuleInfo,
  type DecodedFrame,
} from './protocol';
import {
  ModuleTransportError,
  normalizeInfo,
  type ConnectionKind,
  type ModuleConnection,
  type ModuleEnvelope,
  type ModuleInfo,
  type ModuleWifiConfig,
} from './types';
import { updateClusterFromModule } from '../mesh/ClusterAwarenessService';

let sharedManager: BleManager | null = null;

/**
 * iOS отдаёт состояние центрального устройства после того, как система
 * перезапустила приложение ради BLE-события в фоне. Идентификатор один и
 * тот же на все запуски — по нему CoreBluetooth восстанавливает сессию.
 */
const RESTORE_STATE_IDENTIFIER = 'kinto-ble-central';

/** Восстановленные периферийные устройства (для сверки состояния на active). */
let restoredPeripherals: Device[] = [];
const restoreListeners = new Set<(state: BleRestoredState | null) => void>();

/** Устройства, которые iOS восстановила после фонового запуска. */
export function getRestoredBlePeripherals(): Device[] {
  return restoredPeripherals;
}

/** Подписка на восстановление состояния BLE (только iOS, может не сработать). */
export function onBleRestoreState(listener: (state: BleRestoredState | null) => void): () => void {
  restoreListeners.add(listener);
  return () => restoreListeners.delete(listener);
}

/**
 * Единственный BleManager на всё приложение. restoreStateIdentifier/Function
 * включают background BLE: система может разбудить приложение и отдать уже
 * подключённые периферийные устройства без повторного сканирования.
 */
function manager(): BleManager {
  if (!sharedManager) {
    sharedManager = new BleManager({
      restoreStateIdentifier: RESTORE_STATE_IDENTIFIER,
      restoreStateFunction: (state) => {
        restoredPeripherals = state?.connectedPeripherals ? [...state.connectedPeripherals] : [];
        for (const listener of restoreListeners) {
          try {
            listener(state);
          } catch {
            /* ignore */
          }
        }
      },
    });
  }
  return sharedManager;
}

const BLE_READY_TIMEOUT_MS = 8000;
const HELLO_ATTEMPTS = 3;
const HELLO_RETRY_DELAY_MS = 700;
const INFO_TIMEOUT_MS = 5000;

/**
 * Заранее запрашивает разрешения Bluetooth и создаёт BleManager.
 * На iOS создание менеджера/чтение state поднимает системный диалог
 * NSBluetoothAlways; на Android 12+ — BLUETOOTH_SCAN/CONNECT,
 * на старых версиях — геолокацию. Никогда не бросает исключение.
 */
export async function prepareBle(): Promise<boolean> {
  if (Platform.OS === 'android') {
    try {
      const version = Number(Platform.Version);
      if (version >= 31) {
        const result = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]);
        return Object.values(result).every((value) => value === PermissionsAndroid.RESULTS.GRANTED);
      }
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  }
  try {
    const state = await manager().state();
    return state === State.PoweredOn;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Сервис a5c0 в рекламе устройства (Android/iOS отдают UUID в разном виде). */
function hasModuleService(device: Device): boolean {
  const uuids = device.serviceUUIDs ?? [];
  return uuids.some((uuid) => {
    const value = uuid.toLowerCase().replace(/-/g, '');
    return value === BLE_SHORT_UUIDS.service || value.startsWith('0000a5c0') || value.startsWith('a5c0');
  });
}

/** Резервное сопоставление без фильтра: имя SG-* или сервис a5c0 в рекламе. */
function looksLikeModule(device: Device): boolean {
  const name = device.localName || device.name || '';
  return /^SG-/i.test(name) || hasModuleService(device);
}

/* ------------------------------------------------------------ base64 ----- */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64_ALPHABET[(triple >> 18) & 63];
    out += B64_ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? B64_ALPHABET[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[triple & 63] : '=';
  }
  return out;
}

function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n1 = B64_ALPHABET.indexOf(clean[i]);
    const n2 = B64_ALPHABET.indexOf(clean[i + 1]);
    const n3 = clean[i + 2] === '=' || clean[i + 2] === undefined ? -1 : B64_ALPHABET.indexOf(clean[i + 2]);
    const n4 = clean[i + 3] === '=' || clean[i + 3] === undefined ? -1 : B64_ALPHABET.indexOf(clean[i + 3]);
    if (n1 < 0 || n2 < 0) break;
    const triple = (n1 << 18) | (n2 << 12) | ((n3 < 0 ? 0 : n3) << 6) | (n4 < 0 ? 0 : n4);
    out.push((triple >> 16) & 0xff);
    if (n3 >= 0) out.push((triple >> 8) & 0xff);
    if (n4 >= 0) out.push(triple & 0xff);
  }
  return new Uint8Array(out);
}

/* ---------------------------------------------------------- транспорт ---- */

export interface ScannedModule {
  id: string;
  name: string;
  rssi: number;
}

/**
 * BLE-подключение к модулю. Сканирует по сервису a5c0 (при неудаче — без
 * фильтра), подключается, слушает a5c2 и пишет в a5c1 чанками по 20 байт.
 */
export class NativeBleTransport implements ModuleConnection {
  readonly kind: ConnectionKind = 'ble';
  readonly supported = true;
  info: ModuleInfo | null = null;

  private deviceId: string | null = null;
  private mtu = 23;
  private decoder = new FrameDecoder();
  private closing = false;
  private disconnected = false;
  private rxSub: Subscription | null = null;
  private statusSub: Subscription | null = null;
  private disconnectSub: Subscription | null = null;
  private readonly envelopeHandlers = new Set<(message: ModuleEnvelope) => void>();
  private readonly disconnectHandlers = new Set<() => void>();
  private infoWaiter: {
    resolve: (info: ModuleInfo) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  get isOpen(): boolean {
    return Boolean(this.deviceId && !this.closing);
  }

  /** Сканирование 4 секунды; сначала по сервису a5c0, затем без фильтра. */
  async scan(durationMs = 4000): Promise<ScannedModule[]> {
    await this.waitForPoweredOn();
    const filteredMs = Math.max(2500, Math.min(durationMs, 4000));
    const filtered = await this.scanPhase([BLE_UUIDS.service], filteredMs, () => true);
    if (filtered.length) return filtered;
    // iOS/Edge иногда не отдают сервис в рекламе — повторяем без фильтра.
    const fallbackMs = Math.max(3000, Math.min(durationMs, 4000));
    return this.scanPhase(null, fallbackMs, looksLikeModule);
  }

  /**
   * Дожидается PoweredOn. Unknown/Resetting — ждём обновления состояния,
   * PoweredOff/Unauthorized/Unsupported — сразу понятная ошибка.
   */
  private async waitForPoweredOn(timeoutMs = BLE_READY_TIMEOUT_MS): Promise<void> {
    const ble = manager();
    let current: State | null = null;
    try {
      current = await ble.state();
    } catch {
      current = null;
    }
    if (current === State.PoweredOn) return;
    if (current === State.PoweredOff) {
      throw new ModuleTransportError(
        'Bluetooth выключен. Включите Bluetooth в настройках устройства и повторите.',
        'io',
      );
    }
    if (current === State.Unauthorized) {
      throw new ModuleTransportError(
        'Приложению не разрешён доступ к Bluetooth. Разрешите его в настройках и повторите.',
        'io',
      );
    }
    if (current === State.Unsupported) {
      throw new ModuleTransportError('Это устройство не поддерживает Bluetooth LE.', 'unsupported');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let subscription: Subscription | null = null;
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        try {
          subscription?.remove();
        } catch {
          /* ignore */
        }
        subscription = null;
      };
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      subscription = ble.onStateChange((state) => {
        if (state === State.PoweredOn) {
          finish(resolve);
        } else if (state === State.PoweredOff) {
          finish(() =>
            reject(
              new ModuleTransportError(
                'Bluetooth выключен. Включите Bluetooth в настройках устройства и повторите.',
                'io',
              ),
            ),
          );
        } else if (state === State.Unauthorized) {
          finish(() =>
            reject(
              new ModuleTransportError(
                'Приложению не разрешён доступ к Bluetooth. Разрешите его в настройках и повторите.',
                'io',
              ),
            ),
          );
        } else if (state === State.Unsupported) {
          finish(() => reject(new ModuleTransportError('Это устройство не поддерживает Bluetooth LE.', 'unsupported')));
        }
        // Unknown/Resetting — просто ждём следующего события.
      }, true);
      timer = setTimeout(() => {
        finish(() =>
          reject(
            new ModuleTransportError(
              `Bluetooth не включился за ${Math.round(timeoutMs / 1000)} с. Проверьте, что он включён и доступен приложению.`,
              'timeout',
            ),
          ),
        );
      }, timeoutMs);
      // Если onStateChange успел синхронно вызвать listener до присваивания sub/timer.
      if (settled) cleanup();
    });
  }

  /** Один скан с гарантированным stopDeviceScan в finally. */
  private async scanPhase(
    serviceUuids: string[] | null,
    durationMs: number,
    accept: (device: Device) => boolean,
  ): Promise<ScannedModule[]> {
    const ble = manager();
    const found = new Map<string, ScannedModule>();
    // Предыдущий скан не должен оставаться активным: iOS молча игнорирует новый.
    await ble.stopDeviceScan().catch(() => undefined);
    try {
      await ble.startDeviceScan(serviceUuids, { allowDuplicates: false }, (error, device) => {
        if (error || !device || !accept(device)) return;
        const rssi = Number(device.rssi ?? 0);
        const existing = found.get(device.id);
        if (existing) {
          existing.rssi = rssi;
          if (!existing.name || existing.name === 'SG-модуль') {
            existing.name = device.localName || device.name || existing.name;
          }
          return;
        }
        found.set(device.id, {
          id: device.id,
          name: device.localName || device.name || 'SG-модуль',
          rssi,
        });
      });
    } catch (error) {
      await ble.stopDeviceScan().catch(() => undefined);
      throw new ModuleTransportError(
        `Не удалось начать сканирование Bluetooth: ${errorMessage(error)}. Проверьте разрешения Bluetooth.`,
        'io',
      );
    }
    try {
      await delay(durationMs);
    } finally {
      await ble.stopDeviceScan().catch(() => undefined);
    }
    return [...found.values()].sort((a, b) => b.rssi - a.rssi);
  }

  async open(): Promise<ModuleInfo> {
    const devices = await this.scan(4000);
    if (!devices.length) {
      throw new ModuleTransportError(
        'Модули не найдены по Bluetooth. Убедитесь, что модуль включён и находится рядом.',
        'timeout',
      );
    }
    return this.openDevice(devices[0].id);
  }

  /**
   * Автовосстановление: сканирует 4 секунды и пытается подключиться
   * к последнему известному hardwareId (имя/MAC содержит его).
   */
  async openKnown(hardwareId?: string, timeoutMs = 4000): Promise<ModuleInfo | null> {
    const devices = await this.scan(timeoutMs);
    if (!devices.length) return null;
    const expected = (hardwareId ?? '').toLowerCase();
    const mac = expected.replace(/^esp32-/, '').replace(/[^0-9a-z]/g, '');
    const score = (device: ScannedModule): number => {
      const id = device.id.toLowerCase().replace(/[^0-9a-z]/g, '');
      const name = device.name.toLowerCase();
      if (!expected) return 0;
      if (name.includes(expected) || id.includes(expected.replace(/[^0-9a-z]/g, ''))) return 2;
      if (mac && id.includes(mac)) return 1;
      return 0;
    };
    const ordered = [...devices].sort((a, b) => score(b) - score(a));
    for (const device of ordered.slice(0, expected ? 4 : 1)) {
      try {
        const info = await this.openDevice(device.id);
        if (!expected || info.hardwareId.toLowerCase() === expected) return info;
        await this.close();
      } catch {
        await this.close().catch(() => undefined);
      }
    }
    return null;
  }

  private async openDevice(deviceId: string): Promise<ModuleInfo> {
    if (this.isOpen) await this.close();
    this.closing = false;
    this.disconnected = false;
    this.decoder = new FrameDecoder();
    this.info = null;

    let device: Device;
    try {
      device = await manager().connectToDevice(deviceId, { requestMTU: 185, timeout: 15_000 });
      this.deviceId = device.id;
      await device.discoverAllServicesAndCharacteristics();
      this.mtu = Math.max(23, Number(device.mtu || 185));
      try {
        const withMtu = await manager().requestMTUForDevice(device.id, 185);
        this.mtu = Math.max(23, Number(withMtu.mtu || this.mtu));
      } catch {
        /* iOS сам управляет MTU */
      }
    } catch (error) {
      this.deviceId = null;
      throw new ModuleTransportError(
        `Не удалось подключиться к модулю: ${error instanceof Error ? error.message : String(error)}`,
        'io',
      );
    }

    this.disconnectSub = device.onDisconnected(() => {
      if (!this.closing) this.emitDisconnect();
    });

    this.rxSub = manager().monitorCharacteristicForDevice(
      device.id,
      BLE_UUIDS.service,
      BLE_UUIDS.rx,
      (error, characteristic) => {
        if (error) {
          if (!this.closing) this.emitDisconnect();
          return;
        }
        if (!characteristic?.value) return;
        this.handleChunk(base64ToBytes(characteristic.value));
      },
    );

    this.statusSub = manager().monitorCharacteristicForDevice(
      device.id,
      BLE_UUIDS.service,
      BLE_UUIDS.status,
      (error, characteristic) => {
        if (error || !characteristic?.value) return;
        this.mergeStatus(base64ToBytes(characteristic.value));
      },
    );

    // iOS/Edge могут потерять первый HELLO при медленном старте GATT — повторяем.
    let helloError: Error | null = null;
    for (let attempt = 0; attempt < HELLO_ATTEMPTS; attempt += 1) {
      if (this.info || this.closing) break;
      if (attempt > 0) await delay(HELLO_RETRY_DELAY_MS);
      if (this.info || this.closing) break;
      try {
        await this.writeFrame(FrameType.HELLO, encodeJson(helloPayload('native-ble')));
        helloError = null;
      } catch (error) {
        helloError = error instanceof Error ? error : new Error(String(error));
        if (this.closing) break;
      }
    }
    const info = await this.waitInfo(INFO_TIMEOUT_MS, helloError ?? undefined).catch(async (error: unknown) => {
      await this.close().catch(() => undefined);
      throw error;
    });
    this.info = info;
    return info;
  }

  private handleChunk(chunk: Uint8Array): void {
    for (const frame of this.decoder.push(chunk)) this.handleFrame(frame);
  }

  private handleFrame(frame: DecodedFrame): void {
    switch (frame.type) {
      case FrameType.INFO: {
        const parsed = parseModuleInfo(frame.payload);
        if (parsed) {
          const info = normalizeInfo(parsed);
          this.info = info;
          if (this.infoWaiter) {
            clearTimeout(this.infoWaiter.timer);
            this.infoWaiter.resolve(info);
            this.infoWaiter = null;
          }
        }
        break;
      }
      case FrameType.DATA_DOWN: {
        const message = parseEnvelope(frame.payload);
        if (message) {
          for (const handler of this.envelopeHandlers) {
            try {
              handler(message);
            } catch {
              /* ignore */
            }
          }
        }
        break;
      }
      case FrameType.STATUS:
        this.mergeStatus(frame.payload);
        break;
      case FrameType.PING:
        void this.writeFrame(FrameType.PONG, encodeJson({ v: 1, kind: 'status' })).catch(() => undefined);
        break;
      default:
        break;
    }
  }

  private mergeStatus(payload: Uint8Array): void {
    if (!this.info) return;
    let raw: Record<string, unknown> | null = null;
    try {
      raw = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    } catch {
      raw = null;
    }
    if (!raw) return;
    updateClusterFromModule(raw);
    this.info = {
      ...this.info,
      attached: typeof raw.attached === 'boolean' ? raw.attached : this.info.attached,
      queue: Number.isFinite(Number(raw.queue)) ? Number(raw.queue) : this.info.queue,
      rssi: Number.isFinite(Number(raw.rssi)) ? Number(raw.rssi) : this.info.rssi,
      battery: Number.isFinite(Number(raw.battery)) ? Number(raw.battery) : this.info.battery,
      meshRole: typeof raw.meshRole === 'string' ? raw.meshRole : this.info.meshRole,
      gateway: typeof raw.gateway === 'boolean' ? raw.gateway : this.info.gateway,
      firmware: typeof raw.firmware === 'string' ? raw.firmware : this.info.firmware,
    };
  }

  private waitInfo(timeoutMs: number, cause?: Error): Promise<ModuleInfo> {
    if (this.info) return Promise.resolve(this.info);
    return new Promise<ModuleInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.infoWaiter = null;
        reject(
          new ModuleTransportError(
            `Модуль не ответил на HELLO за ${Math.round(timeoutMs / 1000)} с. ` +
              'Проверьте прошивку и поднесите модуль ближе.' +
              (cause ? ` Причина: ${cause.message}` : ''),
            'timeout',
          ),
        );
      }, timeoutMs);
      this.infoWaiter = { resolve, reject, timer };
    });
  }

  /** Чанк ровно 20 байт — как в web, чтобы не упираться в длинные write на iOS. */
  private async writeFrame(type: number, payload: Uint8Array): Promise<void> {
    const deviceId = this.deviceId;
    if (!deviceId || this.closing) {
      throw new ModuleTransportError('Bluetooth не подключён.', 'closed');
    }
    const frame = encodeFrame(type, payload);
    const chunkSize = 20;
    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      const chunk = frame.slice(offset, offset + chunkSize);
      await manager().writeCharacteristicWithResponseForDevice(
        deviceId,
        BLE_UUIDS.service,
        BLE_UUIDS.tx,
        bytesToBase64(chunk),
      );
    }
  }

  async sendEnvelope(chatId: string, envelope: unknown): Promise<void> {
    if (!this.isOpen) throw new ModuleTransportError('Bluetooth не подключён.', 'closed');
    await this.writeFrame(
      FrameType.DATA_UP,
      encodeJson({ v: 1, kind: 'envelope', direction: 'up', chatId, envelope }),
    );
  }

  /** SET_CONFIG: SSID/пароль роутера уходят шлюзу, в логи не пишутся. */
  async sendConfig(config: ModuleWifiConfig): Promise<void> {
    if (!this.isOpen) throw new ModuleTransportError('Bluetooth не подключён.', 'closed');
    await this.writeFrame(
      FrameType.SET_CONFIG,
      encodeJson(configPayload(config.wifiSsid, config.wifiPassword)),
    );
  }

  onEnvelope(callback: (message: ModuleEnvelope) => void): () => void {
    this.envelopeHandlers.add(callback);
    return () => this.envelopeHandlers.delete(callback);
  }

  onDisconnect(callback: () => void): () => void {
    this.disconnectHandlers.add(callback);
    return () => this.disconnectHandlers.delete(callback);
  }

  private emitDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.info = null;
    for (const handler of this.disconnectHandlers) {
      try {
        handler();
      } catch {
        /* ignore */
      }
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.infoWaiter) {
      clearTimeout(this.infoWaiter.timer);
      this.infoWaiter.reject(new ModuleTransportError('Подключение закрыто.', 'closed'));
      this.infoWaiter = null;
    }
    this.decoder.dispose();
    this.info = null;
    try {
      this.rxSub?.remove();
      this.statusSub?.remove();
      this.disconnectSub?.remove();
    } catch {
      /* ignore */
    }
    this.rxSub = null;
    this.statusSub = null;
    this.disconnectSub = null;
    const deviceId = this.deviceId;
    this.deviceId = null;
    if (deviceId) {
      await manager().cancelDeviceConnection(deviceId).catch(() => undefined);
    }
  }
}

export default NativeBleTransport;
