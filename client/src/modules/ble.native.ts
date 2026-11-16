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
import { parseModuleBleName } from './identity';
import { ClientFrameDecoder, ClientFrameType, encodeClientFrame } from '../kmesh/v1/protocol';

let sharedManager: BleManager | null = null;

/**
 * iOS отдаёт состояние центрального устройства после того, как система
 * перезапустила приложение ради BLE-события в фоне. Идентификатор один и
 * тот же на все запуски — по нему CoreBluetooth восстанавливает сессию.
 */
const RESTORE_STATE_IDENTIFIER = 'klinto-ble-central';

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
const HELLO_ATTEMPTS = 4;
const HELLO_RETRY_DELAY_MS = 700;
const INFO_TIMEOUT_MS = 7000;

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

/**
 * Диагностика BLE: короткие строки уходят в logcat (`ReactNativeJS`) и в
 * подписчиков (страница модулей), чтобы живую отладку можно было снимать
 * без отладочной сборки.
 */
export type BleDebugEntry = { at: number; text: string };
const debugListeners = new Set<(entry: BleDebugEntry) => void>();

export function onBleDebug(listener: (entry: BleDebugEntry) => void): () => void {
  debugListeners.add(listener);
  return () => debugListeners.delete(listener);
}

function dbg(text: string): void {
  const entry: BleDebugEntry = { at: Date.now(), text };
  try {
    // console.log в release-сборке RN виден в logcat как ReactNativeJS.
    console.log('[ble]', text);
  } catch {
    /* ignore */
  }
  for (const listener of debugListeners) {
    try {
      listener(entry);
    } catch {
      /* ignore */
    }
  }
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
  return looksLikeModuleNamed(device);
}

function looksLikeModuleNamed(device: Device, knownName?: string): boolean {
  const name = knownName || device.localName || device.name || '';
  return /^KL-/i.test(name) || /^SG-/i.test(name) || hasModuleService(device);
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
  ownerPrefix?: string;
  mod6?: string;
}

/**
 * BLE-подключение к модулю. Сканирует по сервису a5c0 (при неудаче — без
 * фильтра), подключается, слушает a5c2 и пишет в a5c1 чанками по 20 байт.
 */
export class NativeBleTransport implements ModuleConnection {
  readonly kind: ConnectionKind = 'ble';
  readonly supported = true;
  info: ModuleInfo | null = null;

  /** KMesh_v1 использует тот же GATT, но собственный бинарный протокол. */
  readonly rawLink = {
    send: (bytes: Uint8Array) => this.sendRaw(bytes),
    onData: (callback: (chunk: Uint8Array) => void) => this.onRaw(callback),
  };

