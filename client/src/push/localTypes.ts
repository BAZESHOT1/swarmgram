/** Общий тип локального уведомления о mesh-конверте (web/native). */
export interface MeshLocalNotification {
  chatId: string;
  messageId?: string;
  title: string;
  body: string;
  kind?: string;
}
