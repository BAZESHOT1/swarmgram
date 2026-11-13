/**
 * Бинарный транспортный протокол Kinto ↔ ESP32-модуль.
 *
 * Кадр одинаков для USB (Web Serial) и BLE:
 *
 *   +------+------+---------+------+---------+--------+---------+
 *   | 0xA5 | 0x5A | version | type | len LE  | payload| crc16   |
 *   +------+------+---------+------+---------+--------+---------+
 *     1      1        1        1      2        len       2
 *
 * CRC16-CCITT (poly 0x1021, init 0xFFFF) считается по байтам
 * version..payload (то есть по всему кадру, кроме magic и самого CRC).
 *
 * Поверх кадра лежит JSON-полезная нагрузка:
 *   { v: 1, kind: 'hello' | 'info' | 'envelope' | 'ack' | 'status' | 'config', ... }
 */

/** Магия начала кадра. */
export const FRAME_MAGIC = [0xa5, 0x5a] as const;
/** Версия протокола. */
export const PROTOCOL_VERSION = 1;
/** Заголовок: magic(2) + version(1) + type(1) + len(2). */
export const FRAME_HEADER_SIZE = 6;
/** Максимальный размер JSON-полезной нагрузки (защита от мусора в порту). */
export const MAX_PAYLOAD = 8192;
/** Служебный размер кадра: заголовок + CRC. */
export const FRAME_OVERHEAD = FRAME_HEADER_SIZE + 2;

