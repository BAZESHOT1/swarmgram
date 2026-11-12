/**
 * Фоновое сопровождение BLE-модуля (iOS/Android).
 *
 * Android: пока модуль подключён, держим foreground service через notifee
 * (`asForegroundService`). Это не отдельный native-модуль — используется уже
 * установленный @notifee/react-native, поэтому новых зависимостей и нативного
 * кода не требуется. Канал `kinto-mesh` намеренно LOW importance: постоянное
 * уведомление не должно звучать и висеть поверх чата.
 *
 * iOS: полноценный background BLE даёт UIBackgroundModes: bluetooth-central
 * (см. app.json) + restoreStateIdentifier в ble.native.ts. Сервисное
 * уведомление здесь не показываем — iOS не требует foreground service.
 *
 * TODO(Live Activity / Dynamic Island): статус mesh в Live Activity требует
 * отдельного ActivityKit-расширения (Widget Extension) и native-модуля.
 * Без расширения мы НЕ имитируем Dynamic Island: максимум, что доступно
 * сейчас, — фоновый BLE, локальные уведомления и background fetch. Когда
 * появится extension, здесь нужно будет стартовать/обновлять Activity с
 * состоянием подключённого модуля (queue/neighbors/battery).
 */
import notifee, {
  AndroidForegroundServiceType,
  AndroidImportance,
} from '@notifee/react-native';
import { Platform } from 'react-native';

export const MESH_CHANNEL_ID = 'kinto-mesh';
const SERVICE_NOTIFICATION_ID = 'kinto-mesh-service';

export interface MeshServiceInfo {
  publicId?: string;
  role?: string;
}

let channelPromise: Promise<void> | null = null;
let serviceRegistered = false;
let running = false;

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[mesh-background] ${message}`);
  else console.warn(`[mesh-background] ${message}`, error);
}

/** Канал LOW importance: без звука, вибрации и heads-up. */
async function ensureMeshChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!channelPromise) {
    channelPromise = notifee
      .createChannel({
        id: MESH_CHANNEL_ID,
        name: 'Mesh-соединение',
        description: 'Постоянное уведомление, пока модуль подключён',
        importance: AndroidImportance.LOW,
        vibration: false,
        sound: undefined,
        badge: false,
      })
      .then(() => undefined)
      .catch((error) => {
        channelPromise = null;
        warn('Не удалось создать канал kinto-mesh', error);
      });
  }
  return channelPromise;
}

/**
 * Notifee требует ровно один зарегистрированный обработчик foreground service.
 * Промис не резолвим: сервис живёт, пока висит уведомление / приложение.
 */
function ensureServiceHandler(): void {
  if (serviceRegistered) return;
  try {
    notifee.registerForegroundService(
      () =>
        new Promise<void>(() => {
          /* сервис живёт до stopMeshForegroundService() */
        }),
    );
    serviceRegistered = true;
  } catch (error) {
    warn('Не удалось зарегистрировать foreground service', error);
  }
}

/**
 * Запускает (или обновляет) foreground service. Вызывается при успешном
 * подключении модуля. Ошибки не пробрасываются: приложение продолжает
 * работать и без сервиса.
 */
export async function startMeshForegroundService(info?: MeshServiceInfo): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await ensureMeshChannel();
    ensureServiceHandler();
    if (running) return;
    running = true;
    const suffix = info?.publicId ? ` · ${info.publicId}` : info?.role ? ` · ${info.role}` : '';
    await notifee.displayNotification({
      id: SERVICE_NOTIFICATION_ID,
      title: 'Kinto',
      body: `Mesh-соединение активно${suffix}`,
      android: {
        channelId: MESH_CHANNEL_ID,
        asForegroundService: true,
        foregroundServiceTypes: [
          AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
          AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        ],
        ongoing: true,
        onlyAlertOnce: true,
        importance: AndroidImportance.LOW,
        smallIcon: 'ic_launcher',
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    });
  } catch (error) {
    running = false;
    warn('Не удалось запустить foreground service', error);
  }
}

/** Останавливает foreground service и убирает постоянное уведомление. */
export async function stopMeshForegroundService(): Promise<void> {
  if (Platform.OS !== 'android') return;
  running = false;
  try {
    await notifee.stopForegroundService();
  } catch (error) {
    warn('Не удалось остановить foreground service', error);
  }
  try {
    await notifee.cancelNotification(SERVICE_NOTIFICATION_ID);
  } catch {
    /* уведомления могло уже не быть */
  }
}

export async function isMeshForegroundServiceRunning(): Promise<boolean> {
  return running;
}
