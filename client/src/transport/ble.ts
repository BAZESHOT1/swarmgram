/**
 * Реальный BLE-транспорт к ESP32-модулю.
 * Web: Web Bluetooth (Chrome/Android Chrome) — полное сканирование+GATT.
 * Нативные платформы: нужно собирать приложение с expo-dev client, там где
 * `navigator.bluetooth` недоступен — реальное состояние сообщается наружу
 * через UnsupportedError, интерфейс остаётся тем же.
 */
import { MODULE_UUIDS, type MeshNeighbor, type ModuleLink, type ModulePacket, UnsupportedError } from './transport';

interface WebBleCharacteristic {
  value: DataView | null;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<WebBleCharacteristic>;
  addEventListener(type: string, cb: (e: any) => void): void;
  stopNotifications?(): Promise<void>;
}

interface WebBleServerLike {
  connected: boolean;
  connect(): Promise<WebBleServerLike>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<WebBleCharacteristic> }>;
}

interface WebBleDeviceLike {
  id?: string;
  name?: string;
  gatt?: WebBleServerLike;
}

declare const navigator: any;

export class WebBleModule implements ModuleLink {
  private device: WebBleDeviceLike | undefined;
  private writeChar: WebBleCharacteristic | undefined;
  private handlers: ((p: ModulePacket) => void)[] = [];
  private buffer = '';
  public moduleId = '';
  public boardUuid = '';
  public firmware = '';
  public kind: 'wifi' | 'lora' = 'wifi';

  static supported(): boolean {
    return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth?.requestDevice);
  }

  async requestDevice(): Promise<WebBleDeviceLike | undefined> {
    if (!WebBleModule.supported()) {
      throw new UnsupportedError('BLE недоступен в этом окружении (нужен HTTPS-браузер с Web Bluetooth)');
    }
    this.device = (await navigator.bluetooth.requestDevice({
      filters: [{ services: [MODULE_UUIDS.service] }],
      optionalServices: [MODULE_UUIDS.service],
    })) as WebBleDeviceLike;
    return this.device;
  }

  async connect(): Promise<void> {
    if (!this.device?.gatt) throw new UnsupportedError('BLE устройство не выбрано');
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(MODULE_UUIDS.service);
    const infoChar = await service.getCharacteristic(MODULE_UUIDS.info);
    await infoChar.startNotifications();
    infoChar.addEventListener('characteristicvaluechanged', (e: any) => {
      const data = new TextDecoder().decode(e.target.value as ArrayBuffer);
      this.buffer += data;
      for (;;) {
        const idx = this.buffer.indexOf('\n');
        if (idx < 0) break;
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          this.dispatch(JSON.parse(line) as ModulePacket);
        } catch {
          /* некорректный пакет модуля игнорируем */
        }
      }
    });

    const raw = await infoChar.readValue().catch(() => null);
    if (raw) {
      const hello = new TextDecoder().decode(raw as unknown as ArrayBuffer);
      try {
        const packet = JSON.parse(hello) as ModulePacket;
        if (packet.type === 'hello') {
          this.boardUuid = packet.boardUuid;
          this.firmware = packet.firmware;
          this.kind = packet.kind;
        }
      } catch { /* hello может прийти сразу после connect */ }
    }
    this.writeChar = await service.getCharacteristic(MODULE_UUIDS.write);
    this.moduleId = this.device.id ?? this.boardUuid;
  }

  private dispatch(p: ModulePacket): void {
    this.handlers.forEach((h) => h(p));
  }

  async writeToken(token: string): Promise<void> {
    if (!this.writeChar) throw new UnsupportedError('BLE не подключён');
    const data = new TextEncoder().encode(`${JSON.stringify({ v: 1, type: 'token', token })}\n`);
    await this.writeChar.writeValue(data);
  }

  async sendEnvelope(envelope: string): Promise<void> {
    if (!this.writeChar) throw new UnsupportedError('BLE не подключён');
    const data = new TextEncoder().encode(`${JSON.stringify({ v: 1, type: 'envelope', payload: envelope })}\n`);
    await this.writeChar.writeValue(data);
  }

  async requestScan(): Promise<void> {
    if (!this.writeChar) throw new UnsupportedError('BLE не подключён');
    const data = new TextEncoder().encode(`${JSON.stringify({ v: 1, type: 'scan' })}\n`);
    await this.writeChar.writeValue(data);
  }

  onPacket(cb: (p: ModulePacket) => void): void {
    this.handlers.push(cb);
  }

  async disconnect(): Promise<void> {
    try {
      this.device?.gatt?.disconnect();
    } catch { /* ignore */ }
  }
}

export function neighborsOf(p: ModulePacket): MeshNeighbor[] {
  return p.type === 'neighbors' ? p.neighbors : [];
}