/** Типы кадров. */
export const FrameType = {
  HELLO: 1,
  INFO: 2,
  DATA_UP: 3,
  DATA_DOWN: 4,
  ACK: 5,
  PING: 6,
  PONG: 7,
  STATUS: 8,
  PAIR: 9,
  SET_CONFIG: 10,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** Полные 128-битные BLE UUID (сервис a5c0, TX a5c1, RX a5c2, STATUS a5c3). */
export const BLE_UUIDS = {
  service: '0000a5c0-0000-1000-8000-00805f9b34fb',
  tx: '0000a5c1-0000-1000-8000-00805f9b34fb',
  rx: '0000a5c2-0000-1000-8000-00805f9b34fb',
  status: '0000a5c3-0000-1000-8000-00805f9b34fb',
} as const;

/** Короткие UUID для фильтра сканирования BLE (Android отдаёт их в нижнем регистре). */
export const BLE_SHORT_UUIDS = {
  service: 'a5c0',
  tx: 'a5c1',
  rx: 'a5c2',
  status: 'a5c3',
} as const;

/* ------------------------------------------------------------- CRC16 ----- */

/** CRC16-CCITT (0x1021, init 0xFFFF, без рефлексии). */
export function crc16ccitt(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/* ------------------------------------------------------------ кадры ------ */

export interface DecodedFrame {
  type: number;
  payload: Uint8Array;
}

/**
 * Кодирует кадр. Возвращает готовый Uint8Array, который можно писать
 * в Serial-порт или BLE-характеристику (при необходимости — чанками).
 */
export function encodeFrame(type: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`Слишком большая полезная нагрузка кадра: ${payload.length} > ${MAX_PAYLOAD}`);
  }
  const out = new Uint8Array(FRAME_OVERHEAD + payload.length);
  out[0] = FRAME_MAGIC[0];
  out[1] = FRAME_MAGIC[1];
  out[2] = PROTOCOL_VERSION;
  out[3] = type & 0xff;
  out[4] = payload.length & 0xff;
  out[5] = (payload.length >> 8) & 0xff;
  out.set(payload, FRAME_HEADER_SIZE);
  // CRC по version..payload.
  const crc = crc16ccitt(out.subarray(2, FRAME_HEADER_SIZE + payload.length));
  out[FRAME_HEADER_SIZE + payload.length] = crc & 0xff;
  out[FRAME_HEADER_SIZE + payload.length + 1] = (crc >> 8) & 0xff;
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** JSON → payload. */
export function encodeJson(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

/** payload → JSON; повреждённые данные дают null, а не исключение. */
export function decodeJson<T = unknown>(payload: Uint8Array): T | null {
  try {
    if (!payload.length) return null;
    return JSON.parse(textDecoder.decode(payload)) as T;
  } catch {
    return null;
  }
}

/**
 * Инкрементальный декодер: принимает произвольные чанки (MTU BLE/Serial)
 * и выдаёт только целые проверенные кадры.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private disposed = false;
  /** Сборка фрагментированного кадра (старший бит типа). */
  private fragment: {
    type: number;
    total: number;
    data: Uint8Array;
    /** offset → длина принятого куска; set() дедуплицирует повторы. */
    parts: Map<number, number>;
    at: number;
  } | null = null;

  /** Добавляет чанк и возвращает все полностью собранные кадры. */
  push(chunk: Uint8Array): DecodedFrame[] {
    if (this.disposed) return [];
    if (!chunk?.length) return [];
    this.append(chunk);

    const frames: DecodedFrame[] = [];
    for (;;) {
      const view = this.buffer;
      if (view.length < FRAME_HEADER_SIZE) break;

      // Синхронизация по магии. Мусор до неё отбрасываем.
      if (view[0] !== FRAME_MAGIC[0] || view[1] !== FRAME_MAGIC[1]) {
        const next = findMagic(view, 1);
        if (next < 0) {
          // Последний байт может быть началом магии — оставляем его.
          this.buffer = view[view.length - 1] === FRAME_MAGIC[0] ? view.slice(-1) : new Uint8Array(0);
          break;
        }
        this.buffer = view.slice(next);
        continue;
      }

      if (view[2] !== PROTOCOL_VERSION) {
        // Неизвестная версия — сдвигаемся на 1 байт и ищем следующий кадр.
        this.buffer = view.slice(1);
        continue;
      }

      const length = view[4] | (view[5] << 8);
      if (length > MAX_PAYLOAD) {
        this.buffer = view.slice(1);
        continue;
      }

      const total = FRAME_HEADER_SIZE + length + 2;
      if (view.length < total) break; // ждём продолжение

      const expected = view[total - 2] | (view[total - 1] << 8);
      const actual = crc16ccitt(view.subarray(2, FRAME_HEADER_SIZE + length));
      if (expected !== actual) {
        // Битая рамка: пробуем найти магию внутри, иначе сдвигаемся на байт.
        this.buffer = view.slice(1);
        continue;
      }

      const rawType = view[3];
      let payload = view.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + length);
      this.buffer = view.slice(total);

      // Фрагментированный кадр: payload = [offset u16][total u16][chunk...].
      // Старший бит типа — флаг фрагмента (см. прошивку bleSendFrame).
      if ((rawType & 0x80) !== 0) {
        if (payload.length < 4) {
          this.fragment = null;
          continue;
        }
        const offset = payload[0] | (payload[1] << 8);
        const totalLen = payload[2] | (payload[3] << 8);
        const chunk = payload.subarray(4);
        if (totalLen === 0 || totalLen > MAX_PAYLOAD) {
          this.fragment = null;
          continue;
        }
        // Фрагменты могут прийти не по порядку (BLE/mesh теряет кадры).
        // Собираем по offset и завершаем только когда покрыты все байты;
        // дырка означает, что клиент запросит повторную отправку.
        const stale = this.fragment && Date.now() - this.fragment.at > 15_000;
        if (
          !this.fragment ||
          stale ||
          this.fragment.type !== (rawType & 0x7f) ||
          this.fragment.total !== totalLen
        ) {
          this.fragment = {
            type: rawType & 0x7f,
            total: totalLen,
            data: new Uint8Array(totalLen),
            parts: new Map(),
            at: Date.now(),
          };
        }
        const fragment = this.fragment;
        fragment.data.set(chunk, offset);
        fragment.parts.set(offset, chunk.length);
        fragment.at = Date.now();
        let covered = 0;
        for (const partLen of fragment.parts.values()) covered += partLen;
        if (covered >= fragment.total) {
          frames.push({ type: fragment.type, payload: fragment.data.slice(0, fragment.total) });
          this.fragment = null;
        }
        if (!this.buffer.length) break;
        continue;
      }

      this.fragment = null;
      frames.push({ type: rawType, payload });
      if (!this.buffer.length) break;
    }
    return frames;
  }

  /** Сколько байт ждёт продолжения (для диагностики). */
  get pending(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
    this.fragment = null;
  }

  dispose(): void {
    this.disposed = true;
    this.buffer = new Uint8Array(0);
  }

  private append(chunk: Uint8Array): void {
    // Не держим в памяти бесконечный поток мусора.
    if (chunk.length > MAX_PAYLOAD * 2) {
      this.buffer = new Uint8Array(0);
      return;
    }
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }
}

