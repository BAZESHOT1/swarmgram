/**
 * Native push implementation (iOS / Android).
 *
 * Responsibilities:
 *  - request notification permission and register the FCM token with the API;
 *  - refresh the token registration on token rotation;
 *  - show local notifications for foreground FCM messages (notifee);
 *  - display Android notifications for FCM background messages;
 *  - poll pending notifications through react-native-background-fetch as a
 *    fallback when APNs/FCM cannot deliver (e.g. unsigned iOS builds);
 *  - route notification presses to the chat screen (foreground only).
 *
 * This module must never throw at import time: Firebase may be missing or not
 * configured for the current build.
 */

import { Platform } from 'react-native';
import messaging, {
  AuthorizationStatus as FirebaseAuthorizationStatus,
} from '@react-native-firebase/messaging';
import notifee, {
  AndroidImportance,
  AuthorizationStatus as NotifeeAuthorizationStatus,
  EventType,
  type Event as NotifeeEvent,
} from '@notifee/react-native';
import BackgroundFetch from 'react-native-background-fetch';
import { router } from 'expo-router';

import * as api from '../data/api';
import type { PushCleanup, PushData, PushDisplayOptions, PushSession } from './types';

export const MESSAGES_CHANNEL_ID = 'swarmgram-messages';
export const SYSTEM_CHANNEL_ID = 'swarmgram-system';
export const BACKGROUND_FETCH_TASK_ID = 'swarmgram-pending-notifications';

const MAX_PENDING_PER_FETCH = 10;

/* ------------------------------------------------------------------ state -- */

let activeSession: PushSession | null = null;
let channelsPromise: Promise<void> | null = null;
let backgroundMessageRegistered = false;
let notifeeBackgroundRegistered = false;
let backgroundFetchPromise: Promise<void> | null = null;
let headlessRegistered = false;

function warn(message: string, error?: unknown): void {
  if (error === undefined) console.warn(`[push] ${message}`);
  else console.warn(`[push] ${message}`, error);
}

type MessagingInstance = ReturnType<typeof messaging>;
type RemoteMessage = {
  notification?: { title?: string; body?: string };
  data?: Record<string, string | object>;
};

function getMessagingSafe(): MessagingInstance | null {
  try {
    return messaging();
  } catch (error) {
    warn('Firebase messaging is not configured on this build', error);
    return null;
  }
}

function currentPlatform(): 'ios' | 'android' {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

/* --------------------------------------------------------------- channels -- */

async function createChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await notifee.createChannels([
      {
        id: MESSAGES_CHANNEL_ID,
        name: 'Messages',
        importance: AndroidImportance.HIGH,
        vibration: true,
      },
      {
        id: SYSTEM_CHANNEL_ID,
        name: 'System',
        importance: AndroidImportance.DEFAULT,
      },
    ]);
  } catch (error) {
    warn('Failed to create Android notification channels', error);
  }
}

/** Creates the Android channels once; safe to call from anywhere. */
export async function ensurePushChannels(): Promise<void> {
  if (!channelsPromise) {
    channelsPromise = createChannels().catch((error) => {
      channelsPromise = null;
      warn('Failed to ensure notification channels', error);
    });
  }
  return channelsPromise;
}

/* ------------------------------------------------------------ notification -- */

function normalizeData(input?: Record<string, unknown> | null): PushData {
  const out: PushData = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string') {
      out[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
    } else {
      try {
        out[key] = JSON.stringify(value);
      } catch {
        // Ignore values that cannot be serialized.
      }
    }
  }
  return out;
}

function parseData(input: unknown): PushData {
  if (!input) return {};
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return parsed && typeof parsed === 'object'
        ? normalizeData(parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof input === 'object') {
    return normalizeData(input as Record<string, unknown>);
  }
  return {};
}

function chatIdFromData(data?: PushData | Record<string, unknown> | null): string | null {
  if (!data) return null;
  const record = data as Record<string, unknown>;
  const raw = record.chatId ?? record.chat_id ?? record.chat;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (typeof raw === 'number') return String(raw);
  return null;
}

