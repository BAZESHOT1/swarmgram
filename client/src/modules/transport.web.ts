/**
 * Web-транспорты модуля: USB (Web Serial) и Bluetooth (Web Bluetooth).
 *
 * Файл не импортирует нативный BLE — веб-бандл остаётся чистым.
 * На iOS Safari Web Bluetooth/Web Serial отсутствуют; это честно
 * сообщается через supported=false и понятную ошибку.
 */
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

/* ------------------------------------------------------- общие события --- */

abstract class BaseModuleConnection implements ModuleConnection {
  abstract readonly kind: ConnectionKind;
  abstract readonly supported: boolean;
  protected abstract get openState(): boolean;

  info: ModuleInfo | null = null;
  protected readonly envelopeHandlers = new Set<(message: ModuleEnvelope) => void>();
  protected readonly disconnectHandlers = new Set<() => void>();
  protected disconnected = false;

  get isOpen(): boolean {
    return this.openState;
  }

  abstract open(): Promise<ModuleInfo>;
  abstract sendEnvelope(chatId: string, envelope: unknown): Promise<void>;
  abstract close(): Promise<void>;

  /** По умолчанию транспорт не умеет менять Wi-Fi роутера. */
  async sendConfig(_config: ModuleWifiConfig): Promise<void> {
    throw new ModuleTransportError('Этот транспорт не поддерживает настройку Wi-Fi шлюза.', 'unsupported');
  }

  onEnvelope(callback: (message: ModuleEnvelope) => void): () => void {
    this.envelopeHandlers.add(callback);
    return () => this.envelopeHandlers.delete(callback);
  }

  onDisconnect(callback: () => void): () => void {
    this.disconnectHandlers.add(callback);
    return () => this.disconnectHandlers.delete(callback);
  }

  protected emitEnvelope(message: ModuleEnvelope): void {
    for (const handler of this.envelopeHandlers) {
      try {
        handler(message);
      } catch {
        /* подписчик не должен ломать чтение порта */
      }
    }
  }

  /** Вызывается один раз: транспорт потерял связь. */
  protected emitDisconnect(): void {
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
}

/* --------------------------------------------------------- Web Serial ---- */

interface SerialPortLike {
  readable?: { getReader(): { read(): Promise<{ value?: Uint8Array; done: boolean }>; cancel(reason?: unknown): Promise<void>; releaseLock?(): void } } | null;
  writable?: { getWriter(): { write(data: Uint8Array): Promise<void>; releaseLock?(): void; close?(): Promise<void> } } | null;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
  forget?(): Promise<void>;
}

interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(options?: { filters?: Array<Record<string, unknown>> }): Promise<SerialPortLike>;
  addEventListener?(type: string, listener: () => void): void;
}

function serialApi(): SerialLike | null {
  if (typeof navigator === 'undefined') return null;
  const api = (navigator as unknown as { serial?: SerialLike }).serial;
  return api && typeof api.getPorts === 'function' ? api : null;
}

export function webSerialSupported(): boolean {
  return serialApi() !== null;
}