function findMagic(data: Uint8Array, from: number): number {
  for (let i = from; i + 1 < data.length; i += 1) {
    if (data[i] === FRAME_MAGIC[0] && data[i + 1] === FRAME_MAGIC[1]) return i;
  }
  return -1;
}

/* ------------------------------------------------------- JSON-полезное --- */

export type JsonKind = 'hello' | 'info' | 'envelope' | 'ack' | 'status' | 'config';

export interface HelloPayload {
  v: 1;
  kind: 'hello';
  app: 'kinto';
  client: string;
  version?: string;
  /** Если известен — просим модуль подтвердить именно этот hardwareId. */
  expectHardwareId?: string;
}

export interface ModuleInfoPayload {
  v?: 1;
  kind?: 'info';
  hardwareId: string;
  /** BLE MAC — алиас для сопоставления с Wi-Fi MAC. */
  bleMac?: string;
  /** 8-значный публичный ID для добавления в аккаунт. */
  publicId?: string;
  role?: 'wearable' | 'repeater' | 'gateway' | string;
  firmware?: string;
  battery?: number;
  meshRole?: string;
  attached?: boolean;
  /** Есть ли путь к серверам через шлюз (свой Wi-Fi или сосед-шлюз). */
  gateway?: boolean;
  queue?: number;
  rssi?: number;
}

export interface EnvelopePayload {
  v: 1;
  kind: 'envelope';
  /** 'up' — клиент → mesh; 'down' — mesh → клиент. */
  direction?: 'up' | 'down';
  chatId: string;
  envelope: unknown;
}

export interface AckPayload {
  v: 1;
  kind: 'ack';
  id?: string;
  ok: boolean;
  error?: string;
}

export interface StatusPayload {
  v: 1;
  kind: 'status';
  attached?: boolean;
  queue?: number;
  rssi?: number;
  battery?: number;
  meshRole?: string;
  firmware?: string;
}

/** Кадр SET_CONFIG: Wi-Fi роутера для шлюза. Пароль не логируется. */
export interface ConfigPayload {
  v: 1;
  kind: 'config';
  wifiSsid: string;
  wifiPassword: string;
}

export function configPayload(wifiSsid: string, wifiPassword: string): ConfigPayload {
  return { v: 1, kind: 'config', wifiSsid, wifiPassword };
}

export function helloPayload(client: string, expectHardwareId?: string): HelloPayload {
  return { v: 1, kind: 'hello', app: 'kinto', client, expectHardwareId };
}

/** Понимает и «плоский» info, и info, завёрнутый в kind:'info'. */
export function parseModuleInfo(payload: Uint8Array): ModuleInfoPayload | null {
  const raw = decodeJson<Record<string, unknown>>(payload);
  if (!raw || typeof raw !== 'object') return null;
  // Некоторые прошивки присылают вложенный объект {kind:'info', info:{...}}.
  const source =
    raw.info && typeof raw.info === 'object' && !Array.isArray(raw.info)
      ? (raw.info as Record<string, unknown>)
      : raw;
  const hardwareId = String(source.hardwareId ?? source.hardware_id ?? '').trim();
  if (!hardwareId) return null;
  const num = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    v: 1,
    kind: 'info',
    hardwareId,
    bleMac: source.bleMac != null ? String(source.bleMac) : source.ble_mac != null ? String(source.ble_mac) : undefined,
    publicId: source.publicId != null ? String(source.publicId) : source.public_id != null ? String(source.public_id) : undefined,
    role: source.role != null ? String(source.role) : undefined,
    firmware: source.firmware != null ? String(source.firmware) : undefined,
    battery: num(source.battery, 0),
    meshRole: source.meshRole != null ? String(source.meshRole) : source.mesh_role != null ? String(source.mesh_role) : undefined,
    attached: typeof source.attached === 'boolean' ? source.attached : undefined,
    gateway: source.gateway === true || Number(source.gateway) === 1,
    queue: num(source.queue, 0),
    rssi: num(source.rssi, 0),
  };
}

export function parseEnvelope(payload: Uint8Array): { chatId: string; envelope: unknown } | null {
  const raw = decodeJson<EnvelopePayload>(payload);
  if (!raw || raw.kind !== 'envelope' || typeof raw.chatId !== 'string' || !raw.chatId) return null;
  return { chatId: raw.chatId, envelope: raw.envelope };
}

/** 8-значный публичный ID (только цифры). */
export function isPublicId(value: string): boolean {
  return /^\d{8}$/.test(value.trim());
}
