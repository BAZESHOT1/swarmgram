/**
 * Web-заглушка локальных уведомлений о mesh-конвертах.
 *
 * На web приложение показывает in-app карточку (или Web Push из push.web.ts),
 * поэтому здесь всегда возвращаем false — вызывающий код отрисует in-app.
 */
import type { MeshLocalNotification } from './localTypes';

export type { MeshLocalNotification } from './localTypes';

export async function showMeshLocalNotification(
  _options: MeshLocalNotification,
): Promise<boolean> {
  return false;
}
