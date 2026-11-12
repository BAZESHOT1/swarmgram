/**
 * Web push через Firebase Cloud Messaging.
 *
 * Файл платформенный (`*.web.ts`): на нативе используется отдельная
 * реализация, поэтому здесь нет ни одного импорта нативных модулей.
 *
 * SSR-safe: никакой работы на этапе импорта модуля нет, всё выполняется
 * только внутри registerWebPush и только при наличии `window`.
 */
import * as api from '../data/api';
import { useStore } from '../state/useStore';

/** Конфиг web-приложения Firebase (проект vdoh-crm). */
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBW8RI2Hp2jezNlprSm-IeawWBRphEFjJY',
  authDomain: 'vdoh-crm.firebaseapp.com',
  projectId: 'vdoh-crm',
  storageBucket: 'vdoh-crm.firebasestorage.app',
  messagingSenderId: '1014607310889',
  appId: '1:1014607310889:web:c184cfeb2c861d0d5d6c38',
  measurementId: 'G-CDLNJE1B6Z',
} as const;

/** Service worker лежит в public/ и попадает в dist как /firebase-messaging-sw.js. */
const SW_PATH = '/firebase-messaging-sw.js';

const ICON = '/icon.svg';

export type WebPushCleanup = () => void;

/** Минимальная часть сессии, нужная для привязки токена к устройству. */
export interface WebPushSession {
  deviceId?: string;
}

const noop: WebPushCleanup = () => undefined;

let vapidWarned = false;

function isWebPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('PushManager' in window)) return false;
  if (!('Notification' in window)) return false;
  return true;
}

function openChatFromData(data: Record<string, string> | undefined): void {
  const chatId = data?.chatId ?? data?.chat_id;
  const url = chatId ? `/chat/${encodeURIComponent(chatId)}` : '/chats';
  try {
    window.location.assign(url);
  } catch {
    /* навигация может быть запрещена — не ломаем вкладку */
  }
}

/**
 * Регистрирует web push для текущей сессии.
 *
 * Возвращает cleanup; при отсутствии поддержки, разрешения или VAPID-ключа
 * возвращает безвредный no-op и никогда не бросает исключение.
 */
export async function registerWebPush(
  session: WebPushSession | null | undefined,
): Promise<WebPushCleanup> {
  if (!isWebPushSupported()) return noop;

  const vapidKey =
    process.env.EXPO_PUBLIC_FCM_VAPID_KEY ||
    'BDESQnjb2N39oeIlvFrpDPrcYDH4oOKF8xonjc6TevIiz6d5uoYHSws9EcUWDpzfrjYpcaHsdcAVOw4Fv-LgZig';
  if (!vapidKey) {
    if (!vapidWarned) {
      vapidWarned = true;
      console.warn(
        '[push] Web push отключён: не задан EXPO_PUBLIC_FCM_VAPID_KEY. ' +
          'Добавьте VAPID-ключ Firebase (Project settings → Cloud Messaging → Web Push certificates) в .env.',
      );
    }
    return noop;
  }

  try {
    const [appMod, messagingMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]);

    const { getApp, getApps, initializeApp } = appMod;
    const { getMessaging, getToken, isSupported, onMessage } = messagingMod;

    // Браузеры без поддержки FCM (например, старый Safari) — тихо выходим.
    if (typeof isSupported === 'function' && !(await isSupported())) return noop;

    const app = getApps().length > 0 ? getApp() : initializeApp(FIREBASE_CONFIG);
    const messaging = getMessaging(app);

    const permission =
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
    if (permission !== 'granted') return noop;

    const registration = await navigator.serviceWorker.register(SW_PATH);
    // getToken сам дожидается активации, но ready делает поведение предсказуемым.
    await navigator.serviceWorker.ready.catch(() => undefined);

    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration,
    });
    if (!token) return noop;

    // Ошибку отправки на сервер не считаем фатальной: push уже работает локально.
    await api.api
      .registerPushToken({ token, platform: 'web', deviceId: session?.deviceId })
      .catch((e) => console.warn('[push] Не удалось отправить токен на сервер:', e));

    // Foreground-сообщения (вкладка в фокусе) FCM не показывает сам.
    const unsubscribe = onMessage(messaging, (payload) => {
      const title = payload.notification?.title ?? 'Kinto';
      const body = payload.notification?.body ?? '';
      const data = payload.data;

      try {
        if (Notification.permission === 'granted') {
          const notification = new Notification(title, {
            body,
            icon: ICON,
            data,
          });
          notification.onclick = () => {
            try {
              window.focus();
            } catch {
              /* ignore */
            }
            openChatFromData(data);
            notification.close();
          };
        }
      } catch (e) {
        // На некоторых мобильных браузерах конструктор Notification недоступен.
        console.warn('[push] Не удалось показать foreground-уведомление:', e);
      }

      // Дублируем в toast-систему активной вкладки.
      useStore.getState().pushToast({
        kind: 'info',
        message: body ? `${title}: ${body}` : title,
      });
    });

    return () => {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
    };
  } catch (e) {
    console.warn('[push] Не удалось инициализировать web push:', e);
    return noop;
  }
}
