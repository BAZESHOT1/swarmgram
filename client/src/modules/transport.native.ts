/**
 * Нативные транспорты (Android/iOS).
 *
 * USB на телефоне пока не реализован: интерфейс сохранён, но честно
 * сообщаем «используйте BLE». BLE работает через react-native-ble-plx.
 *
 * Подключается только на native-платформах (Metro выбирает этот файл
 * вместо transport.ts/transport.web.ts).
 */
import { NativeBleTransport } from './ble.native';
import {
  ModuleTransportError,
  type ConnectionKind,
  type ModuleConnection,
  type ModuleEnvelope,
  type ModuleInfo,
} from './types';

/** USB на Android/iOS: интерфейс есть, реализации нет. */
class UnsupportedUsbTransport implements ModuleConnection {
  readonly kind: ConnectionKind = 'usb';
  readonly supported = false;
  readonly isOpen = false;
  readonly info: ModuleInfo | null = null;

  async open(): Promise<ModuleInfo> {
    throw new ModuleTransportError(
      'На Android/iOS USB недоступен — используйте BLE. Для USB-прошивки подключите модуль к компьютеру.',
      'unsupported',
    );
  }

  async openKnown(): Promise<ModuleInfo | null> {
    return null;
  }

  async sendEnvelope(): Promise<void> {
    throw new ModuleTransportError('USB недоступен на этой платформе.', 'unsupported');
  }

  /** На телефоне USB-настройка Wi-Fi недоступна — no-op без раскрытия данных. */
  async sendConfig(): Promise<void> {
    /* заглушка: реальный транспорт на телефоне — BLE */
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

export { NativeBleTransport } from './ble.native';

/** Выбирает нативный транспорт: BLE есть, USB — заглушка с понятной ошибкой. */
export function getModuleTransport(kind: ConnectionKind = 'ble'): ModuleConnection {
  if (kind === 'usb') return new UnsupportedUsbTransport();
  return new NativeBleTransport();
}

/** Нативный BLE всегда доступен в собранном приложении. */
export function webSerialSupported(): boolean {
  return false;
}

export function webBluetoothSupported(): boolean {
  return false;
}
