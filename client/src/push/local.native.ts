/**
 * Локальное уведомление о входящем mesh/BLE-конверте, когда приложение
 * в фоне или неактивно. Использует общие push-хелперы (notifee) и тот же
 * флаг «скрывать содержимое», что и FCM/pending-уведомления.
 *
 * Не вызывается в foreground: там InAppNotifications показывает карточку,
 * поэтому дублей нет.
 */
import { displayPushNotification } from './push.native';
import { isPushContentHidden } from './pushPrefs';
import type { MeshLocalNotification } from './localTypes';

export type { MeshLocalNotification } from './localTypes';

/**
 * Показывает уведомление и возвращает true, если оно было отправлено в OS.
 * При ошибке возвращает false — вызывающий может отрисовать in-app fallback.
 */
export async function showMeshLocalNotification(
  options: MeshLocalNotification,
): Promise<boolean> {
  if (!options.chatId) return false;
  try {
    const hidden = await isPushContentHidden();
    const kind = options.kind ?? 'text';
    const fallbackBody = kind === 'media' ? 'Медиа' : 'Новое сообщение';
    await displayPushNotification({
      id: options.messageId ? `mesh-${options.messageId}` : `mesh-${options.chatId}-${Date.now()}`,
      title: hidden ? 'Kinto' : options.title || 'Kinto',
      body: hidden ? fallbackBody : options.body || fallbackBody,
      data: {
        chatId: options.chatId,
        ...(options.messageId ? { messageId: options.messageId } : {}),
        kind,
        source: 'mesh',
      },
    });
    return true;
  } catch {
    return false;
  }
}
