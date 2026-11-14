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

/** iOS не любит параллельные connect: все попытки идут строго по очереди. */
let connectChain: Promise<unknown> = Promise.resolve();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function withConnectLock<T>(task: () => Promise<T>): Promise<T> {
  const run = connectChain.then(task, task);
  connectChain = run.catch(() => undefined);
  return run;
}

function deviceName(device: Device): string {
  return `${device.name ?? ''} ${device.localName ?? ''}`.trim().toLowerCase();
}


export class BleKMeshV1Link implements KMeshV1Link {
  private device: Device | null = null;
  private subs: Subscription[] = [];
  private handler: ((chunk: Uint8Array) => void) | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();

  static supported(): boolean {
    return true;
  }

  async connect(timeoutMs = 12000, namePrefix = 'KL-'): Promise<Device> {
    if (this.device) return this.device;
    return withConnectLock(async () => {
      if (this.device) return this.device;
      const prefix = namePrefix.toLowerCase();
      const m = manager();
      const found = await new Promise<Device>((resolve, reject) => {
        const timer = setTimeout(() => {
          void m.stopDeviceScan().catch(() => undefined);
          reject(new Error('ble_scan_timeout'));
        }, timeoutMs);
        m.startDeviceScan([BLE_UUIDS.service], { allowDuplicates: false }, (error, device) => {
          if (error) {
            clearTimeout(timer);
            void m.stopDeviceScan().catch(() => undefined);
            reject(error);
            return;
          }
          if (!device) return;
          const name = deviceName(device);
          const services = (device.serviceUUIDs ?? []).map((s) => s.toLowerCase());
          const matchesService = services.some(
            (s) => s === BLE_SHORT_UUIDS.service || s.endsWith('a5c0-0000-1000-8000-00805f9b34fb'),
          );
          if (matchesService || name.includes(prefix)) {
            clearTimeout(timer);
            void m.stopDeviceScan().catch(() => undefined);
            resolve(device);
          }
        });
      });

      // iOS: скан обязан быть остановлен, иначе connectToDevice зависает.
      await m.stopDeviceScan().catch(() => undefined);
      await delay(250);

      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          this.device = await found.connect();
          break;
        } catch (error) {
          lastError = error;
          await delay(250);
        }
      }
      if (!this.device) throw lastError instanceof Error ? lastError : new Error('ble_connect_failed');

      await this.device.discoverAllServicesAndCharacteristics();
      await this.device.requestMTU(247).catch(() => 23);
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
    });
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
