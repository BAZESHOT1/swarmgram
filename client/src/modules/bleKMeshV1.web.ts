/**
 * Web Bluetooth транспорт KMesh_v1.
 */
import { BLE_UUIDS } from './protocol';
import type { KMeshV1Link } from '../kmesh/v1/client';
import { b64ToBytes, bytesToB64 } from '../kmesh/v1/crypto';

declare const navigator: any;

export class BleKMeshV1Link implements KMeshV1Link {
  private device: any = null;
  private server: any = null;
  private rx: any = null;
  private handler: ((chunk: Uint8Array) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  static supported(): boolean {
    return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth?.requestDevice);
  }

  async connect(): Promise<void> {
    if (!BleKMeshV1Link.supported()) throw new Error('web_bluetooth_unavailable');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_UUIDS.service] }],
      optionalServices: [BLE_UUIDS.service],
    });
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(BLE_UUIDS.service);
    this.rx = await service.getCharacteristic(BLE_UUIDS.rx);
    for (const uuid of [BLE_UUIDS.tx, BLE_UUIDS.status]) {
      const ch = await service.getCharacteristic(uuid);
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (event: any) => {
        const value = event?.target?.value;
        if (!value) return;
        const bytes = new Uint8Array(value.buffer ?? value);
        this.handler?.(bytes);
      });
    }
  }

  onData(handler: (chunk: Uint8Array) => void): void {
    this.handler = handler;
  }

  async send(frame: Uint8Array): Promise<boolean> {
    if (!this.rx) return false;
    const run = async () => {
      /* Web Bluetooth режет по согласованному ATT MTU; 20 байт — безопасный
       * минимум. Мост ESP32 собирает кадр на уровне протокола. */
      const size = 180;
      for (let offset = 0; offset < frame.length; offset += size) {
        const chunk = frame.subarray(offset, Math.min(frame.length, offset + size));
        if (this.rx.writeValueWithoutResponse) {
          await this.rx.writeValueWithoutResponse(chunk);
        } else {
          await this.rx.writeValue(chunk);
        }
      }
      return true;
    };
    this.queue = this.queue.then(run, run);
    return (await this.queue.catch(() => false)) === true;
  }

  async disconnect(): Promise<void> {
    try {
      this.device?.gatt?.disconnect();
    } catch {
      /* ignore */
    }
    this.device = null;
    this.server = null;
    this.rx = null;
  }
}

export { b64ToBytes, bytesToB64 };
