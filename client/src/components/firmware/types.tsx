/**
 * Типы, пресеты и валидация конфигурации прошивки ESP32-модуля.
 * Здесь нет сетевых вызовов — только чистые данные и проверки,
 * чтобы шаги визарда и сборка использовали один и тот же контракт.
 */
import { api, apiBase, ApiError, getSession, type FirmwareBuilderStatus } from '../../data/api';

export type FirmwareBoard = 'esp32c3' | 'esp32' | 'esp32s3';
export type FirmwareRole = 'gateway' | 'repeater' | 'wearable';
export type FirmwareConnectivity = 'wifi' | 'wifi_lora';
export type LoraChip = 'sx1278' | 'sx1276' | 'sx1262';
export type LoraFrequency = 433 | 868 | 915;
export type LoraBandwidth = 125 | 250 | 500;

export type LoraPinKey = 'sck' | 'miso' | 'mosi' | 'cs' | 'rst' | 'dio0' | 'busy';

export interface LoraPins {
  sck: number;
  miso: number;
  mosi: number;
  cs: number;
  rst: number;
  dio0: number;
  busy?: number;
}

export interface LoraConfig {
  chip: LoraChip;
  frequencyMhz: LoraFrequency;
  spreadingFactor: number;
  bandwidthKhz: LoraBandwidth;
  syncWord: number;
  pins: LoraPins;
}

export interface BatteryConfig {
  enabled: boolean;
  pin: number;
  ratio: number;
  intervalSec: number;
}

/** Полный конфиг, который уходит на Hub в POST /v1/firmware/build. */
export interface FirmwareConfig {
  board: FirmwareBoard;
  role: FirmwareRole;
  connectivity: FirmwareConnectivity;
  wifi?: { ssid: string; password: string };
  hubUrl?: string;
  moduleToken?: string;
  claimToken?: string;
  lora?: LoraConfig;
  battery?: BatteryConfig;
  ota?: boolean;
}

export type FirmwareBuildStatus = 'queued' | 'building' | 'ready' | 'failed' | string;

/** Сборка прошивки в списке и в деталях. */
export interface FirmwareBuild {
  id: string;
  status: FirmwareBuildStatus;
  version?: string;
  sizeBytes?: number;
  sha256?: string;
  log?: string;
  config?: Partial<FirmwareConfig> | Record<string, unknown>;
  /** true — merged.bin, можно писать с 0x0 из браузера. */
  merged?: boolean;
  createdAt?: string;
}

export interface BoardPreset {
  id: FirmwareBoard;
  title: string;
  short: string;
  description: string;
  icon: 'hardware-chip-outline' | 'phone-portrait-outline' | 'flash-outline';
  pins: LoraPins;
  batteryPin: number;
  /** Пины, занятые USB/UART — использовать для LoRa нельзя. */
  usbPins: number[];
  /** Strapping-пины: при старте влияют на режим загрузки — лучше не занимать. */
  strappingPins: number[];
  /** Пины, которые вообще не умеют выход (только вход). */
  inputOnlyPins: number[];
}

export const BOARDS: BoardPreset[] = [
  {
    id: 'esp32c3',
    title: 'ESP32-C3 Super Mini',
    short: 'C3 · Wi-Fi + BLE 5 · USB-C',
    description: 'Компактная плата с нативным USB. Хороша для носимых модулей и ретрансляторов.',
    icon: 'hardware-chip-outline',
    pins: { sck: 4, miso: 5, mosi: 6, cs: 7, rst: 3, dio0: 2, busy: 10 },
    batteryPin: 0,
    usbPins: [18, 19],
    strappingPins: [2, 8, 9],
    inputOnlyPins: [],
  },
  {
    id: 'esp32',
    title: 'ESP32 Lite',
    short: 'ESP32 · Wi-Fi + BLE · micro-USB',
    description: 'Классический ESP32 с большим числом выводов и внешней антенной. Для шлюзов и стационарных точек.',
    icon: 'flash-outline',
    pins: { sck: 18, miso: 19, mosi: 23, cs: 5, rst: 14, dio0: 26, busy: 27 },
    batteryPin: 34,
    usbPins: [1, 3],
    strappingPins: [0, 2, 5, 12, 15],
    inputOnlyPins: [34, 35, 36, 39],
  },
  {
    id: 'esp32s3',
    title: 'ESP32-S3',
    short: 'S3 · Wi-Fi + BLE 5 · USB-OTG',
    description: 'Двухъядерная плата с PSRAM-опциями. Подходит для шлюза с LoRa и OTA.',
    icon: 'hardware-chip-outline',
    pins: { sck: 12, miso: 13, mosi: 11, cs: 10, rst: 9, dio0: 8, busy: 7 },
    batteryPin: 1,
    usbPins: [19, 20],
    strappingPins: [0, 3, 45, 46],
    inputOnlyPins: [],
  },
];