/** USB-транспорт поверх Web Serial (Chromium, HTTPS/localhost). */
export class WebSerialModuleTransport extends BaseModuleConnection {
  readonly kind: ConnectionKind = 'usb';
  private port: SerialPortLike | null = null;
  private reader: ReturnType<NonNullable<SerialPortLike['readable']>['getReader']> | null = null;
  private writer: ReturnType<NonNullable<SerialPortLike['writable']>['getWriter']> | null = null;
  private decoder = new FrameDecoder();
  private closing = false;
  private writeChain: Promise<void> = Promise.resolve();
  private infoWaiter: {
    resolve: (info: ModuleInfo) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly expectedHardwareId?: string;

  constructor(expectedHardwareId?: string) {
    super();
    this.expectedHardwareId = expectedHardwareId;
  }

  get supported(): boolean {
    return webSerialSupported();
  }

  protected get openState(): boolean {
    return Boolean(this.port && this.writer && !this.closing);
  }

  /** Ранее разрешённые браузером порты (без системного окна выбора). */
  async listKnownPorts(): Promise<SerialPortLike[]> {
    const api = serialApi();
    if (!api) return [];
    try {
      return await api.getPorts();
    } catch {
      return [];
    }
  }

  /** Запрашивает порт у пользователя (жест пользователя обязателен). */
  async requestPort(): Promise<SerialPortLike> {
    const api = serialApi();
    if (!api) {
      throw new ModuleTransportError(
        'Web Serial недоступен: откройте сайт в Chrome/Edge на компьютере по HTTPS или localhost.',
        'unsupported',
      );
    }
    return api.requestPort();
  }

  /** Открыть порт с запросом у пользователя. */
  async open(): Promise<ModuleInfo> {
    const port = await this.requestPort();
    return this.openPort(port);
  }

  /**
   * Автовосстановление без окна выбора порта: перебирает уже разрешённые
   * порты и ищет совпадение по hardwareId. Ничего не запрашивает.
   */
  async openKnown(hardwareId?: string, timeoutMs = 3000): Promise<ModuleInfo | null> {
    if (!this.supported) return null;
    const ports = await this.listKnownPorts();
    if (!ports.length) return null;
    const expected = (hardwareId ?? this.expectedHardwareId ?? '').toLowerCase();
    let first: ModuleInfo | null = null;
    for (const port of ports) {
      try {
        const info = await this.openPort(port, timeoutMs);
        if (!expected) return info;
        if (info.hardwareId.toLowerCase() === expected) return info;
        first = first ?? info;
        await this.close();
      } catch {
        await this.close().catch(() => undefined);
      }
    }
    // Сохранённый модуль не найден — не подключаемся к чужому порту.
    if (expected) return null;
    return first;
  }

  private async openPort(port: SerialPortLike, timeoutMs = 3000): Promise<ModuleInfo> {
    if (this.openState) await this.close();
    this.closing = false;
    this.disconnected = false;
    this.decoder = new FrameDecoder();
    this.info = null;

    try {
      await port.open({ baudRate: 115200, bufferSize: 4096 });
    } catch (error) {
      throw new ModuleTransportError(
        `Не удалось открыть USB-порт: ${error instanceof Error ? error.message : String(error)}. ` +
          'Закройте Arduino IDE/PlatformIO и проверьте кабель.',
        'io',
      );
    }

    this.port = port;
    const writable = port.writable;
    if (!writable) {
      await this.close();
      throw new ModuleTransportError('USB-порт открыт, но запись недоступна.', 'io');
    }
    this.writer = writable.getWriter();
    this.startReadLoop(port);

    await this.sendFrame(
      FrameType.HELLO,
      encodeJson(helloPayload('web', this.expectedHardwareId)),
    );
    const info = await this.waitInfo(timeoutMs);
    this.info = info;
    return info;
  }

  private startReadLoop(port: SerialPortLike): void {
    const readable = port.readable;
    if (!readable) {
      void this.close();
      return;
    }
    const reader = readable.getReader();
    this.reader = reader;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) this.handleChunk(value);
        }
      } catch {
        /* порт выдернули — ниже сообщим о разрыве */
      } finally {
        if (!this.closing) this.emitDisconnect();
      }
    })();
  }

  private handleChunk(chunk: Uint8Array): void {
    const frames = this.decoder.push(chunk);
    for (const frame of frames) this.handleFrame(frame);
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
        if (message) this.emitEnvelope(message);
        break;
      }
      case FrameType.STATUS: {
        this.mergeStatus(frame.payload);
        break;
      }
      case FrameType.PING: {
        void this.sendFrame(FrameType.PONG, encodeJson({ v: 1, kind: 'status' })).catch(() => undefined);
        break;
      }
      default:
        break;
    }
  }

  private mergeStatus(payload: Uint8Array): void {
    if (!this.info) return;
    const raw = (() => {
      try {
        return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })();
    if (!raw || typeof raw !== 'object') return;
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
            'Модуль не ответил на HELLO за 3 секунды. Проверьте питание, кабель и что прошивка поддерживает USB-протокол.',
            'timeout',
          ),
        );
      }, timeoutMs);
      this.infoWaiter = { resolve, reject, timer };
    });
  }

  private async sendFrame(type: number, payload: Uint8Array): Promise<void> {
    const writer = this.writer;
    if (!writer || !this.port) {
      throw new ModuleTransportError('USB-порт не открыт.', 'closed');
    }
    const frame = encodeFrame(type, payload);
    // Последовательная очередь: Web Serial не любит параллельные write.
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => writer.write(frame));
    await this.writeChain;
  }

  async sendEnvelope(chatId: string, envelope: unknown): Promise<void> {
    if (!this.isOpen) throw new ModuleTransportError('USB-порт не открыт.', 'closed');
    await this.sendFrame(
      FrameType.DATA_UP,
      encodeJson({ v: 1, kind: 'envelope', direction: 'up', chatId, envelope }),
    );
  }

  /** SET_CONFIG: SSID/пароль роутера уходят шлюзу, в логи не пишутся. */
  async sendConfig(config: ModuleWifiConfig): Promise<void> {
    if (!this.isOpen) throw new ModuleTransportError('USB-порт не открыт.', 'closed');
    await this.sendFrame(
      FrameType.SET_CONFIG,
      encodeJson(configPayload(config.wifiSsid, config.wifiPassword)),
    );
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
      await this.reader?.cancel();
    } catch {
      /* already released */
    }
    this.reader = null;

    try {
      this.writer?.releaseLock?.();
    } catch {
      /* ignore */
    }
    this.writer = null;

    const port = this.port;
    this.port = null;
    if (port) {
      try {
        await port.close();
      } catch {
        /* порт мог быть уже закрыт системой */
      }
    }
  }
}

