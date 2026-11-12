/**
 * Платформенная заглушка фонового режима модулей.
 *
 * Web-сборка никогда не запускает Android foreground service и не тянет
 * notifee: Metro подставляет background.native.ts на iOS/Android.
 * Сигнатуры должны совпадать с нативной реализацией.
 */

export const MESH_CHANNEL_ID = 'kinto-mesh';

export interface MeshServiceInfo {
  publicId?: string;
  role?: string;
}

export async function startMeshForegroundService(_info?: MeshServiceInfo): Promise<void> {
  /* на web фонового BLE-сервиса нет */
}

export async function stopMeshForegroundService(): Promise<void> {
  /* на web фонового BLE-сервиса нет */
}

export async function isMeshForegroundServiceRunning(): Promise<boolean> {
  return false;
}

export default { startMeshForegroundService, stopMeshForegroundService };