export const DEFAULT_HUB_URL = 'http://api.kinto.is-a.dev';
export const DRAFT_KEY = 'sg:firmware-draft';

export function boardPreset(board: FirmwareBoard): BoardPreset {
  return BOARDS.find((item) => item.id === board) ?? BOARDS[0];
}

/** Черновик по умолчанию: C3 + шлюз + Wi-Fi, батарея и LoRa выключены. */
export function defaultConfig(): FirmwareConfig {
  const preset = boardPreset('esp32c3');
  return {
    board: 'esp32c3',
    role: 'gateway',
    connectivity: 'wifi',
    wifi: { ssid: '', password: '' },
    hubUrl: DEFAULT_HUB_URL,
    moduleToken: '',
    claimToken: '',
    lora: {
      chip: 'sx1278',
      frequencyMhz: 433,
      spreadingFactor: 9,
      bandwidthKhz: 125,
      syncWord: 0x12,
      pins: { ...preset.pins },
    },
    battery: {
      enabled: false,
      pin: preset.batteryPin,
      ratio: 2,
      intervalSec: 900,
    },
    ota: true,
  };
}

/** Рекомендуемые пины LoRa для платы (кнопка «Сбросить на рекомендуемые»). */
export function recommendedPins(board: FirmwareBoard): LoraPins {
  return { ...boardPreset(board).pins };
}

/** Рекомендуемый ADC-пин батареи для платы. */
export function recommendedBatteryPin(board: FirmwareBoard): number {
  return boardPreset(board).batteryPin;
}

export function isReservedPin(board: FirmwareBoard, pin: number): 'usb' | 'strapping' | null {
  const preset = boardPreset(board);
  if (preset.usbPins.includes(pin)) return 'usb';
  if (preset.strappingPins.includes(pin)) return 'strapping';
  return null;
}

export function isInputOnlyPin(board: FirmwareBoard, pin: number): boolean {
  return boardPreset(board).inputOnlyPins.includes(pin);
}

export interface PinIssue {
  kind: 'error' | 'warning';
  message: string;
}

/**
 * Проверка пинов LoRa: диапазон, уникальность, USB/strapping.
 * Ошибки блокируют «Далее», предупреждения — только показываются.
 */
export function checkLoraPins(lora: LoraConfig, board: FirmwareBoard, batteryPin?: number): PinIssue[] {
  const issues: PinIssue[] = [];
  const entries: Array<[LoraPinKey, number | undefined, string]> = [
    ['sck', lora.pins.sck, 'SCK'],
    ['miso', lora.pins.miso, 'MISO'],
    ['mosi', lora.pins.mosi, 'MOSI'],
    ['cs', lora.pins.cs, 'CS'],
    ['rst', lora.pins.rst, 'RST'],
    ['dio0', lora.pins.dio0, 'DIO0'],
    ['busy', lora.pins.busy, 'BUSY'],
  ];

  for (const [, value, label] of entries) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0 || value > 48) {
      issues.push({ kind: 'error', message: `${label}: пин должен быть целым числом 0–48.` });
    }
  }

  if (lora.chip === 'sx1262' && (lora.pins.busy === undefined || Number.isNaN(lora.pins.busy))) {
    issues.push({ kind: 'error', message: 'Для SX1262 обязателен пин BUSY.' });
  }

  const used = new Map<number, string>();
  for (const [, value, label] of entries) {
    if (value === undefined || !Number.isInteger(value)) continue;
    const other = used.get(value);
    if (other) {
      issues.push({ kind: 'error', message: `Пины ${other} и ${label} совпадают (GPIO ${value}).` });
    } else {
      used.set(value, label);
    }
  }

  for (const [pin, label] of used) {
    const reserved = isReservedPin(board, pin);
    if (reserved === 'usb') {
      issues.push({ kind: 'warning', message: `${label}: GPIO ${pin} занят USB/UART — прошивка и консоль могут не работать.` });
    } else if (reserved === 'strapping') {
      issues.push({ kind: 'warning', message: `${label}: GPIO ${pin} — strapping-пин, при старте может мешать загрузке.` });
    }
    if (isInputOnlyPin(board, pin)) {
      issues.push({ kind: 'error', message: `${label}: GPIO ${pin} работает только на вход и не годится для SPI.` });
    }
    if (batteryPin !== undefined && pin === batteryPin) {
      issues.push({ kind: 'warning', message: `${label}: GPIO ${pin} уже занят измерением батареи.` });
    }
  }

  return issues;
}