function channelForData(data: PushData): string {
  const kind = (data.channel || data.kind || '').toLowerCase();
  return kind === 'system' ? SYSTEM_CHANNEL_ID : MESSAGES_CHANNEL_ID;
}

/** Shows a local notification through notifee. Never throws. */
export async function displayPushNotification(options: PushDisplayOptions): Promise<void> {
  try {
    await ensurePushChannels();
    const data = options.data ?? {};
    const chatId = chatIdFromData(data);
    const channelId = options.channelId ?? channelForData(data);

    await notifee.displayNotification({
      id: options.id,
      title: options.title || 'SwarmGram',
      body: options.body || '',
      data,
      android: {
        channelId,
        smallIcon: 'ic_launcher',
        importance: AndroidImportance.HIGH,
        pressAction: {
          id: 'default',
          ...(chatId ? { launchActivity: 'default' } : {}),
        },
      },
      ios: {
        foregroundPresentationOptions: {
          alert: true,
          badge: true,
          sound: true,
        },
      },
    });
  } catch (error) {
    warn('Failed to display local notification', error);
  }
}

function notificationFromMessage(message: RemoteMessage): PushDisplayOptions {
  const data = normalizeData(message.data);
  return {
    title: message.notification?.title || data.title || 'SwarmGram',
    body: message.notification?.body || data.body || data.text || '',
    data,
    channelId: channelForData(data),
  };
}

/* ---------------------------------------------------------------- buttons -- */

function handleChatPress(data: PushData | Record<string, unknown> | null | undefined, navigate: boolean): void {
  const chatId = chatIdFromData(data);
  if (!chatId) return;
  if (!navigate) {
    // Background/quit: navigation is handled by the OS (launch intent) and
    // must not be attempted from the background event handler.
    return;
  }
  try {
    router.push(`/chat/${encodeURIComponent(chatId)}` as never);
  } catch (error) {
    warn('Failed to open chat from notification press', error);
  }
}

function handleNotifeeEvent(event: NotifeeEvent, navigate: boolean): void {
  if (event.type !== EventType.PRESS && event.type !== EventType.ACTION_PRESS) return;
  handleChatPress(event.detail?.notification?.data, navigate);
}

/* -------------------------------------------------------------- listeners -- */

function ensureBackgroundMessageHandler(): boolean {
  if (backgroundMessageRegistered) return true;
  const messaging = getMessagingSafe();
  if (!messaging) return false;
  try {
    messaging.setBackgroundMessageHandler(async (message) => {
      // iOS displays the APNs notification itself; only Android needs a local
      // notification from the data/notification payload.
      if (Platform.OS !== 'android') return;
      try {
        await displayPushNotification(notificationFromMessage(message));
      } catch (error) {
        warn('Background message handler failed', error);
      }
    });
    backgroundMessageRegistered = true;
    return true;
  } catch (error) {
    warn('Failed to register background message handler', error);
    return false;
  }
}

function ensureNotifeeBackgroundHandler(): boolean {
  if (notifeeBackgroundRegistered) return true;
  try {
    notifee.onBackgroundEvent(async (event) => {
      // No navigation from background: just acknowledge the press.
      handleNotifeeEvent(event, false);
    });
    notifeeBackgroundRegistered = true;
    return true;
  } catch (error) {
    warn('Failed to register notifee background handler', error);
    return false;
  }
}

function registerForegroundMessageHandler(): PushCleanup {
  const messaging = getMessagingSafe();
  if (!messaging) return () => {};
  try {
    return messaging.onMessage((message) => {
      void (async () => {
        try {
          await displayPushNotification(notificationFromMessage(message));
        } catch (error) {
          warn('Foreground message handler failed', error);
        }
      })();
    });
  } catch (error) {
    warn('Failed to subscribe to foreground messages', error);
    return () => {};
  }
}

