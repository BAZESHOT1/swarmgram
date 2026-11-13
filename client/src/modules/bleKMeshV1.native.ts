/**
 * Нативный BLE-транспорт KMesh_v1 (react-native-ble-plx).
 *
 * GATT-профиль использует прежние короткие UUID, но бинарный протокол
 * вместо JSONL. Кадры режутся по текущему ATT MTU, KlintoClientBridge
 * собирает их на ESP32.
 */
import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';
import { BLE_UUIDS, BLE_SHORT_UUIDS } from './protocol';
import type { KMeshV1Link } from '../kmesh/v1/client';
import { b64ToBytes, bytesToB64 } from '../kmesh/v1/crypto';

let managerInstance: BleManager | null = null;
function manager(): BleManager {
  if (!managerInstance) managerInstance = new BleManager();
  return managerInstance;
}


export class BleKMeshV1Link implements KMeshV1Link {
  private device: Device | null = null;
  private subs: Subscription[] = [];
  private handler: ((chunk: Uint8Array) => void) | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();

  static supported(): boolean {
    return true;
  }

  async connect(timeoutMs = 12000, namePrefix = 'Klinto-'): Promise<Device> {
    if (this.device) return this.device;
    const m = manager();
    const found = await new Promise<Device>((resolve, reject) => {
      const timer = setTimeout(() => {
        void m.stopDeviceScan();
        reject(new Error('ble_scan_timeout'));
      }, timeoutMs);
      m.startDeviceScan([BLE_UUIDS.service], { allowDuplicates: false }, (error, device) => {
        if (error) {
          clearTimeout(timer);
          void m.stopDeviceScan();
          reject(error);
          return;
        }
        if (!device) return;
        const name = device.name ?? device.localName ?? '';
        const services = (device.serviceUUIDs ?? []).map((s) => s.toLowerCase());
        const matchesService = services.some((s) => s === BLE_SHORT_UUIDS.service || s.endsWith('a5c0-0000-1000-8000-00805f9b34fb'));
        if (matchesService || name.startsWith(namePrefix)) {
          clearTimeout(timer);
          void m.stopDeviceScan();
          resolve(device);
        }
      });
    });

    this.device = await found.connect();
    await this.device.discoverAllServicesAndCharacteristics();
    const mtu = await this.device.requestMTU(247).catch(() => 23);
    void mtu;
    this.subs.push(this.device.monitorCharacteristicForService(BLE_UUIDS.service, BLE_UUIDS.tx, (err, ch) => {
      if (!err && ch?.value) this.handler?.(b64ToBytes(ch.value));
    }));
    this.subs.push(this.device.monitorCharacteristicForService(BLE_UUIDS.service, BLE_UUIDS.status, (err, ch) => {
      if (!err && ch?.value) this.handler?.(b64ToBytes(ch.value));
    }));
    this.device.onDisconnected(() => {
      this.device = null;
      this.subs.forEach((s) => s.remove());
      this.subs = [];
    });
    return this.device;
  }

  onData(handler: (chunk: Uint8Array) => void): void {
    this.handler = handler;
  }

  async send(frame: Uint8Array): Promise<boolean> {
    const device = this.device;
    if (!device) return false;
    const mtu = Number((device as any).mtu ?? 23) || 23;
    const chunkSize = Math.max(20, mtu - 3);
    const run = async () => {
      for (let offset = 0; offset < frame.length; offset += chunkSize) {
        const chunk = frame.subarray(offset, Math.min(frame.length, offset + chunkSize));
        await device.writeCharacteristicWithResponseForService(
          BLE_UUIDS.service,
          BLE_UUIDS.rx,
          bytesToB64(chunk),
        );
      }
      return true;
    };
    this.writeQueue = this.writeQueue.then(run, run);
    return (await this.writeQueue.catch(() => false)) === true;
  }

  async disconnect(): Promise<void> {
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    await this.device?.cancelConnection().catch(() => undefined);
    this.device = null;
  }
}
