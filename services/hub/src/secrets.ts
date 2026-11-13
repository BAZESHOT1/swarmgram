/**
 * Шифрование серверных ключей чата (AES-256-GCM).
 *
 * Ключ чата в режиме 'server' хранится только на Hub в поле key_enc.
 * Master-ключ берётся из окружения (HUB_KEY_SECRET), иначе выводится из
 * HUB_ADMIN_TOKEN (только для dev!). Наружу отдаётся только расшифрованный
 * ключ участнику.
 *
 * ВАЖНО:
 *  - HUB_KEY_SECRET должен быть задан в production и передан в контейнер.
 *  - При ротации старый секрет кладётся в HUB_KEY_SECRET_OLD: им можно
 *    расшифровать старые key_enc, новые всегда пишутся текущим.
 *  - Потеря секрета = потеря доступа к истории server-чатов. Бэкап .env
 *    обязателен (scripts/backup-hub.sh).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

interface SecretPayload {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

let cachedKeys: { primary: Buffer; old: Buffer[] } | null = null;

function derive(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function devFallback(): Buffer {
  const fallback = createHash('sha256')
    .update(`klinto-server-keys:${process.env.HUB_ADMIN_TOKEN ?? 'dev'}`, 'utf8')
    .digest('hex');
  return Buffer.from(fallback, 'hex');
}

/** Текущий ключ + дополнительные ключи для расшифровки старых записей. */
function masterKeys(): { primary: Buffer; old: Buffer[] } {
  if (cachedKeys) return cachedKeys;

  const secret = process.env.HUB_KEY_SECRET;
  const primary = secret && secret.length ? derive(secret) : devFallback();

  const old: Buffer[] = [];
  const oldSecret = process.env.HUB_KEY_SECRET_OLD;
  if (oldSecret && oldSecret.length) {
    for (const part of oldSecret.split(',')) {
      const trimmed = part.trim();
      if (trimmed) old.push(derive(trimmed));
    }
  }
  // Совместимость: записи, созданные до появления HUB_KEY_SECRET,
  // шифровались fallback-ключом от HUB_ADMIN_TOKEN.
  if (secret && secret.length) old.push(devFallback());

  cachedKeys = { primary, old };
  return cachedKeys;
}

/** Предупреждение при старте: без явного секрета ключи можно потерять. */
export function keySecretWarning(): string | null {
  if (process.env.HUB_KEY_SECRET && process.env.HUB_KEY_SECRET.length) return null;
  return 'HUB_KEY_SECRET не задан: используется dev-fallback от HUB_ADMIN_TOKEN. ' +
    'Смена HUB_ADMIN_TOKEN сделает server-ключи нечитаемыми — задайте HUB_KEY_SECRET.';
}

/**
 * Ключ mesh-туннеля для устройства: позволяет клиенту шифровать API-запросы,
 * которые шлюз передаёт как непрозрачный блок. Выводится из master-ключа,
 * наружу уходит только само значение (base64), не master.
 */
export function deriveMeshRelayKey(userId: string, deviceId: string): string {
  return createHmac('sha256', masterKeys().primary)
    .update(`mesh-relay:${userId}:${deviceId}`, 'utf8')
    .digest('base64');
}

/** Зашифровать строку master-ключом. Возвращает JSON {v,iv,tag,ct}. */
export function encryptSecret(plaintext: string): string {
  return encryptWith(masterKeys().primary, plaintext);
}

function encryptWith(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload: SecretPayload = {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(payload);
}

/** Расшифровать payload. Пробует текущий ключ, затем HUB_KEY_SECRET_OLD. */
export function decryptSecret(payload: string): string {
  const parsed = JSON.parse(payload) as SecretPayload;
  if (!parsed || parsed.v !== 1 || !parsed.iv || !parsed.tag || !parsed.ct) {
    throw new Error('invalid_secret_payload');
  }
  const { primary, old } = masterKeys();
  const keys = [primary, ...old];
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(parsed.ct, 'base64')), decipher.final()]).toString('utf8');
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('secret_decrypt_failed');
}
