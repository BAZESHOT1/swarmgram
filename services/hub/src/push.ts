/**
 * Push-уведомления через Firebase Cloud Messaging.
 *
 * Hub хранит только историю уведомлений и FCM-токены устройств. Инициализация
 * firebase-admin ленивая: если креденшелов нет, сервис не падает, а уведомления
 * остаются в статусе pending (их можно отправить после настройки FCM).
 *
 * Креденшелы (по приоритету):
 *   1. FIREBASE_SERVICE_ACCOUNT      — JSON-строка сервисного аккаунта;
 *   2. FIREBASE_SERVICE_ACCOUNT_FILE — путь к JSON-файлу;
 *   3. GOOGLE_APPLICATION_CREDENTIALS — стандартный ADC.
 */
import { readFileSync } from 'node:fs';
import { one, query } from './db.js';
import { log } from './util.js';

type Platform = 'ios' | 'android' | 'web';
const PLATFORMS: Platform[] = ['ios', 'android', 'web'];

export interface NotificationInput {
  kind: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface TokenRow {
  id: string;
  token: string;
  platform: string;
}

interface NotificationRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  status: string;
}

/* ----------------------------------------------------------- инициализация */

type AppModule = typeof import('firebase-admin/app');
type MessagingModule = typeof import('firebase-admin/messaging');

let messaging: import('firebase-admin/messaging').Messaging | null = null;
let initTried = false;
/** true — креденшелов нет или инициализация провалилась; уведомления не трогаем. */
let pushDisabled = false;

/** В логах показываем только первые 8 символов токена. */
export function maskToken(token: string): string {
  return token.slice(0, 8);
}