export function validateConfig(cfg: FirmwareConfig): string | null {
  if (cfg.connectivity === 'wifi_lora' && cfg.lora) {
    const errors = checkLoraPins(cfg.lora, cfg.board, cfg.battery?.enabled ? cfg.battery.pin : undefined).filter(
      (issue) => issue.kind === 'error',
    );
    if (errors.length > 0) return errors[0].message;
  }
  if (!cfg.wifi?.ssid.trim()) return 'Укажите SSID Wi-Fi сети.';
  if (cfg.hubUrl && !/^https?:\/\/[^\s]+$/i.test(cfg.hubUrl.trim())) {
    return 'URL Hub должен начинаться с http:// или https://.';
  }
  if (cfg.battery?.enabled) {
    if (!Number.isInteger(cfg.battery.pin) || cfg.battery.pin < 0 || cfg.battery.pin > 48) {
      return 'Пин батареи должен быть целым числом 0–48.';
    }
    if (!Number.isFinite(cfg.battery.ratio) || cfg.battery.ratio <= 1) {
      return 'Коэффициент делителя должен быть больше 1.';
    }
  }
  return null;
}

export function parseSyncWord(input: string): number | null {
  const raw = input.trim().replace(/^0x/i, '');
  if (!raw) return null;
  if (!/^[0-9a-f]{1,2}$/i.test(raw)) return null;
  const value = Number.parseInt(raw, 16);
  return Number.isFinite(value) ? value : null;
}

export function formatSyncWord(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

export function generateBoardUuid(): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (cryptoObj?.randomUUID) return `esp32-${cryptoObj.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const random = Math.random().toString(16).slice(2, 10);
  const random2 = Math.floor(Math.random() * 0xffffffff).toString(16);
  return `esp32-${random}${random2}`.slice(0, 22);
}

/* ------------------------------------------------------------ Hub API ---- */

/**
 * Методы прошивки добавляет параллельный агент Hub API. Пока их нет в типах
 * `api`, обращаемся через `as any` и честно сообщаем, если сервер не обновлён.
 */
function firmwareCall<T>(name: string, args: unknown[] = []): Promise<T> {
  const target = api as unknown as Record<string, unknown>;
  const fn = target[name];
  if (typeof fn !== 'function') {
    return Promise.reject(new Error(`Hub не поддерживает ${name}: серверная часть прошивки ещё не развёрнута.`));
  }
  return (fn as (...a: unknown[]) => Promise<T>).apply(api, args);
}

export function buildFirmware(config: FirmwareConfig): Promise<{ id: string; status: FirmwareBuildStatus }> {
  return firmwareCall('buildFirmware', [config]);
}

export async function firmwareBuilds(): Promise<FirmwareBuild[]> {
  const data = await firmwareCall<FirmwareBuild[] | { builds?: FirmwareBuild[] }>('firmwareBuilds');
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.builds) ? data.builds : [];
}

/** Состояние сборщика: доступен ли сервис и установлено ли ядро ESP32. */
export function firmwareBuilderStatus(): Promise<FirmwareBuilderStatus> {
  return firmwareCall('firmwareBuilderStatus', []);
}

export function firmwareBuild(id: string): Promise<FirmwareBuild> {
  return firmwareCall('firmwareBuild', [id]);
}

export async function downloadFirmware(id: string): Promise<string> {
  const target = api as unknown as Record<string, unknown>;
  if (typeof target.downloadFirmware === 'function') {
    const value = await (target.downloadFirmware as (buildId: string) => Promise<string | { url?: string }>)(id);
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object' && typeof value.url === 'string') return value.url;
  }
  // Фолбэк по документированному маршруту Hub.
  return `/v1/firmware/builds/${encodeURIComponent(id)}/download`;
}

export function deleteFirmwareBuild(id: string): Promise<unknown> {
  return firmwareCall('deleteFirmwareBuild', [id]);
}

/* -------------------------------------------------------- сеть модулей ---- */

/**
 * «Сеть аккаунта»: единая скрытая Wi-Fi mesh-сеть всех модулей.
 * SSID/пароль генерирует и хранит Hub; клиент только читает.
 */
export interface ModuleNetwork {
  networkId: string;
  ssid: string;
  password: string;
  revision: number;
  hidden: boolean;
}

/** Ищет метод в api по нескольким именам: Hub API и клиент правят параллельно. */
function dynamicApi<T>(...names: string[]): ((...args: unknown[]) => Promise<T>) | null {
  const target = api as unknown as Record<string, unknown>;
  for (const name of names) {
    const fn = target[name];
    if (typeof fn === 'function') return (fn as (...args: unknown[]) => Promise<T>).bind(api);
  }
  return null;
}

/**
 * Прямой запрос к документированному маршруту Hub. Нужен, пока в `api`
 * ещё нет методов сети модулей (этот файл другой агент не трогает).
 */
async function networkRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  const session = getSession();
  if (session?.accessToken) headers.set('authorization', `Bearer ${session.accessToken}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(`${apiBase}${path}`, { ...init, headers });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const code = typeof data?.error === 'string' ? data.error : 'error';
    const message = typeof data?.message === 'string' ? data.message : `Hub вернул HTTP ${res.status}.`;
    throw new ApiError(res.status, code, message, data?.details);
  }
  return data as T;
}

