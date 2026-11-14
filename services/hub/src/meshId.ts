/**
 * Публичный идентификатор модуля.
 *
 * public_id — 8 цифр (с ведущими нулями), стабилен для конкретного
 * hardware_id (MAC из eFuse), поэтому перепрошивка его не меняет.
 * Считается по FNV-1a 32: hash % 100_000_000.
 *
 * Коллизии (два разных MAC дали одинаковые 8 цифр) разрешаются солью
 * `hardwareId#2`, `hardwareId#3`, ... — решение принимает вызывающий
 * код по ошибке UNIQUE-индекса в БД (здесь намеренно нет доступа к БД).
 */

import { createHash } from 'node:crypto';

/** 32-битный FNV-1a. Возвращает беззнаковое число. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Math.imul сохраняет 32-битную арифметику при переполнении.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Базовый public_id из hardware_id: ровно 8 цифр с ведущими нулями. */
export function publicIdFromHardware(hardwareId: string): string {
  return String(fnv1a32(hardwareId.toLowerCase()) % 100_000_000).padStart(8, '0');
}

/** Строка — валидный публичный ID (ровно 8 цифр). */
export function isPublicId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{8}$/.test(value);
}

/**
 * Возвращает существующий public_id, если он валиден, иначе вычисляет.
 * `attempt` > 0 добавляет соль `hardwareId#2`, `#3`, ... — для повтора
 * при коллизии unique-индекса.
 */
export function ensurePublicId(hardwareId: string, existing?: string | null, attempt = 0): string {
  if (isPublicId(existing)) return existing;
  if (attempt <= 0) return publicIdFromHardware(hardwareId);
  return publicIdFromHardware(`${hardwareId.toLowerCase()}#${attempt + 1}`);
}

/* --------------------------------------------------- постоянный users.id --- */

export interface UserNetIdentity {
  netId: number;
  blePrefix: string;
}

/**
 * Детерминированный компактный идентификатор из users.id (UUID).
 * Первые 4 байта SHA-256; зарезервированные 0/1/0xFFFFFFFF пропускаются.
 */
export function userNetIdentityFromUuid(userId: string): UserNetIdentity {
  const canonical = userId.trim().toLowerCase();
  for (let salt = 0; salt < 8; salt += 1) {
    const digest = createHash('sha256')
      .update(salt === 0 ? canonical : `${canonical}#${salt}`, 'utf8')
      .digest();
    const netId = digest.readUInt32BE(0) >>> 0;
    if (netId !== 0 && netId !== 1 && netId !== 0xffffffff) {
      return { netId, blePrefix: digest.subarray(0, 4).toString('hex') };
    }
  }
  // Практически недостижимо; страховка от вырожденного хеша.
  const fallback = createHash('sha256').update(`${canonical}#fallback`).digest();
  return {
    netId: (fallback.readUInt32BE(4) >>> 0) || 2,
    blePrefix: fallback.subarray(0, 4).toString('hex'),
  };
}

/** Нормализовать MAC в вид aa:bb:cc:dd:ee:ff (нижний регистр). */
export function normalizeModuleMac(value: string): string | null {
  const hex = value.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(':');
}

/** Последние 6 hex MAC. */
export function moduleMod6(mac: string): string {
  return mac.replace(/[^0-9a-f]/gi, '').toLowerCase().slice(-6);
}