function registerForegroundPressHandler(): PushCleanup {
  try {
    return notifee.onForegroundEvent((event) => {
      try {
        handleNotifeeEvent(event, true);
      } catch (error) {
        warn('Foreground notification press handler failed', error);
      }
    });
  } catch (error) {
    warn('Failed to register notifee foreground handler', error);
    return () => {};
  }
}

/* ------------------------------------------------------------- permission -- */

async function requestNativePermission(): Promise<boolean> {
  const messaging = getMessagingSafe();
  if (messaging) {
    try {
      const status = await messaging.requestPermission();
      if (
        status === FirebaseAuthorizationStatus.AUTHORIZED ||
        status === FirebaseAuthorizationStatus.PROVISIONAL ||
        status === FirebaseAuthorizationStatus.EPHEMERAL
      ) {
        return true;
      }
      if (status === FirebaseAuthorizationStatus.DENIED) {
        warn('Notification permission denied by the user');
      }
    } catch (error) {
      warn('Firebase requestPermission failed', error);
    }
  }

  // On Android 13+ notifee also requests POST_NOTIFICATIONS; on iOS this is a
  // second, idempotent attempt if Firebase permission could not be requested.
  try {
    const settings = await notifee.requestPermission();
    return settings.authorizationStatus >= NotifeeAuthorizationStatus.AUTHORIZED;
  } catch (error) {
    warn('notifee requestPermission failed', error);
  }
  return false;
}

async function registerToken(token: string): Promise<void> {
  const deviceId = activeSession?.deviceId;
  if (!token || !deviceId) {
    if (!deviceId) warn('No active session deviceId, token not sent to server');
    return;
  }
  try {
    await api.api.registerPushToken({
      token,
      platform: Platform.OS as 'ios' | 'android',
      deviceId,
    });
  } catch (error) {
    warn('Failed to register push token on the server', error);
  }
}

/* ----------------------------------------------------------- registration -- */

/**
 * Requests permission, gets the FCM token, registers it on the server and
 * subscribes to token refreshes. Returns an unsubscribe callback.
 */
export async function registerNativePush(session: PushSession | null | undefined): Promise<PushCleanup> {
  activeSession = session ?? null;
  const cleanups: PushCleanup[] = [];

  const messaging = getMessagingSafe();
  if (!messaging) return () => {};

  const granted = await requestNativePermission();
  if (!granted) {
    warn('Push registration skipped: notification permission not granted');
    return () => {};
  }

  try {
    if (Platform.OS === 'ios' && !messaging.isDeviceRegisteredForRemoteMessages) {
      await messaging.registerDeviceForRemoteMessages().catch((error) => {
        warn('registerDeviceForRemoteMessages failed', error);
      });
    }

    const token = await messaging.getToken();
    if (token) await registerToken(token);

    const unsubscribe = messaging.onTokenRefresh((nextToken: string) => {
      void registerToken(nextToken);
    });
    cleanups.push(unsubscribe);
  } catch (error) {
    warn('Native push registration failed', error);
  }

  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Ignore individual unsubscribe failures.
      }
    }
  };
}

/* ------------------------------------------------------- pending fallback -- */

async function resolveSession(): Promise<PushSession | null> {
  const inMemory = api.getSession();
  if (inMemory) return inMemory;
  try {
    return await api.initSession();
  } catch (error) {
    warn('Failed to restore session for background fetch', error);
    return null;
  }
}

/**
 * Fetches up to 10 pending notifications from the API, displays each one via
 * notifee and marks it delivered. Safe to call outside React.
 */
