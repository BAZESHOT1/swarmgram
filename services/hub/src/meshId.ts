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