  private deviceId: string | null = null;
  private mtu = 23;
  private decoder = new FrameDecoder();
  /** Параллельный разбор KMesh_v1: модуль отвечает INFO в новом формате. */
  private v1Decoder = new ClientFrameDecoder();
  private v1HelloSeq = 0;
  private closing = false;
  private disconnected = false;
  private rxSub: Subscription | null = null;
  private statusSub: Subscription | null = null;
  private disconnectSub: Subscription | null = null;
  private readonly envelopeHandlers = new Set<(message: ModuleEnvelope) => void>();
  private readonly rawHandlers = new Set<(chunk: Uint8Array) => void>();
  private readonly infoHandlers = new Set<(info: ModuleInfo) => void>();
  private readonly disconnectHandlers = new Set<() => void>();
  /**
   * Очередь BLE-записей. Несколько API-запросов могут одновременно уйти в
   * mesh; без сериализации их 20-байтные куски перемешиваются, и прошивка
   * собирает битые кадры.
   */
  private writeChain: Promise<void> = Promise.resolve();
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
    dbg(`scan filtered: ${filtered.length} (${filtered.map((d) => d.name).join(', ') || '-'})`);
    if (filtered.length) return filtered;
    // iOS/Edge иногда не отдают сервис в рекламе — повторяем без фильтра.
    const fallbackMs = Math.max(3000, Math.min(durationMs, 4000));
    const fallback = await this.scanPhase(null, fallbackMs, (device, name) =>
      looksLikeModuleNamed(device, name),
    );
    dbg(`scan fallback: ${fallback.length} (${fallback.map((d) => d.name).join(', ') || '-'})`);
    if (fallback.length) return fallback;
    // Модуль может быть уже подключён системой/прошлой сессией — тогда он не
    // рекламируется. Берём известные (bonded) и активные устройства.
    const known = await this.knownDevices();
    dbg(`scan known: ${known.length} (${known.map((d) => d.name).join(', ') || '-'})`);
    return known;
  }

  /** Уже подключённые и известные системе устройства с сервисом модуля. */
  private async knownDevices(): Promise<ScannedModule[]> {
    const ble = manager();
    const found = new Map<string, ScannedModule>();
    const add = (device: Device): void => {
      if (!device?.id || found.has(device.id)) return;
      const name = device.localName || device.name || '';
      if (!looksLikeModule(device)) return;
      found.set(device.id, {
        id: device.id,
        name: name || 'KL-модуль',
        rssi: Number(device.rssi ?? 0),
        ...(parseModuleBleName(name) ?? {}),
      });
    };
    try {
      for (const device of await ble.connectedDevices([BLE_UUIDS.service])) add(device);
    } catch {
      /* ignore */
    }
    if (!found.size) {
      // Некоторые Android-прошивки не фильтруют connectedDevices по сервису —
      // пробуем без фильтра и отбираем по имени KL-*/SG-*.
      try {
        for (const device of await ble.connectedDevices([])) add(device);
      } catch {
        /* ignore */
      }
    }
    if (!found.size) {
      try {
        for (const device of await ble.devices([BLE_UUIDS.service])) add(device);
      } catch {
        /* ignore */
      }
    }
    if (!found.size) {
      try {
        for (const device of await ble.devices([])) add(device);
      } catch {
        /* ignore */
      }
    }
    return [...found.values()];
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
    accept: (device: Device, name: string) => boolean,
  ): Promise<ScannedModule[]> {
    const ble = manager();
    const found = new Map<string, { device: Device; name: string }>();
    // Предыдущий скан не должен оставаться активным: iOS молча игнорирует новый.
    await ble.stopDeviceScan().catch(() => undefined);
    try {
      // allowDuplicates нужен, чтобы поймать scan response с именем KL-*:
      // первый пакет Android часто отдаёт без localName.
      await ble.startDeviceScan(serviceUuids, { allowDuplicates: true }, (error, device) => {
        if (error || !device) return;
        const name = device.localName || device.name || '';
        const prev = found.get(device.id);
        if (!prev) {
          found.set(device.id, { device, name });
          return;
        }
        if (name && !prev.name) prev.name = name;
        prev.device = device;
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
    return [...found.values()]
      .filter((entry) => accept(entry.device, entry.name))
      .map((entry) => ({
        id: entry.device.id,
        name: entry.name || 'KL-модуль',
        rssi: Number(entry.device.rssi ?? 0),
        ...(parseModuleBleName(entry.name) ?? {}),
      }))
      .sort((a, b) => b.rssi - a.rssi);
  }

  async open(): Promise<ModuleInfo> {
    const devices = await this.scan(4000);
    if (!devices.length) {
      throw new ModuleTransportError(
        'Модули не найдены по Bluetooth. Убедитесь, что модуль включён и находится рядом.',
        'timeout',
      );
    }
    return this.openDeviceInternal(devices[0].id);
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
    const expectedHex = expected.replace(/^esp32-/, '');
    const reversedHex = expectedHex.length === 12
      ? expectedHex.match(/.{2}/g)?.reverse().join('') ?? ''
      : '';
    for (const device of ordered.slice(0, expected ? 4 : 1)) {
      try {
        const info = await this.openDeviceInternal(device.id);
        const got = info.hardwareId.toLowerCase();
        const gotMod6 = got.replace(/^esp32-/, '').replace(/[^0-9a-z]/g, '').slice(-6);
        // Имя BLE (KL-<prefix>-<mod6>) — самый надёжный идентификатор: даже если
        // в сохранённой записи старый hardwareId, mod6 совпадает с MAC модуля.
        const nameMod6 = (device.mod6 ?? parseModuleBleName(device.name)?.mod6 ?? '').toLowerCase();
        const matches = !expected
          || got === expected
          || got === `esp32-${reversedHex}`
          || (Boolean(nameMod6) && gotMod6 === nameMod6)
          || (info.bleMod6 != null && info.bleMod6.toLowerCase() === nameMod6);
        dbg(`openKnown ${device.id} got=${got} want=${expected || '-'} match=${matches ? 1 : 0}`);
        if (matches) return info;
        await this.close();
      } catch (e) {
        dbg(`openKnown ${device.id} failed: ${e instanceof Error ? e.message : String(e)}`);
        await this.close().catch(() => undefined);
      }
    }
    return null;
  }

  async openDevice(deviceId: string): Promise<ModuleInfo> {
    return this.openDeviceInternal(deviceId);
  }

  private async openDeviceInternal(deviceId: string): Promise<ModuleInfo> {
    if (this.isOpen) await this.close();
    this.closing = false;
    this.disconnected = false;
    this.decoder = new FrameDecoder();
    this.v1Decoder = new ClientFrameDecoder();
    this.info = null;
    dbg(`connect ${deviceId}`);

    let device: Device | null = null;
    let lastError: unknown = null;
    // iOS: перед connectToDevice скан обязательно остановлен + пауза 250 мс.
    await manager().stopDeviceScan().catch(() => undefined);
    await delay(250);
    for (let attempt = 0; attempt < 2 && !device; attempt += 1) {
      try {
        device = await manager().connectToDevice(deviceId, { requestMTU: 185, timeout: 15_000 });
      } catch (error) {
        lastError = error;
        await delay(250);
      }
    }
    if (!device) {
      this.deviceId = null;
      throw new ModuleTransportError(
        `Не удалось подключиться к модулю: ${lastError instanceof Error ? lastError.message : String(lastError ?? '')}`,
        'io',
      );
    }
    try {
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
      BLE_UUIDS.tx,
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
    // Android иногда подтверждает подписку на notify с задержкой, поэтому
    // первый HELLO уходит не сразу.
    await delay(250);
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
      // KMesh_v1 HELLO: текущие прошивки отвечают INFO в новом формате.
      try {
        const helloPayloadV1 = new TextEncoder().encode(
          JSON.stringify({ v: 3, kind: 'hello', app: 'klinto', client: 'native-ble' }),
        );
        await this.writeBytes(
          encodeClientFrame(ClientFrameType.HELLO, helloPayloadV1, this.v1HelloSeq++ & 0xffff),
        );
      } catch {
        /* v1-канал опционален: legacy HELLO уже отправлен */
      }
      dbg(`hello attempt ${attempt + 1}`);
    }
    const info = await this.waitInfo(INFO_TIMEOUT_MS, helloError ?? undefined).catch(async (error: unknown) => {
      await this.close().catch(() => undefined);
      throw error;
    });
    this.info = info;
    return info;
  }

  private handleChunk(chunk: Uint8Array): void {
    if (chunk.length) dbg(`rx ${chunk.length}b`);
    for (const handler of this.rawHandlers) {
      try {
        handler(chunk);
      } catch {
        /* ignore */
      }
    }
    for (const frame of this.decoder.push(chunk)) this.handleFrame(frame);
    for (const frame of this.v1Decoder.push(chunk)) {
      if (frame.type !== ClientFrameType.INFO) continue;
      const info = this.infoFromV1(frame.payload);
      if (!info) continue;
      dbg(`v1 info node=${info.publicId ?? '?'} gateway=${info.gateway ? 1 : 0}`);
      this.applyInfo(info);
      if (this.infoWaiter) {
        clearTimeout(this.infoWaiter.timer);
        this.infoWaiter.resolve(info);
        this.infoWaiter = null;
      }
    }
  }

  /** ModuleInfo из KMesh_v1 INFO: nodeId/hardwareId выводятся из node_id. */
  private infoFromV1(payload: Uint8Array): ModuleInfo | null {
    try {
      const raw = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      const nodeId = Number(raw.nodeId ?? 0) >>> 0;
      if (!nodeId) return null;
      const roleNum = Number(raw.role ?? 0);
      const role = roleNum === 2 ? 'gateway' : roleNum === 1 ? 'repeater' : 'wearable';
      const hardwareId =
        typeof raw.hardwareId === 'string' && raw.hardwareId
          ? raw.hardwareId
          : `esp32-${nodeId.toString(16).padStart(8, '0')}`;
      return normalizeInfo({
        hardwareId,
        publicId: String(nodeId),
        role,
        firmware: typeof raw.firmware === 'string' ? raw.firmware : '',
        battery: Number(raw.battery ?? this.info?.battery ?? 0),
        attached: true,
        gateway: raw.gateway === true,
        queue: Number(raw.queue ?? 0),
        ownerNetId: Number(raw.ownerNetId ?? 0) >>> 0,
        ownerPrefix: String(raw.ownerPrefix ?? '00000000').toLowerCase(),
        bleMod6: typeof raw.bleMod6 === 'string' ? raw.bleMod6.toLowerCase() : undefined,
      });
    } catch {
      return null;
    }
  }

  /** Обновляет info и рассылает его подписчикам (шапка чатов, транспорт). */
  private applyInfo(info: ModuleInfo): void {
    this.info = info;
    dbg(`info ${info.hardwareId} role=${info.role} gw=${info.gateway ? 1 : 0} q=${info.queue}`);
    for (const handler of this.infoHandlers) {
      try {
        handler(info);
      } catch {
        /* один слушатель не должен ломать остальные */
      }
    }
  }

  private handleFrame(frame: DecodedFrame): void {
    switch (frame.type) {
      case FrameType.INFO: {
        const parsed = parseModuleInfo(frame.payload);
        if (parsed) {
          const info = normalizeInfo(parsed);
          this.applyInfo(info);
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
    const bool = (value: unknown, fallback: boolean | undefined): boolean | undefined => {
      if (value === undefined || value === null) return fallback;
      return value === true || value === 1 || value === '1' || value === 'true';
    };
    const next: ModuleInfo = {
      ...this.info,
      attached: raw.attached === true || Number(raw.attached) === 1 ? true : this.info.attached,
      queue: Number.isFinite(Number(raw.queue)) ? Number(raw.queue) : this.info.queue,
      rssi: Number.isFinite(Number(raw.rssi)) ? Number(raw.rssi) : this.info.rssi,
      battery: Number.isFinite(Number(raw.battery)) ? Number(raw.battery) : this.info.battery,
      meshRole: typeof raw.meshRole === 'string' ? raw.meshRole : this.info.meshRole,
      gateway: bool(raw.gateway, this.info.gateway),
      firmware: typeof raw.firmware === 'string' ? raw.firmware : this.info.firmware,
      neighbors: Number.isFinite(Number(raw.neighbors)) ? Math.max(0, Number(raw.neighbors)) : this.info.neighbors,
      border: bool(raw.border, this.info.border),
    };
    this.applyInfo(next);
  }

  private waitInfo(timeoutMs: number, cause?: Error): Promise<ModuleInfo> {
    if (this.info) return Promise.resolve(this.info);
    return new Promise<ModuleInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.infoWaiter = null;
        dbg(`info timeout ${timeoutMs}ms${cause ? `: ${cause.message}` : ''}`);
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

  /** Сырая запись байтов в RX-характеристику (без A5 5A-конверта). */
  private writeBytes(frame: Uint8Array): Promise<void> {
    const run = async (): Promise<void> => {
      const deviceId = this.deviceId;
      if (!deviceId || this.closing) {
        throw new ModuleTransportError('Bluetooth не подключён.', 'closed');
      }
      const chunkSize = 20;
      for (let offset = 0; offset < frame.length; offset += chunkSize) {
        const chunk = frame.slice(offset, offset + chunkSize);
        await manager().writeCharacteristicWithResponseForDevice(
          deviceId,
          BLE_UUIDS.service,
          BLE_UUIDS.rx,
          bytesToBase64(chunk),
        );
      }
    };
    const next = this.writeChain.then(run, run);
    // Ошибку одного кадра не тащим в очередь следующих запросов.
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  /** Чанк ровно 20 байт — как в web, чтобы не упираться в длинные write на iOS. */
  private writeFrame(type: number, payload: Uint8Array): Promise<void> {
    return this.writeBytes(encodeFrame(type, payload));
  }

  /** KMesh_v1: отправить готовый бинарный кадр в тот же GATT. */
  async sendRaw(frame: Uint8Array): Promise<boolean> {
    if (!this.isOpen) return false;
    try {
      await this.writeBytes(frame);
      return true;
    } catch {
      return false;
    }
  }

  /** KMesh_v1: подписка на сырые чанки до разбора legacy-кадров. */
  onRaw(callback: (chunk: Uint8Array) => void): () => void {
    this.rawHandlers.add(callback);
    return () => this.rawHandlers.delete(callback);
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

  /** SET_OWNER: prefix(8) net(4) epoch(4) sig_len(1) DER-подпись. */
  async setOwner(claim: { prefix: string; netId: number; epoch: number; signature: string }): Promise<void> {
    if (!this.isOpen) throw new ModuleTransportError('Bluetooth не подключён.', 'closed');
    const sig: number[] = [];
    for (let i = 0; i + 1 < claim.signature.length; i += 2) {
      sig.push(parseInt(claim.signature.slice(i, i + 2), 16));
    }
    if (!sig.length || sig.length > 72) {
      throw new ModuleTransportError('Некорректная подпись передачи модуля.', 'io');
    }
    const payload = new Uint8Array(17 + sig.length);
    const prefix = claim.prefix.toLowerCase();
    for (let i = 0; i < 8; i += 1) payload[i] = prefix.charCodeAt(i) & 0xff;
    const view = new DataView(payload.buffer);
    view.setUint32(8, claim.netId >>> 0, true);
    view.setUint32(12, claim.epoch >>> 0, true);
    payload[16] = sig.length;
    payload.set(sig, 17);
    await this.writeFrame(FrameType.SET_OWNER, payload);
  }

  onEnvelope(callback: (message: ModuleEnvelope) => void): () => void {
    this.envelopeHandlers.add(callback);
    return () => this.envelopeHandlers.delete(callback);
  }

  onInfo(callback: (info: ModuleInfo) => void): () => void {
    this.infoHandlers.add(callback);
    // Отдаём текущее состояние сразу, чтобы UI не ждал следующего INFO.
    if (this.info) {
      try {
        callback(this.info);
      } catch {
        /* ignore */
      }
    }
    return () => this.infoHandlers.delete(callback);
  }

  onDisconnect(callback: () => void): () => void {
    this.disconnectHandlers.add(callback);
    return () => this.disconnectHandlers.delete(callback);
  }

  private emitDisconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.info = null;
    // Освобождаем GATT-соединение: иначе модуль остаётся «занятым» системой,
    // перестаёт рекламироваться, и приложение больше не может его найти.
    const deviceId = this.deviceId;
    if (deviceId) {
      void manager()
        .cancelDeviceConnection(deviceId)
        .catch(() => undefined);
    }
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
