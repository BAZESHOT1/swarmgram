/**
 * Web-заглушка нативного BLE.
 *
 * Веб-сборка никогда не должна импортировать react-native-ble-plx:
 * настоящий Web Bluetooth живёт в transport.web.ts, а этот файл нужен лишь
 * для платформенного разрешения `./ble` в общем коде.
 */
import { ModuleTransportError, type ModuleConnection, type ModuleInfo } from './types';

/** Веб-сборка: Bluetooth-разрешений нет, всегда false. */
export async function prepareBle(): Promise<boolean> {
  return false;
}

export class NativeBleTransport implements ModuleConnection {
  readonly kind = 'ble' as const;
  readonly supported = false;
  readonly isOpen = false;
  readonly info: ModuleInfo | null = null;

  async open(): Promise<ModuleInfo> {
    throw new ModuleTransportError(
      'Нативный BLE недоступен в браузере. На Android используйте Chrome + Web Bluetooth, на iOS — нативное приложение.',
      'unsupported',
    );
  }

  async openKnown(): Promise<ModuleInfo | null> {
    return null;
  }

  async sendEnvelope(): Promise<void> {
    throw new ModuleTransportError('Нативный BLE недоступен в браузере.', 'unsupported');
  }

  /** Заглушка: настоящий Web Bluetooth живёт в transport.web.ts. */
  async sendConfig(): Promise<void> {
    /* no-op */
  }

  onEnvelope(): () => void {
    return () => undefined;
  }

  onDisconnect(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    /* нечего закрывать */
  }
}

export default NativeBleTransport;
