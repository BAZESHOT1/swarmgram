/**
 * Единый API-клиент SwarmGram.
 * Прямой путь к данным: клиент сам кладёт шифротекст на 3 реплики узлов,
 * Hub только выдаёт подписанные маршруты.
 */
import { Platform } from 'react-native';
import { storage, toB64u, type Session } from '../crypto/core';
import { beginRequest, endRequest } from './loading';

export type { Session } from '../crypto/core';

const NATIVE_API_CANDIDATES = [
  'https://api.swarmgram.io/api',
  'https://api.swarmgram.is-a.dev/api',
  'https://150-251-143-212.nip.io:3443/api',
];
const DEFAULT_NATIVE_API = NATIVE_API_CANDIDATES[0];
const BASE = (process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' ? '/api' : DEFAULT_NATIVE_API)).replace(/\/+$/, '');

/**
 * Живой base: если очередной домен ещё не настроен (DNS/сертификат),
 * автоматически пробуем следующий — вплоть до рабочего nip.io-fallback.
 * Это не даёт нативному клиенту застрять на чёрном экране.
 */
export let apiBase = BASE;
const usingCustomBase = Boolean(process.env.EXPO_PUBLIC_API_URL);
let candidateIndex = Math.max(0, NATIVE_API_CANDIDATES.indexOf(BASE));
function nextApiBase(): string | null {
  if (usingCustomBase) return null;
  if (apiBase.startsWith('/')) return null; // web — тот же origin
  if (candidateIndex + 1 >= NATIVE_API_CANDIDATES.length) return null;
  candidateIndex += 1;
  return NATIVE_API_CANDIDATES[candidateIndex];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let session: Session | null = null;

/* ---- сессия в куки (web): переживает перезагрузку страницы ---- */
const SESSION_COOKIE = 'sg_session';
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 3600;

function readSessionCookie(): Session | null {
  if (typeof document === 'undefined') return null;
  const parts = document.cookie ? document.cookie.split(';') : [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    try {
      return JSON.parse(decodeURIComponent(part.slice(eq + 1))) as Session;
    } catch {
      return null;
    }
  }
  return null;
}

function writeSessionCookie(value: Session | null): void {
  if (typeof document === 'undefined') return;
  if (!value) {
    document.cookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    return;
  }
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(JSON.stringify(value))}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

export async function initSession(): Promise<Session | null> {
  const stored = await storage.loadSession();
  if (stored) {
    writeSessionCookie(stored);
    session = stored;
    return session;
  }
  const fromCookie = readSessionCookie();
  if (fromCookie?.accessToken) {
    session = fromCookie;
    await storage.saveSession(fromCookie).catch(() => undefined);
    return session;
  }
  session = null;
  return session;
}

export function getSession(): Session | null {
  return session;
}

export async function setSession(s: Session | null): Promise<void> {
  session = s;
  writeSessionCookie(s);
  if (s) await storage.saveSession(s);
  else await storage.clearSession();
}

/**
 * Обновление access-token. Один общий запрос на всех: параллельные 401 не
 * должны запускать несколько refresh (сервер ротирует refreshToken).
 */
let refreshPromise: Promise<boolean> | null = null;

export async function ensureAccessToken(force = false): Promise<string | null> {
  const current = session;
  if (!current) return null;
  // accessExp в клиенте хранится в миллисекундах; поддержим и секунды из старых сессий.
  const rawExp = Number(current.accessExp || 0);
  const expMs = rawExp > 1e12 ? rawExp : rawExp * 1000;
  if (!force && expMs && expMs > Date.now() + 60_000) return current.accessToken;
  if (refreshPromise) {
    await refreshPromise;
    return session?.accessToken ?? null;
  }

  const task = (async () => {
    try {
      const res = await fetch(`${apiBase}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken?: string; refreshToken?: string; expiresIn?: number; meshRelayKey?: string };
      if (!data?.accessToken) return false;
      const next: Session = {
        ...current,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || current.refreshToken,
        accessExp: Date.now() + Number(data.expiresIn || 900) * 1000,
        meshRelayKey: data.meshRelayKey || current.meshRelayKey,
      };
      await setSession(next);
      return true;
    } catch {
      return false;
    }
  })();

  refreshPromise = task;
  try {
    await task;
  } finally {
    refreshPromise = null;
  }
  return session?.accessToken ?? null;
}

/**
 * Узлы отдают фрагменты по абсолютным http://IP:909x. На HTTPS-странице
 * браузер блокирует такие запросы (mixed content), поэтому проксируем их
 * через same-origin nginx: /node/<port>/...
 */
export function nodeUrl(url: string): string {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return url;
  const match = /^http:\/\/([^/]+):(\d+)(\/.*)?$/i.exec(url);
  if (!match) return url;
  return `${location.origin}/node/${match[2]}${match[3] || '/'}`;
}

export function wsUrl(token: string): string {
  const q = `token=${encodeURIComponent(token)}`;
  const base = apiBase;
  if (base.startsWith('/')) {
    if (typeof location === 'undefined') return `ws:///ws?${q}`;
    return `${location.protocol.startsWith('https') ? 'wss' : 'ws'}://${location.host}/ws?${q}`;
  }
  const proto = base.startsWith('https') ? 'wss' : 'ws';
  const host = base.replace(/^https?:\/\//, '').replace(/\/api$/, '');
  return `${proto}://${host}/ws?${q}`;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isAuthCall = path.startsWith('/v1/auth/');
  // Проактивно обновляем токен за минуту до истечения.
  if (!isAuthCall) await ensureAccessToken();

  const run = async (): Promise<Response> => {
    const headers = new Headers(init.headers ?? {});
    if (session?.accessToken) headers.set('authorization', `Bearer ${session.accessToken}`);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    beginRequest();
    try {
      return await fetch(`${apiBase}${path}`, { ...init, headers });
    } finally {
      endRequest();
    }
  };

  let res = await (async (): Promise<Response> => {
    try {
      return await run();
    } catch (networkError) {
      // Домен может быть ещё не настроен — перебираем кандидатов по очереди,
      // чтобы нативный клиент не оставался на чёрном экране.
      let next = nextApiBase();
      while (next) {
        apiBase = next;
        try {
          return await run();
        } catch {
          next = nextApiBase();
        }
      }
      if (!isAuthCall) {
        // Интернета нет — пробуем тот же запрос через mesh-шлюз.
        const meshHttp = await import('../modules/meshHttp').catch(() => null);
        if (meshHttp) {
          const tunneled = await meshHttp.meshHttpFetch(path, init).catch(() => null);
          if (tunneled) {
            meshHttp.throwIfMeshError(tunneled);
            return {
              status: tunneled.status,
              text: async () => JSON.stringify(tunneled.body),
            } as unknown as Response;
          }
        }
      }
      throw networkError;
    }
  })();
  // 401 — токен всё же истёк: один раз обновляем и повторяем запрос.
  if (res.status === 401 && !isAuthCall && session?.refreshToken) {
    const token = await ensureAccessToken(true);
    if (token) res = await run();
  }

  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: 'invalid_response', message: text.slice(0, 200) };
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText, data?.details);
  }
  return data as T;
}

/* ----------------------------------------------------------- типы API ---- */

/** Аватар: зашифрованный объект на узлах + ключ расшифровки (base64url). */
export interface AvatarInfo {
  objectId: string;
  key: string;
  mime: string;
}

/** Ссылка в профиле пользователя. */
export interface ProfileLink {
  label: string;
  url: string;
}

/** Видимость времени последней активности. */
export type LastSeenVisibility = 'everyone' | 'shared' | 'nobody';
/** Видимость расширенного био (ссылки, локация, ДР). */
export type BioVisibility = 'everyone' | 'chat';

/** Тип элемента истории поиска. */
export type SearchHistoryType = 'user' | 'chat' | 'group' | 'channel' | 'message';

/** Элемент истории поиска, синхронизируемый через /me. */
export interface SearchHistoryEntry {
  type: SearchHistoryType;
  id: string;
  title: string;
  subtitle?: string;
  username?: string;
  avatar?: AvatarInfo | null;
  at: string;
}

export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
  plan: string;
  role?: string;
  /** Короткий статус профиля (публичный, до 80 символов). */
  status?: string;
  /** Служебный статус аккаунта: active / disabled. */
  accountStatus?: string;
  kdfSalt?: string;
  accountPub?: string;
  emailVerified: boolean;
  createdAt: string;
  quotaBytes: number;
  baseQuotaBytes: number;
  usedBytes: number;
  credits: number;
  invitePrivacy?: string;
  /* ---- расширенный профиль ---- */
  avatar?: AvatarInfo | null;
  banner?: string;
  links?: ProfileLink[];
  location?: string;
  birthday?: string | null;
  lastSeenVisibility?: LastSeenVisibility;
  bioVisibility?: BioVisibility;
  /* ---- синхронизируемые настройки интерфейса ---- */
  themeName?: string;
  accentName?: string;
  locale?: string;
  mutedChats?: string[];
  /** История поиска (последние 20), синхронизируется между устройствами. */
  searchHistory?: SearchHistoryEntry[];
  /** Обводка: у пользователя есть узел в статусе online. */
  nodeOnline?: boolean;
  /** Обводка: у пользователя есть ESP32-модуль в статусе online. */
  moduleOnline?: boolean;
  usernamePolicy: { value: string; canChangeAt: string; canChange: boolean; cooldownDays: number };
  nodes: { id: string; name: string; status: string; free_bytes: number; capacity_bytes: number; reputation: number }[];
}

export type ChatKind = 'direct' | 'group' | 'channel';
export type ChatEncryption = 'server' | 'e2e';

/* --------------------------------------------------- группы и каналы ------ */

export type ChatVisibility = 'public' | 'closed' | 'private';
export type ChatRole = 'owner' | 'admin' | 'moderator' | 'member';

/** Набор прав одной роли. */
export interface ChatPermissionSet {
  manageInfo: boolean;
  manageMembers: boolean;
  manageRoles: boolean;
  manageInvites: boolean;
  manageRequests: boolean;
  manageBans: boolean;
  deleteMessages: boolean;
  pinMessages: boolean;
  publish: boolean;
  /** Смена аватара группы/канала (владелец не ограничивается). */
  setAvatar: boolean;
}

/** Матрица прав чата по ролям (владелец — всегда всё). */
export interface ChatPermissions {
  admin: ChatPermissionSet;
  moderator: ChatPermissionSet;
}

/** Пригласительная ссылка в чат. */
export interface InviteLink {
  id: string;
  token: string;
  role: ChatRole;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  createdAt: string;
  revokedAt: string | null;
}

/** Предпросмотр ссылки до вступления. */
export interface InvitePreview {
  chatId: string;
  title: string;
  type: string;
  visibility: ChatVisibility;
  description: string;
  membersCount: number;
  requiresApproval: boolean;
  alreadyMember: boolean;
  banned: boolean;
  valid: boolean;
}

/** Заявка на вступление в чат. */
export interface JoinRequest {
  userId: string;
  username: string;
  displayName: string;
  requestedRole: ChatRole;
  createdAt: string;
  status: string;
}

/** Блокировка в чате. */
export interface ChatBanInfo {
  userId: string;
  username: string;
  displayName: string;
  reason: string;
  until: string | null;
  createdAt: string;
}

/** Запись журнала действий чата. */
export interface ChatAuditEntry {
  id: number;
  actorId: string | null;
  actorUsername: string | null;
  action: string;
  target: string;
  meta: unknown;
  createdAt: string;
}

/** Комментарий под постом канала. */
export interface ChannelComment {
  id: string;
  messageId: string;
  userId: string;
  username: string;
  createdAt: string;
  objectId: string | null;
  nonce: string;
  header: unknown;
  canDelete: boolean;
}

/** Группа в каталоге поиска. */
export interface GroupSummary {
  id: string;
  title: string;
  description: string;
  visibility: 'public' | 'closed';
  membersCount: number;
  joined: boolean;
}

/** Краткая ссылка на чат в публичном профиле. */
export interface SharedChatRef {
  id: string;
  type: 'direct' | 'group' | 'channel';
  title: string;
  membersCount: number;
}

/** Публичный профиль пользователя + контекст просмотра. */
export interface UserProfile {
  userId: string;
  username: string;
  displayName: string;
  avatar?: AvatarInfo | null;
  banner?: string;
  /** Короткий статус профиля — публичный. */
  status?: string;
  bio: string;
  links?: ProfileLink[];
  location?: string;
  birthday?: string | null;
  bioVisibility?: BioVisibility;
  lastSeenVisibility?: LastSeenVisibility;
  createdAt: string;
  online: boolean;
  nodeOnline?: boolean;
  moduleOnline?: boolean;
  /** null, если пользователь скрыл время последней активности. */
  lastSeenAt: string | null;
  isSelf: boolean;
  blockedByMe: boolean;
  blockedMe: boolean;
  sharedChats: SharedChatRef[];
}

/** Жалоба на пользователя в админ-панели (GET /v1/admin/reports). */
export interface AdminReport {
  id: number;
  reason: string;
  note: string;
  status: 'open' | 'resolved' | 'dismissed';
  resolutionNote: string;
  createdAt: string;
  resolvedAt: string | null;
  reporter: { userId: string; username: string; displayName: string };
  target: { userId: string; username: string; displayName: string; status: string };
  chatsCount: number;
}

/** Чат нарушителя в админ-панели (GET /v1/admin/users/:id/chats). */
export interface AdminChatRef {
  id: string;
  type: string;
  title: string;
  encryption: 'server' | 'e2e';
  membersCount: number;
  lastSeq: number;
}

/** Полное представление чата для модератора (GET /v1/admin/chats/:id/view). */
export interface AdminChatView {
  chat: { id: string; type: string; title: string; encryption: string; membersCount: number };
  members: { userId: string; username: string; displayName: string; role: string }[];
  messages: {
    id: string;
    seq: number;
    kind: string;
    createdAt: string;
    senderUsername: string;
    objectId: string | null;
    nonce: string;
    header: unknown;
    scheme: 'server' | 'e2e';
    keyVersion: number | null;
  }[];
  key: { key: string; version: number } | null;
}

/** Заблокированный мной пользователь (GET /v1/me/blocked). */
export interface BlockedUser {
  userId: string;
  username: string;
  displayName: string;
  blockedAt: string;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export interface PinnedMessageMeta {
  id: string;
  senderUsername: string;
  createdAt: string;
  kind: string;
}

/** Участник чата (chatInfo.members). */
export interface ChatMember {
  userId: string;
  username: string;
  displayName: string;
  avatar?: AvatarInfo | null;
  role: string;
  nodeOnline?: boolean;
  moduleOnline?: boolean;
}

/** Пользователь из поиска. */
export interface SearchUser {
  id: string;
  username: string;
  displayName: string;
  avatar?: AvatarInfo | null;
  nodeOnline?: boolean;
  moduleOnline?: boolean;
}

export interface Chat {
  id: string;
  type: ChatKind;
  title: string;
  isPublic?: boolean;
  visibility: ChatVisibility;
  description: string;
  permissions?: ChatPermissions;
  myRole?: ChatRole;
  /** Есть ли у текущего пользователя право публиковать (в канале — «от имени канала»). */
  canPublish?: boolean;
  /** Есть ли право менять аватар группы/канала. */
  canSetAvatar?: boolean;
  /** Аватар группы/канала — зашифрованный объект на узлах. */
  avatar?: AvatarInfo | null;
  pendingRequests?: number;
  encryption: ChatEncryption;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
  membersCount?: number;
  ownerUsername?: string | null;
  unread: number;
  /** Чат находится в архиве у текущего пользователя. */
  archived: boolean;
  pinnedMessageId?: string | null;
  pinnedMessage: PinnedMessageMeta | null;
  members: ChatMember[];
  lastMessage: { id: string; seq: number; kind: string; createdAt: string; senderUserId: string; senderUsername: string } | null;
}

export interface Envelope {
  id: string;
  seq: number;
  chatId: string;
  kind: string;
  objectId: string | null;
  sizeBytes?: number;
  nonce: string;
  header: unknown;
  replyTo: string | null;
  scheme?: 'server' | 'e2e';
  keyVersion?: number;
  edited?: boolean;
  reactions?: MessageReaction[];
  /** Число комментариев (только для постов каналов). */
  commentsCount?: number;
  /** Число просмотревших сообщение. */
  viewsCount?: number;
  /** Пост опубликован от имени канала. */
  asChannel?: boolean;
  createdAt: string;
  senderUserId: string;
  senderUsername: string;
  senderDeviceId: string;
  clientId?: string | null;
  /* локальный маршрут доставки — только на клиенте */
  state?: 'pending' | 'sent' | 'failed';
}

export interface ObjectRoutes {
  id: string;
  sizeBytes: number;
  sha256: string;
  fragments: { index: number; nodeId: string; subnet: string; url: string; ticket: string; sizeBytes: number; nodeOnline: boolean }[];
}

export interface DeviceKeyRow {
  deviceId: string;
  wrappedKey: string;
}

export interface MissingKeyDevice {
  device_id: string;
  user_id: string;
  ecdh_pub: string;
  identity_pub: string;
}

export interface AccountKeyRow {
  userId: string;
  wrappedKey: string;
}

export interface AccountMissingUser {
  userId: string;
  username: string;
  accountPub: string;
}

export interface BundleDevice {
  deviceId: string;
  identityPub: string;
  ecdhPub: string;
  signedPrekey: string;
  prekeySig: string;
  oneTimePrekey: string | null;
}

export interface UploadedObject {
  id: string;
  sizeBytes: number;
  sha256: string;
  replicas: number;
  replicasDesired: number;
}

export interface ChannelSummary {
  id: string;
  title: string;
  description?: string;
  visibility?: ChatVisibility;
  owner_username: string | null;
  subscribers: number;
  subscribed: boolean;
  posts: number;
  last_post: string | null;
}

export type ModuleRole = 'gateway' | 'repeater' | 'wearable';
export type ModuleTransport = 'wifi' | 'lora' | 'ble' | 'usb';

export interface ModuleRow {
  id: string;
  /** Legacy-имя hardwareId; равно hardwareId. */
  board_uuid: string;
  boardUuid?: string;
  /** Стабильный esp32-<MAC> из eFuse. */
  hardwareId?: string;
  /** 8-значный публичный ID модуля в единой mesh-сети. */
  publicId?: string;
  role?: ModuleRole | string;
  transport?: ModuleTransport | string;
  attached?: boolean;
  online?: boolean;
  kind: string;
  firmware: string;
  battery: number;
  gateway: boolean;
  neighbors: number;
  rssi?: number;
  uptime?: number;
  status: 'online' | 'offline' | 'blocked' | string;
  blocked?: boolean;
  blockReason?: string;
  attachedAt?: string | null;
  lastSeenAt?: string | null;
  last_seen_at: string | null;
  created_at: string;
  /** Shadow-запись: модуль был привязан на другом устройстве. */
  shadow?: boolean;
  /** ID shadow-записи для dismiss/report. */
  shadowId?: string;
  /** Модуль перепривязан к другому аккаунту/устройству. */
  detachedToOther?: boolean;
  /** Пояснение для shadow-карточки. */
  message?: string;
}

/** Shadow-запись модуля, привязанного на другом устройстве. */
export interface ModuleShadow {
  shadowId: string;
  publicId?: string;
  hardwareId?: string;
  message?: string;
  detachedToOther?: boolean;
  createdAt?: string;
}

/** Глобальная mesh-сеть: параметры, которые сервер подставляет в прошивку. */
export interface ModuleMesh {
  networkId?: string;
  ssid?: string;
  channel?: number;
  hidden?: boolean;
  lora?: {
    frequencyMhz?: number;
    spreadingFactor?: number;
    bandwidthKhz?: number;
  };
  hops?: number;
  publicIdLength?: number;
  modules?: ModuleRow[];
  [key: string]: unknown;
}

export interface MeshNeighbor {
  neighbor_uuid: string;
  rssi: number;
  channel: string;
  has_gateway: boolean;
  seen_at: string;
}

/* ---- сборка прошивок ESP32 (визард) ---- */

export type FirmwareBoard = 'esp32c3' | 'esp32' | 'esp32s3';
export type FirmwareRole = 'gateway' | 'repeater' | 'wearable';
export type FirmwareConnectivity = 'wifi' | 'wifi_lora';
export type FirmwareLoraChip = 'sx1278' | 'sx1276' | 'sx1262';

/** Пины LoRa-модуля (рекомендуемые значения подставляет визард). */
export interface FirmwareLoraPins {
  sck: number;
  miso: number;
  mosi: number;
  cs: number;
  rst: number;
  dio0: number;
  busy?: number;
}

/** Полная конфигурация прошивки, которую принимает Hub. */
export interface FirmwareConfig {
  board: FirmwareBoard;
  role: FirmwareRole;
  connectivity: FirmwareConnectivity;
  wifi?: { ssid: string; password: string };
  hubUrl?: string;
  moduleToken?: string;
  claimToken?: string;
  lora?: {
    chip: FirmwareLoraChip;
    frequencyMhz: 433 | 868 | 915;
    spreadingFactor: number;
    bandwidthKhz: 125 | 250 | 500;
    syncWord: number;
    pins: FirmwareLoraPins;
  };
  battery?: { enabled: boolean; pin: number; ratio: number; intervalSec: number };
  ota?: boolean;
}

export type FirmwareBuildStatus = 'queued' | 'building' | 'ready' | 'failed';

/** Запись истории серверной сборки. */
export interface FirmwareBuild {
  id: string;
  status: FirmwareBuildStatus;
  version: string;
  sizeBytes: number;
  sha256: string;
  log: string;
  config: FirmwareConfig;
  /** true — merged.bin (можно писать с 0x0 из браузера). */
  merged?: boolean;
  createdAt: string;
}

/** Состояние build-сервиса (запущен ли, установлено ли ядро). */
export interface FirmwareBuilderStatus {
  available: boolean;
  core: boolean;
  freeMb: number | null;
  coreVersion: string | null;
  boards?: string[];
  reason: 'unreachable' | 'core_missing' | null;
}

/* ---------------------------------------------------------------- API ---- */

export const api = {
  /* ---- auth ---- */
  async register(input: {
    email: string;
    username: string;
    password: string;
    displayName?: string;
    device: {
      deviceId: string;
      deviceName: string;
      platform: string;
      identityPub: string;
      ecdhPub: string;
      signedPrekey: string;
      prekeySig: string;
      prekeys: string[];
    };
  }) {
    return req<{ user: User; deviceId: string; accessToken: string; refreshToken: string; expiresIn: number }>(
      '/v1/auth/register',
      { method: 'POST', body: JSON.stringify(input) },
    );
  },

  async login(input: { login: string; password: string; device: Record<string, unknown> }) {
    return req<{ user: User; deviceId: string; accessToken: string; refreshToken: string; expiresIn: number }>(
      '/v1/auth/login',
      { method: 'POST', body: JSON.stringify(input) },
    );
  },

  resetRequest: (email: string) =>
    req<{ ok: true; devCode?: string }>('/v1/auth/reset/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  resetConfirm: (email: string, code: string, password: string) =>
    req<{ ok: true }>('/v1/auth/reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ email, code, password }),
    }),

  refresh: (refreshToken: string) =>
    req<{ accessToken: string; refreshToken: string; expiresIn: number }>('/v1/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),

  logout: (refreshToken?: string) => req('/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }),

  verifyEmail: (email: string, code: string) =>
    req('/v1/auth/verify-email', { method: 'POST', body: JSON.stringify({ email, code }) }),

  checkUsername: (username: string) =>
    req<{ available: boolean }>(`/v1/auth/check-username?username=${encodeURIComponent(username)}`),

  /* ---- profile ---- */
  me: () => req<User>('/v1/me'),
  patchMe: (
    input:
      | {
          displayName?: string;
          bio?: string;
          /** Короткий статус профиля (до 80 символов); пустая строка — сброс. */
          status?: string;
          invitePrivacy?: 'everyone' | 'shared' | 'chat' | 'nobody';
          links?: ProfileLink[];
          location?: string;
          birthday?: string | null;
          banner?: string;
          lastSeenVisibility?: LastSeenVisibility;
          bioVisibility?: BioVisibility;
          themeName?: string;
          accentName?: string;
          locale?: string;
          mutedChats?: string[];
          searchHistory?: SearchHistoryEntry[];
        }
      | string,
  ) =>
    req('/v1/me', {
      method: 'PATCH',
      body: JSON.stringify(typeof input === 'string' ? { displayName: input } : input),
    }),
  /** Сохранить аватар: клиент уже загрузил шифротекст, Hub хранит ключ и mime. */
  putAvatar: (input: { objectId: string; key: string; mime: string }) =>
    req<{ avatar: AvatarInfo }>('/v1/me/avatar', { method: 'PUT', body: JSON.stringify(input) }),
  deleteAvatar: () => req<{ ok: true }>('/v1/me/avatar', { method: 'DELETE' }),
  userProfile: (username: string) =>
    req<UserProfile>('/v1/users/' + encodeURIComponent(username) + '/profile'),
  setBlock: (username: string, blocked: boolean) =>
    req<{ blocked: boolean }>(`/v1/users/${encodeURIComponent(username)}/block`, {
      method: blocked ? 'POST' : 'DELETE',
    }),
  myBlocked: () => req<BlockedUser[]>('/v1/me/blocked'),
  reportUser: (username: string, reason: string, note?: string) =>
    req<{ ok: true }>(`/v1/users/${encodeURIComponent(username)}/report`, {
      method: 'POST',
      body: JSON.stringify({ reason, note }),
    }),
  changePassword: (oldPassword: string, newPassword: string) =>
    req<{ ok: boolean }>('/v1/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) }),
  changeUsername: (username: string) =>
    req<{ username: string; canChangeAt: string }>('/v1/me/username', { method: 'POST', body: JSON.stringify({ username }) }),
  listDevices: (token: string) => req<{ id: string; name: string; platform: string; created_at: string }[]>('/v1/me/devices', { method: 'GET', headers: { authorization: `Bearer ${token}` } }),
  revokeDevice: (id: string) => req(`/v1/me/devices/${id}`, { method: 'DELETE' }),
  /** Удаление аккаунта; пароль подтверждает необратимое действие. */
  deleteAccount: (password: string) =>
    req<{ ok: true }>('/v1/me', { method: 'DELETE', body: JSON.stringify({ password }) }),

  /* ---- ключевой материал ---- */
  getBundle: (username: string) =>
    req<{ userId: string; username: string; accountPub?: string; devices: BundleDevice[] }>(`/v1/users/${encodeURIComponent(username)}/bundle`),
  myChatKeys: (chatId: string) => req<DeviceKeyRow[]>(`/v1/chats/${chatId}/keys`),
  missingKeys: (chatId: string) => req<MissingKeyDevice[]>(`/v1/chats/${chatId}/missing-keys`),
  uploadChatKeys: (chatId: string, keys: { deviceId: string; wrappedKey: string }[]) =>
    req(`/v1/chats/${chatId}/keys`, { method: 'POST', body: JSON.stringify({ keys }) }),

  /* ---- серверный ключ чата (основной режим) ---- */
  chatKey: (chatId: string, version?: number) =>
    req<{ key: string; version: number; rotatedAt: string }>(
      `/v1/chats/${chatId}/key${version !== undefined ? `?version=${version}` : ''}`,
    ),
  pinMessage: (chatId: string, messageId: string | null) =>
    req<{ ok: true }>(`/v1/chats/${chatId}/pin`, { method: 'POST', body: JSON.stringify({ messageId }) }),
  typing: (chatId: string) =>
    req<{ ok: true }>(`/v1/chats/${chatId}/typing`, { method: 'POST', body: JSON.stringify({}) }),
  setReaction: (chatId: string, messageId: string, emoji: string) =>
    req<MessageReaction[]>(`/v1/chats/${chatId}/messages/${messageId}/reactions`, {
      method: 'PUT',
      body: JSON.stringify({ emoji }),
    }),
  editMessage: (chatId: string, messageId: string, body: { objectId: string; nonce: string; header?: unknown }) =>
    req<{ ok: true }>(`/v1/chats/${chatId}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  /* ---- ключи уровня аккаунта (мультиустройство) ---- */
  putAccountKey: (accountPub: string) =>
    req<{ ok: true }>('/v1/me/account-key', { method: 'PUT', body: JSON.stringify({ accountPub }) }),
  userAccountKey: (username: string) =>
    req<{ userId: string; username: string; accountPub: string }>(`/v1/users/${encodeURIComponent(username)}/account-key`),
  myAccountChatKeys: (chatId: string) => req<AccountKeyRow[]>(`/v1/chats/${chatId}/account-keys`),
  accountMissing: (chatId: string) => req<AccountMissingUser[]>(`/v1/chats/${chatId}/account-missing`),
  uploadAccountChatKeys: (chatId: string, keys: { userId: string; wrappedKey: string }[]) =>
    req(`/v1/chats/${chatId}/account-keys`, { method: 'POST', body: JSON.stringify({ keys }) }),

  /* ---- объекты: 2-фазная загрузка прямо на узлы ---- */
  async objectInit(size: number, sha256: string): Promise<{
    id: string;
    sizeBytes: number;
    sha256: string;
    replicasDesired: number;
    replicas: { index: number; nodeId: string; url: string; ticket: string }[];
  }> {
    return req<{ id: string; sizeBytes: number; sha256: string; replicasDesired: number; replicas: { index: number; nodeId: string; url: string; ticket: string }[] }>(
      '/v1/objects/init',
      { method: 'POST', body: JSON.stringify({ size, sha256 }) },
    );
  },

  objectCommit: (id: string, replicas: { index: number; nodeId: string; size: number; sha256: string }[]) =>
    req<UploadedObject>(`/v1/objects/${id}/commit`, {
      method: 'POST',
      body: JSON.stringify({ replicas }),
    }),

  objectRoutes: (id: string) => req<ObjectRoutes>(`/v1/objects/${id}`),

  async putFragment(url: string, ticket: string, bytes: Uint8Array): Promise<{ size: number; sha256: string } | null> {
    // RN (Hermes) принимает ArrayBuffer, web — и Uint8Array
    const body: BodyInit = Platform.OS === 'web' ? (bytes as unknown as BodyInit) : (bytes.slice().buffer as unknown as BodyInit);
    beginRequest();
    try {
      const res = await fetch(nodeUrl(url), {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'x-sg-ticket': ticket },
        body,
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as { size?: number; sha256?: string };
      return { size: data.size ?? bytes.length, sha256: data.sha256 ?? '' };
    } catch {
      return null;
    } finally {
      endRequest();
    }
  },

  async fetchFragment(fragment: { url: string; ticket: string }): Promise<Uint8Array> {
    beginRequest();
    try {
      const res = await fetch(nodeUrl(fragment.url), { headers: { 'x-sg-ticket': fragment.ticket } });
      if (!res.ok) throw new ApiError(res.status, 'node_error', `node returned ${res.status}`);
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    } finally {
      endRequest();
    }
  },

  searchUsers: (q: string) =>
    req<SearchUser[]>(`/v1/users/search?q=${encodeURIComponent(q)}`),

  proxyObject: (id: string) => `${BASE}/v1/objects/${id}/proxy`,

  /* ---- чаты ---- */
  listChats: (archived = false) => req<Chat[]>(`/v1/chats${archived ? '?archived=1' : ''}`),
  getChat: (id: string) => req<Chat>(`/v1/chats/${id}`),
  /** Архивировать/вернуть из архива (персональный флаг участника). */
  setChatArchived: (id: string, archived: boolean) =>
    req<{ ok: true }>(`/v1/chats/${id}/archive`, { method: 'POST', body: JSON.stringify({ archived }) }),
  createChat: (input: {
    type: ChatKind;
    username?: string;
    title?: string;
    isPublic?: boolean;
    visibility?: ChatVisibility;
    description?: string;
    members?: string[];
    keys?: { deviceId: string; wrappedKey: string }[];
    encryption?: ChatEncryption;
  }) => req<Chat>('/v1/chats', { method: 'POST', body: JSON.stringify(input) }),
  joinChat: (id: string) =>
    req<{ status: 'joined' | 'requested'; chatId: string }>(`/v1/chats/${id}/join`, { method: 'POST' }),
  leaveChat: (id: string) =>
    req<{ ok: true }>(`/v1/chats/${id}/leave`, { method: 'POST' }),
  deleteChat: (id: string) =>
    req<{ ok: true }>(`/v1/chats/${id}`, { method: 'DELETE' }),

  /* ---- группы/каналы: настройки, права, роли ---- */
  patchChat: (id: string, input: { title?: string; description?: string; visibility?: ChatVisibility }) =>
    req<Chat>(`/v1/chats/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  getChatPermissions: (id: string) =>
    req<ChatPermissions & { myRole: ChatRole }>(`/v1/chats/${id}/permissions`),
  setChatPermissions: (
    id: string,
    input: { admin?: Partial<ChatPermissionSet>; moderator?: Partial<ChatPermissionSet> },
  ) =>
    req<ChatPermissions & { myRole: ChatRole }>(`/v1/chats/${id}/permissions`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  setMemberRole: (id: string, userId: string, role: 'admin' | 'moderator' | 'member') =>
    req<{ ok: true; role: ChatRole }>(`/v1/chats/${id}/members/${userId}/role`, {
      method: 'POST',
      body: JSON.stringify({ role }),
    }),
  removeMember: (id: string, userId: string) =>
    req<{ ok: true }>(`/v1/chats/${id}/members/${userId}`, { method: 'DELETE' }),
  transferOwnership: (id: string, userId: string) =>
    req<{ ok: true }>(`/v1/chats/${id}/transfer`, { method: 'POST', body: JSON.stringify({ userId }) }),

  /* ---- пригласительные ссылки ---- */
  chatInvites: (id: string) => req<InviteLink[]>(`/v1/chats/${id}/invites`),
  createInvite: (
    id: string,
    input: { role?: 'member' | 'moderator' | 'admin'; expiresInHours?: number | null; maxUses?: number | null } = {},
  ) =>
    req<Omit<InviteLink, 'createdAt' | 'revokedAt'>>(`/v1/chats/${id}/invites`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  revokeInvite: (id: string, inviteId: string) =>
    req<{ ok: true }>(`/v1/chats/${id}/invites/${inviteId}`, { method: 'DELETE' }),
  invitePreview: (token: string) => req<InvitePreview>(`/v1/invites/${encodeURIComponent(token)}`),
  joinInvite: (token: string) =>
    req<{ status: 'joined' | 'requested'; chatId: string }>(`/v1/invites/${encodeURIComponent(token)}/join`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  /* ---- аватар группы/канала ---- */
  /** Сохранить аватар чата (объект уже загружен на узлы). */
  setChatAvatar: (id: string, input: { objectId: string; key: string; mime: string }) =>
    req<Chat>(`/v1/chats/${id}/avatar`, { method: 'POST', body: JSON.stringify(input) }),
  deleteChatAvatar: (id: string) =>
    req<Chat>(`/v1/chats/${id}/avatar`, { method: 'DELETE' }),

  directInvite: (id: string, username: string) =>
    req<{ ok: true; chatId: string; added: boolean }>(`/v1/chats/${id}/invite`, {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),

  /* ---- заявки на вступление ---- */
  joinRequests: (id: string, status: 'pending' | 'all' = 'pending') =>
    req<JoinRequest[]>(`/v1/chats/${id}/requests?status=${encodeURIComponent(status)}`),
  approveRequest: (id: string, userId: string) =>
    req<{ ok: true; status: string }>(`/v1/chats/${id}/requests/${userId}/approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  rejectRequest: (id: string, userId: string) =>
    req<{ ok: true; status: string }>(`/v1/chats/${id}/requests/${userId}/reject`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /* ---- блокировки и журнал ---- */
  chatBans: (id: string) => req<ChatBanInfo[]>(`/v1/chats/${id}/bans`),
  banMember: (id: string, input: { userId: string; reason?: string; durationHours?: number }) =>
    req<{ ok: true }>(`/v1/chats/${id}/bans`, { method: 'POST', body: JSON.stringify(input) }),
  unbanMember: (id: string, userId: string) =>
    req<{ ok: true }>(`/v1/chats/${id}/bans/${userId}`, { method: 'DELETE' }),
  chatAudit: (id: string) => req<ChatAuditEntry[]>(`/v1/chats/${id}/audit`),

  listMessages: (chatId: string, params: { before?: number; after?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.before) qs.set('before', String(params.before));
    if (params.after) qs.set('after', String(params.after));
    qs.set('limit', String(params.limit ?? 50));
    return req<Envelope[]>(`/v1/chats/${chatId}/messages?${qs.toString()}`);
  },

  sendMessage: (
    chatId: string,
    body: {
      objectId: string;
      nonce: string;
      header?: unknown;
      kind?: string;
      clientId?: string;
      replyTo?: string;
      /** Опубликовать от имени канала (только каналы с правом publish). */
      asChannel?: boolean;
    },
  ) => req<Envelope>(`/v1/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify(body) }),

  postReceipt: (chatId: string, messageId: string) =>
    req(`/v1/chats/${chatId}/messages/${messageId}/receipt`, { method: 'POST', body: JSON.stringify({}) }),

  /** Отметить сообщение просмотренным; возвращает актуальное число просмотров. */
  markMessageView: (chatId: string, messageId: string) =>
    req<{ ok: true; views: number }>(`/v1/chats/${chatId}/messages/${messageId}/view`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  markRead: (chatId: string, seq: number) =>
    req(`/v1/chats/${chatId}/read`, { method: 'POST', body: JSON.stringify({ seq }) }),

  deleteMessage: (chatId: string, messageId: string) =>
    req(`/v1/chats/${chatId}/messages/${messageId}`, { method: 'DELETE' }),

  /* ---- каналы ---- */
  listChannels: (search = '') =>
    req<ChannelSummary[]>(`/v1/channels?search=${encodeURIComponent(search)}`),
  searchGroups: (search = '') =>
    req<GroupSummary[]>(`/v1/groups?search=${encodeURIComponent(search)}`),
  mySubscriptions: () => req<Chat[]>('/v1/channels/subscriptions'),
  createChannel: (title: string) => req<Chat>('/v1/channels', { method: 'POST', body: JSON.stringify({ title }) }),
  subscribe: (id: string) =>
    req<Chat | { status: 'requested'; chatId: string }>(`/v1/channels/${id}/subscribe`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  unsubscribe: (id: string) => req(`/v1/channels/${id}/subscribe`, { method: 'DELETE' }),

  /* ---- комментарии под постами каналов ---- */
  channelComments: (chatId: string, messageId: string) =>
    req<ChannelComment[]>(`/v1/chats/${chatId}/posts/${messageId}/comments`),
  createChannelComment: (
    chatId: string,
    messageId: string,
    input: { objectId: string; nonce: string; header?: unknown },
  ) =>
    req<ChannelComment>(`/v1/chats/${chatId}/posts/${messageId}/comments`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteChannelComment: (chatId: string, messageId: string, commentId: string) =>
    req<{ ok: true }>(`/v1/chats/${chatId}/posts/${messageId}/comments/${commentId}`, { method: 'DELETE' }),

  /* ---- узлы ---- */
  myNodes: () => req<any[]>('/v1/nodes/mine'),
  networkNodes: () => req<any[]>('/v1/nodes'),
  createClaim: (nodeName?: string) =>
    req<{ claimToken: string; expiresAt: string }>('/v1/nodes/claim', { method: 'POST', body: JSON.stringify({ nodeName }) }),
  setNodeStatus: (id: string, status: string) =>
    req(`/v1/nodes/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),

  /* ---- esp32 модули ---- */
  pairModule: (input: {
    hardwareId?: string;
    boardUuid?: string;
    /** 8-значный публичный ID из INFO модуля. */
    publicId?: string;
    role?: ModuleRole | string;
    transport?: ModuleTransport | string;
    moduleType?: string;
    isPublic?: boolean;
    kind?: string;
    firmware?: string;
    battery?: number;
  }) =>
    req<ModuleRow & { moduleToken: string; checkinIntervalSec: number }>('/v1/modules/pair', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listModules: () => req<ModuleRow[]>('/v1/modules'),
  /**
   * Добавить подготовленный модуль по 8-значному ID.
   * 404 означает «модуль ещё не появился в сети» — ConnectModuleFlow
   * опрашивает повторно каждые 3 секунды до 60 секунд.
   */
  claimModule: (publicId: string) =>
    req<ModuleRow>('/v1/modules/claim', {
      method: 'POST',
      body: JSON.stringify({ publicId }),
    }),
  /** Параметры единой глобальной mesh-сети (только чтение из UI). */
  getModuleMesh: () => req<ModuleMesh>('/v1/modules/mesh'),
  /** Удалить shadow-запись «модуль привязан на другом устройстве». */
  dismissModuleShadow: (id: string) =>
    req<{ ok: true }>(`/v1/modules/shadows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Сообщить «это не я» — shadow-запись уходит в поддержку. */
  reportModuleShadow: (id: string) =>
    req<{ ok: true }>(`/v1/modules/shadows/${encodeURIComponent(id)}/report`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getModule: (id: string) => req<ModuleRow>(`/v1/modules/${encodeURIComponent(id)}`),
  unbindModule: (id: string) => req(`/v1/modules/${id}`, { method: 'DELETE' }),
  attachModule: (id: string, transport: 'ble' | 'usb') =>
    req<{ ok: boolean; attached: boolean; transport: string }>(`/v1/modules/${id}/attach`, {
      method: 'POST',
      body: JSON.stringify({ transport }),
    }),
  detachModule: (id: string) =>
    req<{ ok: boolean; attached: boolean }>(`/v1/modules/${id}/detach`, { method: 'POST' }),
  blockModule: (id: string, reason?: string) =>
    req<{ ok: boolean; blocked: boolean; blockReason: string }>(`/v1/modules/${id}/block`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  unblockModule: (id: string) =>
    req<{ ok: boolean; blocked: boolean }>(`/v1/modules/${id}/unblock`, { method: 'POST' }),
  moduleNeighbors: (id: string) => req<MeshNeighbor[]>(`/v1/modules/${id}/neighbors`),

  /* ---- серверная сборка прошивок ---- */
  buildFirmware: (config: FirmwareConfig) =>
    req<{ id: string; status: FirmwareBuildStatus }>('/v1/firmware/build', {
      method: 'POST',
      body: JSON.stringify({ config }),
    }),
  firmwareBuilds: () => req<FirmwareBuild[]>('/v1/firmware/builds'),
  firmwareBuild: (id: string) => req<FirmwareBuild>(`/v1/firmware/builds/${encodeURIComponent(id)}`),
  firmwareBuilderStatus: () => req<FirmwareBuilderStatus>('/v1/firmware/builder'),
  /** Прямая ссылка на .bin (токен в query, чтобы работал <a download>). */
  downloadFirmware: (id: string) => {
    const token = session?.accessToken ? `?access_token=${encodeURIComponent(session.accessToken)}` : '';
    return `${BASE}/v1/firmware/builds/${encodeURIComponent(id)}/download${token}`;
  },
  deleteFirmwareBuild: (id: string) =>
    req<{ ok: true }>(`/v1/firmware/builds/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* ---- админ (роль admin или x-admin-token) ---- */
  adminUsers: (q: string) =>
    req<{ id: string; email: string; username: string; role: string; plan: string; status: string; used_bytes: number; quota_bytes: number; created_at: string }[]>(
      `/v1/admin/users?q=${encodeURIComponent(q)}`,
    ),
  adminNodes: () =>
    req<{ id: string; name: string; owner_id: string; owner_username: string; status: string; blocked_reason: string | null; public_url: string; subnet: string; last_ip: string; hw_hash: string; region: string; reputation: number; capacity_bytes: number; used_bytes: number; free_bytes: number; last_heartbeat_at: string | null; registered_at: string }[]>(
      '/v1/admin/nodes',
    ),
  adminModules: () =>
    req<{ id: string; board_uuid: string; module_type: string; is_public: boolean; kind: string; owner_id: string; owner_username: string; status: string; blocked_reason: string | null; firmware: string; battery: number; gateway: boolean; neighbors: number; last_seen_at: string | null }[]>(
      '/v1/admin/modules',
    ),
  adminChats: () =>
    req<{ id: string; type: string; title: string; is_public: boolean; blocked_reason: string | null; owner_id: string; owner_username: string | null; members: number; messages: number }[]>(
      '/v1/admin/chats',
    ),
  adminAudit: () =>
    req<{ id: number; actor_id: string; actor: string; action: string; target: string; meta: unknown; created_at: string }[]>('/v1/admin/audit'),
  adminUserStatus: (id: string, status: string, reason: string) =>
    req(`/v1/admin/users/${id}/status`, { method: 'POST', body: JSON.stringify({ status, reason }) }),
  adminNodeBlock: (id: string, reason: string) =>
    req(`/v1/admin/nodes/${id}/block`, { method: 'POST', body: JSON.stringify({ reason }) }),
  adminNodeUnblock: (id: string, reason?: string) =>
    req(`/v1/admin/nodes/${id}/unblock`, { method: 'POST', body: JSON.stringify({ reason }) }),
  adminModuleBlock: (id: string, reason: string) =>
    req(`/v1/admin/modules/${id}/block`, { method: 'POST', body: JSON.stringify({ reason }) }),
  adminModuleUnblock: (id: string, reason?: string) =>
    req(`/v1/admin/modules/${id}/unblock`, { method: 'POST', body: JSON.stringify({ reason }) }),
  adminChatBlock: (id: string, reason: string) =>
    req(`/v1/admin/chats/${id}/block`, { method: 'POST', body: JSON.stringify({ reason }) }),
  adminChatUnblock: (id: string) =>
    req(`/v1/admin/chats/${id}/unblock`, { method: 'POST', body: JSON.stringify({}) }),
  adminChatDelete: (id: string, reason?: string) =>
    req(`/v1/admin/chats/${id}`, { method: 'DELETE', body: JSON.stringify({ reason }) }),

  /* ---- админ: жалобы и модерация переписки ---- */
  adminReports: (status: 'open' | 'all') =>
    req<AdminReport[]>(`/v1/admin/reports?status=${encodeURIComponent(status)}`),
  adminResolveReport: (id: number, status: 'open' | 'resolved' | 'dismissed', note?: string) =>
    req<{ ok: true; status: string }>(`/v1/admin/reports/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ status, note }),
    }),
  adminUserChats: (id: string) =>
    req<AdminChatRef[]>(`/v1/admin/users/${encodeURIComponent(id)}/chats`),
  adminChatView: (id: string) =>
    req<AdminChatView>(`/v1/admin/chats/${encodeURIComponent(id)}/view`),
  adminDeleteMessage: (id: string) =>
    req<{ ok: true }>(`/v1/admin/messages/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  adminWarnUser: (id: string, note: string) =>
    req<{ ok: true }>(`/v1/admin/users/${encodeURIComponent(id)}/warn`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  /* ---- резерв ключей (шифрованный на сервере) ---- */
  getBackup: () => req<{ kdfSalt: string; blob: string | null; updatedAt: string | null }>('/v1/me/backup'),
  putBackup: (blob: string) => req<{ ok: true; updatedAt: string }>('/v1/me/backup', { method: 'PUT', body: JSON.stringify({ blob }) }),

  /* ---- статистика ---- */
  stats: () =>
    req<{
      users: number;
      nodes: { total: number; online: number };
      capacityBytes: number;
      storedBytes: number;
      objects: number;
      messages: number;
    }>('/v1/stats'),
};

export { toB64u };