/** Текущая mesh-сеть аккаунта (Hub создаёт её при первом обращении). */
export function getModuleNetwork(): Promise<ModuleNetwork> {
  const fn = dynamicApi<ModuleNetwork>('getModuleNetwork', 'moduleNetwork');
  if (fn) return fn();
  return networkRequest<ModuleNetwork>('/v1/modules/network');
}

/** Ротация пароля сети (и SSID при rotateSsid=true); revision увеличивается. */
export function rotateModuleNetwork(options: { rotateSsid?: boolean } = {}): Promise<ModuleNetwork> {
  const fn = dynamicApi<ModuleNetwork>('rotateModuleNetwork', 'moduleNetworkRotate');
  if (fn) return fn(options);
  return networkRequest<ModuleNetwork>('/v1/modules/network/rotate', {
    method: 'POST',
    body: JSON.stringify(options),
  });
}

/** Привязка модуля: поиск идёт в существующем api.pairModule. */
export function pairModule(input: { boardUuid: string; kind?: string; firmware?: string }): Promise<{
  moduleToken: string;
  board_uuid?: string;
}> {
  const target = api as unknown as Record<string, unknown>;
  if (typeof target.pairModule !== 'function') {
    return Promise.reject(new Error('Hub не поддерживает привязку модулей.'));
  }
  return (target.pairModule as (value: typeof input) => Promise<{ moduleToken: string; board_uuid?: string }>)(input);
}

/** Абсолютный URL скачивания: относительный путь склеиваем с apiBase. */
export function resolveDownloadUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const base = apiBase.replace(/\/+$/, '');
  if (url.startsWith(base)) return url;
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

export function isTerminalStatus(status: FirmwareBuildStatus | undefined): boolean {
  return status === 'ready' || status === 'failed';
}

export function isReadyStatus(status: FirmwareBuildStatus | undefined): boolean {
  return status === 'ready';
}

export function statusLabel(status: FirmwareBuildStatus | undefined): string {
  switch (status) {
    case 'queued':
      return 'в очереди';
    case 'building':
      return 'сборка';
    case 'ready':
      return 'готова';
    case 'failed':
      return 'ошибка';
    default:
      return status || '—';
  }
}

export function statusTone(status: FirmwareBuildStatus | undefined): 'accent' | 'success' | 'danger' | 'neutral' {
  if (status === 'ready') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'queued' || status === 'building') return 'accent';
  return 'neutral';
}
