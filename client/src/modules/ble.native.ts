/**
 * Нативный BLE-транспорт (Android/iOS) поверх react-native-ble-plx.
 *
 * Этот файл попадает только в native-бандл: web-сборка использует ble.web.ts,
 * поэтому react-native-ble-plx никогда не тянется в браузер.
 */
import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';
import {
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

let sharedManager: BleManager | null = null;

function manager(): BleManager {
  if (!sharedManager) sharedManager = new BleManager();
  return sharedManager;
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
 * BLE-подключение к модулю. Сканирует по сервису a5c0, подключается,
 * поднимает MTU 185, слушает a5c2 и пишет в a5c1 чанками ≤ MTU-3.
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

  /** Сканирование 4 секунды; устройства фильтруются по сервису a5c0. */
  async scan(durationMs = 4000): Promise<ScannedModule[]> {
    const found = new Map<string, ScannedModule>();
    try {
      await manager().startDeviceScan([BLE_UUIDS.service], { allowDuplicates: false }, (error, device) => {
        if (error || !device) return;
        if (!found.has(device.id)) {
          found.set(device.id, {
            id: device.id,
            name: device.localName || device.name || 'SG-модуль',
            rssi: Number(device.rssi ?? 0),
          });
        }
      });
    } catch (error) {
      throw new ModuleTransportError(
        `Не удалось начать сканирование Bluetooth: ${error instanceof Error ? error.message : String(error)}. ` +
          'Проверьте разрешения Bluetooth.',
        'io',
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
    await manager().stopDeviceScan().catch(() => undefined);
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
      device = await manager().connectToDevice(deviceId, { requestMTU: 185, timeout: 10_000 });
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

    await this.writeFrame(FrameType.HELLO, encodeJson(helloPayload('native-ble')));
    const info = await this.waitInfo(3000);
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
    this.info = {
      ...this.info,
      attached: typeof raw.attached === 'boolean' ? raw.attached : this.info.attached,
      queue: Number.isFinite(Number(raw.queue)) ? Number(raw.queue) : this.info.queue,
      rssi: Number.isFinite(Number(raw.rssi)) ? Number(raw.rssi) : this.info.rssi,
      battery: Number.isFinite(Number(raw.battery)) ? Number(raw.battery) : this.info.battery,
      meshRole: typeof raw.meshRole === 'string' ? raw.meshRole : this.info.meshRole,
      firmware: typeof raw.firmware === 'string' ? raw.firmware : this.info.firmware,
    };
  }

  private waitInfo(timeoutMs: number): Promise<ModuleInfo> {
    if (this.info) return Promise.resolve(this.info);
    return new Promise<ModuleInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.infoWaiter = null;
        reject(
          new ModuleTransportError(
            'Модуль не ответил на HELLO. Проверьте прошивку и поднесите модуль ближе.',
            'timeout',
          ),
        );
      }, timeoutMs);
      this.infoWaiter = { resolve, reject, timer };
    });
  }

  /** Чанк ≤ MTU-3 (минимум 20 байт для старых устройств). */
  private async writeFrame(type: number, payload: Uint8Array): Promise<void> {
    const deviceId = this.deviceId;
    if (!deviceId || this.closing) {
      throw new ModuleTransportError('Bluetooth не подключён.', 'closed');
    }
    const frame = encodeFrame(type, payload);
    const chunkSize = Math.max(20, this.mtu - 3);
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
