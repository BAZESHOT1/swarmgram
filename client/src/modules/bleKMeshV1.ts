/**
 * Платформонезависимый тип BLE-транспорта KMesh_v1.
 * Metro сначала выбирает bleKMeshV1.native.ts / bleKMeshV1.web.ts.
 */
import type { KMeshV1Link } from '../kmesh/v1/client';

export class BleKMeshV1Link implements KMeshV1Link {
  static supported(): boolean {
    return false;
  }
  async connect(_timeoutMs?: number, _namePrefix?: string): Promise<unknown> {
    throw new Error('ble_v3_unavailable');
  }
  onData(_handler: (chunk: Uint8Array) => void): void {
    /* platform implementation overrides */
  }
  async send(_frame: Uint8Array): Promise<boolean> {
    return false;
  }
  async disconnect(): Promise<void> {
    /* nothing */
  }
}