export async function pollPending(): Promise<number> {
  try {
    const session = await resolveSession();
    if (!session?.deviceId) return 0;

    const items = await api.api.pendingNotifications(currentPlatform(), session.deviceId);
    if (!Array.isArray(items) || items.length === 0) return 0;

    let shown = 0;
    for (const item of items.slice(0, MAX_PENDING_PER_FETCH)) {
      const raw = (item ?? {}) as Record<string, unknown>;
      const id = raw.id ?? raw.notificationId ?? raw.notification_id;
      const notificationId = typeof id === 'string' || typeof id === 'number' ? String(id) : '';
      if (!notificationId) continue;

      const data = parseData(raw.data ?? raw.payload);
      if (!data.chatId) {
        const chatId = chatIdFromData(raw);
        if (chatId) data.chatId = chatId;
      }

      const title = typeof raw.title === 'string' && raw.title ? raw.title : 'SwarmGram';
      const body =
        (typeof raw.body === 'string' && raw.body) ||
        (typeof raw.message === 'string' && raw.message) ||
        (typeof raw.text === 'string' && raw.text) ||
        '';

      await displayPushNotification({
        id: `pending-${notificationId}`,
        title,
        body,
        data,
      });

      try {
        await api.api.markNotificationDelivered(notificationId);
      } catch (error) {
        warn('Failed to mark notification delivered', error);
      }
      shown += 1;
    }
    return shown;
  } catch (error) {
    warn('Pending notification poll failed', error);
    return 0;
  }
}

/* ---------------------------------------------------------- background fetch -- */

function registerHeadlessTask(): void {
  if (headlessRegistered) return;
  try {
    BackgroundFetch.registerHeadlessTask(async ({ taskId }) => {
      try {
        await pollPending();
      } finally {
        BackgroundFetch.finish(taskId);
      }
    });
    headlessRegistered = true;
  } catch (error) {
    warn('Failed to register background fetch headless task', error);
  }
}

/**
 * Configures and starts react-native-background-fetch. Idempotent; used both
 * at module load (so events keep firing after the app is killed) and from
 * initNativePush.
 */
export function ensureBackgroundFetch(): Promise<void> {
  if (backgroundFetchPromise) return backgroundFetchPromise;

  backgroundFetchPromise = (async () => {
    registerHeadlessTask();
    try {
      await BackgroundFetch.configure(
        {
          minimumFetchInterval: 15,
          stopOnTerminate: false,
          startOnBoot: true,
          enableHeadless: true,
          requiredNetworkType: BackgroundFetch.NETWORK_TYPE_ANY,
        },
        async (taskId) => {
          try {
            await pollPending();
          } catch (error) {
            warn('Background fetch task failed', error);
          } finally {
            BackgroundFetch.finish(taskId);
          }
        },
        (taskId) => {
          // Timeout: stop processing immediately and signal completion.
          BackgroundFetch.finish(taskId);
        },
      );
      await BackgroundFetch.start();
    } catch (error) {
      warn('Background fetch configuration failed', error);
      // Allow a later retry (e.g. after the app is fully initialized).
      backgroundFetchPromise = null;
    }
  })();

  return backgroundFetchPromise;
}

/* --------------------------------------------------------------- lifecycle -- */

/**
 * Wires everything up: token registration, foreground/background handlers and
 * the background-fetch fallback. Returns a cleanup for the JS listeners.
 */
export async function initNativePush(session: PushSession | null | undefined): Promise<PushCleanup> {
  activeSession = session ?? null;

  ensureBackgroundMessageHandler();
  ensureNotifeeBackgroundHandler();
  void ensurePushChannels();

  const cleanups: PushCleanup[] = [
    registerForegroundMessageHandler(),
    registerForegroundPressHandler(),
  ];

  cleanups.push(await registerNativePush(session));

  // Background fetch intentionally keeps running after cleanup: it is the
  // fallback path for devices that never receive APNs/FCM pushes. It reads the
  // persisted session on each tick and no-ops when there is none.
  void ensureBackgroundFetch();

  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        // Ignore individual cleanup failures.
      }
    }
  };
}

/* ----------------------------------------------------------- module setup -- */

// Background handlers must be registered as early as possible, ideally when
// the JS bundle is evaluated. All calls are guarded and never throw.
ensureBackgroundMessageHandler();
ensureNotifeeBackgroundHandler();
void ensurePushChannels();
void ensureBackgroundFetch();