/* ------------------------------------------------------ Web Bluetooth ---- */

interface BluetoothCharacteristicLike {
  value?: DataView | null;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothCharacteristicLike>;
  stopNotifications?(): Promise<BluetoothCharacteristicLike>;
  addEventListener(type: string, listener: (event: { target?: { value?: DataView | null } }) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

interface BluetoothServiceLike {
  getCharacteristic(uuid: string): Promise<BluetoothCharacteristicLike>;
}

interface BluetoothServerLike {
  connected: boolean;
  connect(): Promise<BluetoothServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothServiceLike>;
}

export interface WebBluetoothDeviceLike {
  id?: string;
  name?: string | null;
  gatt?: BluetoothServerLike;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

interface BluetoothLike {
  requestDevice(options: {
    filters?: Array<Record<string, unknown>>;
    optionalServices?: string[];
    acceptAllDevices?: boolean;
  }): Promise<WebBluetoothDeviceLike>;
  getDevices?(): Promise<WebBluetoothDeviceLike[]>;
}

function bluetoothApi(): BluetoothLike | null {
  if (typeof navigator === 'undefined') return null;
  const api = (navigator as unknown as { bluetooth?: BluetoothLike }).bluetooth;
  return api && typeof api.requestDevice === 'function' ? api : null;
}

export function webBluetoothSupported(): boolean {
  return bluetoothApi() !== null;
}

/** Запрос BLE-устройства с фильтром по сервису a5c0 (жест пользователя). */
export async function scanWebBluetooth(): Promise<WebBluetoothDeviceLike> {
  const api = bluetoothApi();
  if (!api) {
    throw new ModuleTransportError(
      'Web Bluetooth недоступен. На iOS Safari его нет — используйте нативное приложение; ' +
        'на Android откройте Chrome по HTTPS.',
      'unsupported',
    );
  }
  return api.requestDevice({
    filters: [{ services: [BLE_UUIDS.service] }],
    optionalServices: [BLE_UUIDS.service],
  });
}

/** BLE-транспорт поверх Web Bluetooth (Chrome/Edge, Android Chrome). */
export class WebBluetoothModuleTransport extends BaseModuleConnection {
  readonly kind: ConnectionKind = 'ble';
  private device: WebBluetoothDeviceLike | null = null;
  private server: BluetoothServerLike | null = null;
  private tx: BluetoothCharacteristicLike | null = null;
  private rx: BluetoothCharacteristicLike | null = null;
  private statusChar: BluetoothCharacteristicLike | null = null;
  private decoder = new FrameDecoder();
  private closing = false;
  private infoWaiter: {
    resolve: (info: ModuleInfo) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly onGattDisconnected = () => {
    if (!this.closing) this.emitDisconnect();
  };

  get supported(): boolean {
    return webBluetoothSupported();
  }

  protected get openState(): boolean {
    return Boolean(this.server?.connected && this.tx && !this.closing);
  }

  async open(): Promise<ModuleInfo> {
    const device = await scanWebBluetooth();
    return this.openDevice(device);
  }

  /** Автовосстановление: Chrome умеет отдавать ранее разрешённые устройства. */
  async openKnown(hardwareId?: string, timeoutMs = 3000): Promise<ModuleInfo | null> {
    const api = bluetoothApi();
    if (!api?.getDevices) return null;
    try {
      const devices = await api.getDevices();
      if (!devices.length) return null;
      const expected = (hardwareId ?? '').toLowerCase();
      const sorted = expected
        ? [...devices].sort((a, b) => Number((b.id ?? '').includes(expected)) - Number((a.id ?? '').includes(expected)))
        : devices;
      for (const device of sorted.slice(0, 4)) {
        try {
          const info = await this.openDevice(device, timeoutMs);
          if (!expected || info.hardwareId.toLowerCase() === expected) return info;
          await this.close();
        } catch {
          await this.close().catch(() => undefined);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async openDevice(device: WebBluetoothDeviceLike, timeoutMs = 3000): Promise<ModuleInfo> {
    if (this.openState) await this.close();
    this.closing = false;
    this.disconnected = false;
    this.decoder = new FrameDecoder();
    this.info = null;
    this.device = device;

    if (!device.gatt) {
      throw new ModuleTransportError('Устройство не поддерживает GATT.', 'unsupported');
    }
    try {
      this.server = await device.gatt.connect();
      const service = await this.server.getPrimaryService(BLE_UUIDS.service);
      this.tx = await service.getCharacteristic(BLE_UUIDS.tx);
      this.rx = await service.getCharacteristic(BLE_UUIDS.rx);
      this.statusChar = await service.getCharacteristic(BLE_UUIDS.status).catch(() => null);

      await this.rx.startNotifications();
      this.rx.addEventListener('characteristicvaluechanged', this.onRxValue);
      if (this.statusChar) {
        await this.statusChar.startNotifications().catch(() => undefined);
        this.statusChar.addEventListener('characteristicvaluechanged', this.onStatusValue);
      }
      device.addEventListener?.('gattserverdisconnected', this.onGattDisconnected);
    } catch (error) {
      await this.close().catch(() => undefined);
      throw new ModuleTransportError(
        `Не удалось подключиться по Bluetooth: ${error instanceof Error ? error.message : String(error)}`,
        'io',
      );
    }

    await this.writeFrame(FrameType.HELLO, encodeJson(helloPayload('web-ble')));
    const info = await this.waitInfo(timeoutMs);
    this.info = info;
    return info;
  }

  private readonly onRxValue = (event: { target?: { value?: DataView | null } }) => {
    const view = event.target?.value;
    if (!view) return;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (const frame of this.decoder.push(bytes)) this.handleFrame(frame);
  };

  private readonly onStatusValue = (event: { target?: { value?: DataView | null } }) => {
    const view = event.target?.value;
    if (!view) return;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    this.mergeStatus(bytes);
  };

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
        if (message) this.emitEnvelope(message);
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
    };
  }

  private waitInfo(timeoutMs: number): Promise<ModuleInfo> {
    if (this.info) return Promise.resolve(this.info);
    return new Promise<ModuleInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.infoWaiter = null;
        reject(
          new ModuleTransportError(
            'Модуль не ответил по Bluetooth за 3 секунды. Поднесите его ближе и переподключитесь.',
            'timeout',
          ),
        );
      }, timeoutMs);
      this.infoWaiter = { resolve, reject, timer };
    });
  }

  /** BLE-пакет ограничен MTU; надёжный размер по умолчанию — 20 байт. */
  private async writeFrame(type: number, payload: Uint8Array): Promise<void> {
    const tx = this.tx;
    if (!tx) throw new ModuleTransportError('Bluetooth-характеристика записи недоступна.', 'closed');
    const frame = encodeFrame(type, payload);
    const chunkSize = 20;
    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      const chunk = frame.slice(offset, offset + chunkSize);
      await tx.writeValue(chunk);
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
    this.device?.removeEventListener?.('gattserverdisconnected', this.onGattDisconnected);
    try {
      this.rx?.removeEventListener?.('characteristicvaluechanged', this.onRxValue as unknown as (event: unknown) => void);
      this.statusChar?.removeEventListener?.('characteristicvaluechanged', this.onStatusValue as unknown as (event: unknown) => void);
    } catch {
      /* ignore */
    }
    try {
      await this.rx?.stopNotifications?.();
      await this.statusChar?.stopNotifications?.();
    } catch {
      /* ignore */
    }
    try {
      this.server?.disconnect();
    } catch {
      /* ignore */
    }
    this.server = null;
    this.tx = null;
    this.rx = null;
    this.statusChar = null;
    this.device = null;
  }
}

/* ---------------------------------------------------------- фабрика ----- */

/**
 * Выбирает транспорт под платформу. В web-бандле доступны USB и BLE;
 * на нативе этот файл не используется (см. transport.native.ts).
 */
export function getModuleTransport(kind: ConnectionKind = 'usb'): ModuleConnection {
  if (kind === 'ble') return new WebBluetoothModuleTransport();
  return new WebSerialModuleTransport();
}