async function getMessaging(): Promise<import('firebase-admin/messaging').Messaging | null> {
  if (messaging) return messaging;
  if (initTried) {
    if (pushDisabled) log('debug', 'push_disabled', { reason: 'unavailable' });
    return null;
  }
  initTried = true;

  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
  const fileEnv = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  const adcEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!jsonEnv && !fileEnv && !adcEnv) {
    pushDisabled = true;
    log('warn', 'push_disabled', { reason: 'no_credentials' });
    return null;
  }

  try {
    const appMod: AppModule = await import('firebase-admin/app');
    const msgMod: MessagingModule = await import('firebase-admin/messaging');

    let options: import('firebase-admin/app').AppOptions;
    if (jsonEnv) {
      options = { credential: appMod.cert(JSON.parse(jsonEnv) as import('firebase-admin/app').ServiceAccount) };
    } else if (fileEnv) {
      const raw = readFileSync(fileEnv, 'utf8');
      options = { credential: appMod.cert(JSON.parse(raw) as import('firebase-admin/app').ServiceAccount) };
    } else {
      options = { credential: appMod.applicationDefault() };
    }

    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(options);
    messaging = msgMod.getMessaging(app);
    log('info', 'push_enabled', { source: jsonEnv ? 'env_json' : fileEnv ? 'env_file' : 'adc' });
    return messaging;
  } catch (e) {
    pushDisabled = true;
    log('error', 'push_init_failed', { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/* ---------------------------------------------------------------- отправка */

/** FCM принимает в data только строки; значения приводим к строке. */
function stringifyData(data: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data) return out;
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('push_timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
  'messaging/invalid-recipient',
]);

/** Отправляет одно уведомление по всем включённым токенам его получателя. */
export async function sendNotification(id: string): Promise<void> {
  const notification = await one<NotificationRow>(
    'SELECT id, user_id, kind, title, body, data, status FROM push_notifications WHERE id = $1',
    [id],
  );
  if (!notification) return;
  // Уже доставлено клиентом — повторно не шлём.
  if (notification.status === 'delivered') return;

  const fcm = await getMessaging();
  if (!fcm) {
    // Без FCM оставляем pending: retry worker подхватит после настройки.
    log('debug', 'push_disabled', { notificationId: id });
    return;
  }

  const tokens = await query<TokenRow>(
    'SELECT id, token, platform FROM push_tokens WHERE user_id = $1 AND enabled = true',
    [notification.user_id],
  );

  if (!tokens.length) {
    await query(
      `UPDATE push_notifications
          SET status = 'failed', attempts = attempts + 1, last_error = $2
        WHERE id = $1`,
      [id, 'no_tokens'],
    );
    return;
  }

  const dataStrings = stringifyData(notification.data);
  const invalidTokens: string[] = [];
  const errors = new Set<string>();
  let success = 0;
  let failure = 0;

  try {
    // sendEachForMulticast принимает максимум 500 токенов за вызов.
    for (let offset = 0; offset < tokens.length; offset += 500) {
      const chunk = tokens.slice(offset, offset + 500);
      const res = await withTimeout(
        fcm.sendEachForMulticast({
          tokens: chunk.map((t) => t.token),
          notification: { title: notification.title, body: notification.body },
          data: dataStrings,
        }),
        15_000,
      );

      res.responses.forEach((r, idx) => {
        if (r.success) {
          success += 1;
          return;
        }
        failure += 1;
        const code = r.error?.code ?? 'send_failed';
        errors.add(code);
        if (INVALID_TOKEN_CODES.has(code)) {
          invalidTokens.push(chunk[idx].token);
        }
      });
    }

    if (invalidTokens.length) {
      await query('UPDATE push_tokens SET enabled = false WHERE token = ANY($1::text[])', [invalidTokens]);
      log('info', 'push_tokens_disabled', {
        count: invalidTokens.length,
        tokens: invalidTokens.map(maskToken),
      });
    }

    const status = success > 0 ? 'sent' : 'failed';
    const lastError = errors.size ? Array.from(errors).join(',').slice(0, 500) : null;
    await query(
      `UPDATE push_notifications
          SET status = $2,
              attempts = attempts + 1,
              last_error = $3,
              sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
        WHERE id = $1`,
      [id, status, lastError],
    );
    log('info', 'push_sent', {
      notificationId: id,
      userId: notification.user_id,
      success,
      failure,
      status,
    });
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await query(
      `UPDATE push_notifications
          SET status = 'failed', attempts = attempts + 1, last_error = $2
        WHERE id = $1`,
      [id, message],
    );
    log('error', 'push_send_failed', { notificationId: id, error: message });
  }
}

/* ----------------------------------------------------------------- очередь */

/** Ставит уведомление в очередь и пытается отправить как можно скорее. */
export async function enqueueNotification(userId: string, input: NotificationInput): Promise<string> {
  const row = await one<{ id: string }>(
    `INSERT INTO push_notifications (user_id, kind, title, body, data)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, input.kind, input.title, input.body, JSON.stringify(input.data ?? {})],
  );
  const id = row!.id;
  // best-effort: не блокируем вызывающий код, ошибки уже логируются внутри.
  void sendNotification(id).catch(() => undefined);
  return id;
}

/**
 * Системное уведомление одному пользователю (userId) или всем активным (null).
 */
export async function sendSystemNotification(
  userId: string | null | undefined,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<number> {
  if (userId) {
    await enqueueNotification(userId, { kind: 'system', title, body, data });
    return 1;
  }

  const users = await query<{ id: string }>("SELECT id FROM users WHERE status = 'active' LIMIT 10000");
  for (const u of users) {
    await enqueueNotification(u.id, { kind: 'system', title, body, data });
  }
  return users.length;
}

/* ------------------------------------------------------------- retry worker */

const RETRY_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 6;
const RETRY_AGE = "30 seconds";
let workerTimer: NodeJS.Timeout | null = null;
let retrying = false;

async function runRetry(): Promise<void> {
  if (retrying) return;
  retrying = true;
  try {
    const rows = await query<{ id: string }>(
      `SELECT id FROM push_notifications
        WHERE status IN ('pending', 'failed')
          AND attempts < $1
          AND created_at < now() - $2::interval
        ORDER BY created_at
        LIMIT 100`,
      [MAX_ATTEMPTS, RETRY_AGE],
    );
    if (!rows.length) return;
    log('info', 'push_retry_started', { count: rows.length });
    for (const row of rows) {
      await sendNotification(row.id);
    }
  } catch (e) {
    log('error', 'push_retry_failed', { error: e instanceof Error ? e.message : String(e) });
  } finally {
    retrying = false;
  }
}

/** Запускает фоновый retry-воркер (раз в минуту). Идемпотентно. */
export function startPushWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    void runRetry();
  }, RETRY_INTERVAL_MS);
  // Не мешаем процессу завершиться (например, при тестах).
  workerTimer.unref?.();
  log('info', 'push_worker_started', { intervalMs: RETRY_INTERVAL_MS });
}

export function isKnownPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as string[]).includes(value);
}
