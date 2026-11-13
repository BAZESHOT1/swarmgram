/**
 * ESP32-модули связи (глобальный Wi-Fi mesh и Wi-Fi mesh + LoRa).
 *
 * Идентичность модуля:
 *  - hardware_id = esp32-<MAC из eFuse>, не меняется при перепрошивке;
 *  - public_id — 8 цифр, вычисляется из hardware_id по FNV-1a 32
 *    (см. src/meshId.ts), перепрошивка его не меняет.
 *
 * Привязка:
 *  - wearable привязывается автоматически при физическом подключении
 *    по USB/BLE (POST /modules/pair, клиент передаёт hardwareId/publicId);
 *  - repeater/gateway привязываются по 8-значному public_id
 *    (POST /modules/claim) — подтверждения по ID достаточно, online не нужен;
 *  - перепривязка к другому аккаунту не блокируется: у прежнего владельца
 *    создаётся «тень» (module_shadows) с возможностью удалить/пожаловаться.
 *
 * Статус online вычисляется на чтении по времени последнего check-in:
 *  - gateway/repeater: last_seen_at свежее 150 секунд;
 *  - wearable: attached=true + last_seen_at свежее 90 секунд + BLE/USB.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { Readable } from 'node:stream';
import { storeEncrypted } from '../storageRelay.js';
import { signToken, verifyToken, sha256, uuid } from '../crypto.js';
import { one, query, tx } from '../db.js';
import { ensurePublicId, isPublicId, publicIdFromHardware } from '../meshId.js';
import { deriveMeshRelayKey } from '../secrets.js';
import { publish, publishMany } from '../realtime.js';
import { enqueueNotification } from '../push.js';
import {
  ApiError,
  badRequest,
  clientIp,
  conflict,
  forbidden,
  log,
  notFound,
  rateLimit,
  str,
  unauthorized,
} from '../util.js';
import { getMeshConfig, meshPublicConfig } from './network.js';
import { getFragment } from '../nodes.js';

type ModuleRole = 'gateway' | 'repeater' | 'wearable';
type ModuleTransport = 'wifi' | 'lora' | 'ble' | 'usb';

declare module 'fastify' {
  interface FastifyRequest {
    module?: {
      moduleId: string;
      ownerId: string;
      moduleType: string;
      isPublic: boolean;
      hardwareId: string;
      publicId: string;
      role: string;
      transport: string;
      attached: boolean;
    };
  }
}

/* ------------------------------------------------------------- утилиты --- */

const ROLES: ModuleRole[] = ['gateway', 'repeater', 'wearable'];
const TRANSPORTS: ModuleTransport[] = ['wifi', 'lora', 'ble', 'usb'];
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

function asRole(value: unknown, fallback: ModuleRole): ModuleRole {
  return ROLES.includes(value as ModuleRole) ? (value as ModuleRole) : fallback;
}

function asTransport(value: unknown, fallback: ModuleTransport): ModuleTransport {
  return TRANSPORTS.includes(value as ModuleTransport) ? (value as ModuleTransport) : fallback;
}

/** Транспорт по умолчанию, если клиент его не передал. */
function defaultTransport(role: ModuleRole, kind: string): ModuleTransport {
  if (role === 'wearable') return 'usb';
  return kind === 'lora' ? 'lora' : 'wifi';
}

/** Нарушение уникальности в PostgreSQL. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

/** Коллизия именно публичного ID (unique-индекс modules_public_id_key). */
function isPublicIdCollision(error: unknown): boolean {
  return (
    isUniqueViolation(error) &&
    (error as { constraint?: string }).constraint === 'modules_public_id_key'
  );
}

/** Проверка аппаратной блокировки по hardware_id (sha256 и legacy-raw). */
/** ID скрытого системного владельца несостоявшихся модулей. */
async function systemOwnerId(): Promise<string> {
  const row = await one<{ id: string }>(
    `SELECT id FROM users WHERE username = 'system_modules' LIMIT 1`,
  );
  return row?.id ?? '';
}

async function isHardwareBlocked(hardwareId: string): Promise<boolean> {
  if (!hardwareId) return false;
  const row = await one(
    'SELECT 1 FROM blocked_nodes WHERE active = true AND hw_hash = ANY($1::text[]) LIMIT 1',
    [[sha256(hardwareId), hardwareId]],
  );
  return Boolean(row);
}

/** Все активные аппаратные блокировки — для пакетного вычисления статуса. */
async function activeBlockedHashes(): Promise<Set<string>> {
  const rows = await query<{ hw_hash: string }>('SELECT hw_hash FROM blocked_nodes WHERE active = true');
  return new Set(rows.map((r) => r.hw_hash));
}

/**
 * Назначает public_id уже существующему модулю, у которого поле пустое.
 * При коллизии unique-индекса повторяет с солью `hardwareId#2`, `#3`, ...
 */
async function assignPublicId(moduleId: string, hardwareId: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const publicId = ensurePublicId(hardwareId, null, attempt);
    try {
      await query(
        `UPDATE modules SET public_id = $2, updated_at = now() WHERE id = $1 AND public_id = ''`,
        [moduleId, publicId],
      );
      const row = await one<{ public_id: string }>('SELECT public_id FROM modules WHERE id = $1', [moduleId]);
      if (row?.public_id) return row.public_id;
    } catch (error) {
      if (!isPublicIdCollision(error)) throw error;
    }
  }
  throw badRequest('public_id_generation_failed');
}

/**
 * Backfill при старте Hub: заполняет public_id у старых модулей.
 * JS-цикл, а не SQL, потому что FNV-1a считается в приложении; коллизии
 * разрешаются солью через unique-индекс.
 */
export async function backfillPublicIds(): Promise<void> {
  const rows = await query<{ id: string; hardware_id: string; board_uuid: string }>(
    `SELECT id, hardware_id, board_uuid FROM modules WHERE public_id = ''`,
  );
  let updated = 0;
  for (const row of rows) {
    const hardwareId = (row.hardware_id || row.board_uuid || '').toLowerCase();
    if (!hardwareId) continue;
    try {
      await assignPublicId(row.id, hardwareId);
      updated += 1;
    } catch (error) {
      log('error', 'module_public_id_backfill_failed', {
        moduleId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (rows.length) log('info', 'module_public_id_backfill', { total: rows.length, updated });
}

interface ModuleRecord {
  id: string;
  owner_id: string;
  board_uuid: string;
  hardware_id: string;
  public_id: string;
  role: string;
  transport: string;
  kind: string;
  module_type: string;
  is_public: boolean;
  firmware: string;
  name: string | null;
  board: string | null;
  firmware_config: unknown;
  battery: number;
  gateway: boolean;
  neighbors: number;
  status: string;
  attached: boolean;
  attached_at: string | null;
  rssi: number;
  uptime: number;
  blocked: boolean;
  block_reason: string;
  last_ip: string;
  last_seen_at: string | null;
  last_claim_at: string | null;
  created_at: string;
  token_version: number;
  cluster_id: string;
  border: boolean;
  transports: string[];
  last_neighbors: unknown;
  ble_mac: string;
}

/** Реальный online: свежесть check-in + для wearable факт подключения к клиенту. */
function computeOnline(m: ModuleRecord): boolean {
  const lastSeen = m.last_seen_at ? new Date(m.last_seen_at).getTime() : 0;
  if (!lastSeen || !Number.isFinite(lastSeen)) return false;
  const age = Date.now() - lastSeen;
  if (m.role === 'wearable') {
    return Boolean(m.attached) && (m.transport === 'ble' || m.transport === 'usb') && age <= 90_000;
  }
  return age <= 150_000;
}

/** Единый вид модуля для клиента: camelCase + старые snake_case поля. */
function moduleView(m: ModuleRecord, blockedHashes?: Set<string>) {
  const hardwareId = (m.hardware_id || m.board_uuid || '').toLowerCase();
  const blocked =
    Boolean(m.blocked) ||
    (blockedHashes ? blockedHashes.has(sha256(hardwareId)) || blockedHashes.has(hardwareId) : false);
  const online = !blocked && computeOnline(m);
  return {
    id: m.id,
    boardUuid: m.board_uuid,
    hardwareId,
    meshAddr: hardwareId.replace(/^esp32-/, ''),
    bleMac: m.ble_mac || '',
    publicId: m.public_id || '',
    role: m.role,
    kind: m.kind,
    transport: m.transport,
    attached: Boolean(m.attached),
    online,
    status: blocked ? 'blocked' : online ? 'online' : 'offline',
    firmware: m.firmware,
    name: m.name || '',
    board: m.board || '',
    hasFirmwareConfig: Boolean(m.firmware_config),
    battery: Number(m.battery ?? 0),
    rssi: Number(m.rssi ?? 0),
    uptime: Number(m.uptime ?? 0),
    gateway: Boolean(m.gateway),
    neighbors: Number(m.neighbors ?? 0),
    attachedAt: m.attached_at,
    lastSeenAt: m.last_seen_at,
    lastClaimAt: m.last_claim_at,
    createdAt: m.created_at,
    clusterId: m.cluster_id || '',
    border: Boolean(m.border),
    transports: Array.isArray(m.transports) ? m.transports : [],
    neighborsList: Array.isArray(m.last_neighbors) ? m.last_neighbors : [],
    blocked,
    blockReason: m.block_reason || '',
    shadow: false,
    // Совместимость со старым UI.
    board_uuid: m.board_uuid,
    last_seen_at: m.last_seen_at,
    created_at: m.created_at,
  };
}

interface ShadowRecord {
  id: string;
  module_id: string;
  public_id: string;
  hardware_id: string;
  role: string;
  created_at: string;
}

/** «Тень»: модуль был привязан на другом устройстве. Новый аккаунт не раскрываем. */
function shadowView(s: ShadowRecord) {
  return {
    id: s.id,
    moduleId: s.module_id,
    hardwareId: (s.hardware_id || '').toLowerCase(),
    publicId: s.public_id || '',
    role: s.role,
    shadow: true,
    shadowId: s.id,
    status: 'detached',
    detachedToOther: true,
    message: 'Был привязан на другом устройстве',
    online: false,
    attached: false,
    blocked: false,
    createdAt: s.created_at,
    // Совместимость со старым UI.
    board_uuid: (s.hardware_id || '').toLowerCase(),
    last_seen_at: null,
    created_at: s.created_at,
  };
}

/** Создаёт «тень» прежнего владельца при перепривязке (без дублей). */
async function createShadow(
  moduleId: string,
  oldOwnerId: string,
  newOwnerId: string,
  hardwareId: string,
  publicId: string,
  role: string,
): Promise<void> {
  const existing = await one(
    `SELECT 1 FROM module_shadows
      WHERE module_id = $1 AND old_owner_id = $2 AND dismissed = false LIMIT 1`,
    [moduleId, oldOwnerId],
  );
  if (existing) return;
  await query(
    `INSERT INTO module_shadows (module_id, old_owner_id, new_owner_id, public_id, hardware_id, role)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [moduleId, oldOwnerId, newOwnerId, publicId, hardwareId, role],
  );
}

/** Модуль снова вернулся к прежнему владельцу — старую тень скрываем. */
async function dismissShadowsFor(moduleId: string, ownerId: string): Promise<void> {
  await query(
    `UPDATE module_shadows SET dismissed = true
      WHERE module_id = $1 AND old_owner_id = $2 AND dismissed = false`,
    [moduleId, ownerId],
  );
}

/* --------------------------------------------------- перенос модулей ---- */

interface TransferModuleRef {
  id: string;
  owner_id: string;
  public_id?: string | null;
  hardware_id?: string | null;
  board_uuid?: string | null;
  role?: string | null;
}

interface EnsureTransferInput {
  moduleId: string;
  fromOwnerId: string;
  toOwnerId: string;
  requestedBy: string;
  hardwareId: string;
  publicId: string;
}

/**
 * Возвращает существующую pending-заявку или создаёт новую.
 * Partial unique index не даёт создать вторую активную заявку на модуль.
 */
async function ensurePendingTransfer(
  input: EnsureTransferInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM module_transfers WHERE module_id = $1 AND status = 'pending' LIMIT 1`,
    [input.moduleId],
  );
  if (existing) return { id: existing.id, created: false };

  try {
    const row = await one<{ id: string }>(
      `INSERT INTO module_transfers
         (module_id, from_owner_id, to_owner_id, hardware_id, public_id, status, requested_by)
       VALUES ($1,$2,$3,$4,$5,'pending',$6)
       RETURNING id`,
      [
        input.moduleId,
        input.fromOwnerId,
        input.toOwnerId,
        input.hardwareId,
        input.publicId,
        input.requestedBy,
      ],
    );
    return { id: row!.id, created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const again = await one<{ id: string }>(
        `SELECT id FROM module_transfers WHERE module_id = $1 AND status = 'pending' LIMIT 1`,
        [input.moduleId],
      );
      if (again) return { id: again.id, created: false };
    }
    throw error;
  }
}

/**
 * Если модуль принадлежит другому реальному пользователю (не system),
 * создаёт заявку на перенос и уведомляет владельца. Возвращает данные
 * для ответа pendingTransfer либо null, если перепривязка допустима.
 */
async function requestTransferIfForeign(
  module: TransferModuleRef,
  me: string,
): Promise<{ transferId: string; ownerUsername: string; moduleId: string } | null> {
  if (!module.owner_id || module.owner_id === me) return null;
  const systemId = await systemOwnerId();
  if (!systemId || module.owner_id === systemId) return null;

  const owner = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [
    module.owner_id,
  ]);
  if (!owner?.username) return null;

  const hardwareId = (module.hardware_id || module.board_uuid || '').toLowerCase();
  const publicId = module.public_id || '';
  const transfer = await ensurePendingTransfer({
    moduleId: module.id,
    fromOwnerId: module.owner_id,
    toOwnerId: me,
    requestedBy: me,
    hardwareId,
    publicId,
  });

  if (transfer.created) {
    const requester = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [me]);
    const label = publicId ? `модуля ${publicId}` : 'модуля';
    await enqueueNotification(module.owner_id, {
      kind: 'system',
      title: 'Запрос на перенос модуля',
      body: `@${requester?.username ?? 'Пользователь'} запрашивает перенос ${label}.`,
      data: {
        type: 'module_transfer',
        transferId: transfer.id,
        moduleId: module.id,
        direction: 'incoming',
      },
    }).catch(() => undefined);
    publish(module.owner_id, {
      type: 'module_transfer',
      transferId: transfer.id,
      moduleId: module.id,
      status: 'pending',
      direction: 'incoming',
    });
    log('info', 'module_transfer_requested', {
      transferId: transfer.id,
      moduleId: module.id,
      from: module.owner_id,
      to: me,
    });
  }

  return { transferId: transfer.id, ownerUsername: owner.username, moduleId: module.id };
}

interface TransferQueryRow {
  id: string;
  module_id: string;
  from_owner_id: string;
  to_owner_id: string;
  hardware_id: string;
  public_id: string;
  status: string;
  requested_by: string;
  created_at: string;
  resolved_at: string | null;
  expires_at: string;
  module_name: string | null;
  module_role: string | null;
  from_username: string;
  to_username: string;
}

const TRANSFER_COLUMNS = `t.id, t.module_id, t.from_owner_id, t.to_owner_id, t.hardware_id, t.public_id,
  t.status, t.requested_by, t.created_at, t.resolved_at, t.expires_at,
  m.name AS module_name, m.role AS module_role,
  fu.username AS from_username, tu.username AS to_username`;

/** Единый вид заявки для клиента. */
function transferView(t: TransferQueryRow, me: string) {
  const direction = t.to_owner_id === me ? 'incoming' : 'outgoing';
  const ownerUsername = direction === 'incoming' ? t.from_username : t.to_username;
  return {
    id: t.id,
    moduleId: t.module_id,
    moduleName: t.module_name || (t.public_id ? `Модуль ${t.public_id}` : 'Модуль'),
    hardwareId: (t.hardware_id || '').toLowerCase(),
    publicId: t.public_id || '',
    role: t.module_role || '',
    status: t.status,
    direction,
    requestedBy: t.requested_by,
    ownerUsername,
    fromOwner: { id: t.from_owner_id, username: t.from_username },
    toOwner: { id: t.to_owner_id, username: t.to_username },
    createdAt: t.created_at,
    resolvedAt: t.resolved_at,
    expiresAt: t.expires_at,
  };
}

const MODULE_COLUMNS = `m.id, m.owner_id, m.board_uuid, m.hardware_id, m.public_id, m.role, m.transport, m.kind,
  m.module_type, m.is_public, m.firmware, m.name, m.board, m.firmware_config, m.battery, m.gateway, m.neighbors, m.status,
  m.attached, m.attached_at, m.rssi, m.uptime, m.blocked, m.block_reason,
  m.last_ip, m.last_seen_at, m.last_claim_at, m.created_at, m.token_version,
  m.cluster_id, m.border, m.transports, m.last_neighbors, m.ble_mac`;

/** Имя модуля: username владельца + порядковый номер. */
async function assignModuleName(ownerId: string, moduleId: string, force = false): Promise<void> {
  const user = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [ownerId]);
  if (!user?.username) return;
  const current = await one<{ name: string | null }>('SELECT name FROM modules WHERE id = $1', [moduleId]);
  if (current?.name && !force) return;
  const count = await one<{ c: number }>(
    'SELECT count(*)::int AS c FROM modules WHERE owner_id = $1 AND id <> $2',
    [ownerId, moduleId],
  );
  const name = `${user.username} #${(count?.c ?? 0) + 1}`;
  await query('UPDATE modules SET name = $2 WHERE id = $1', [moduleId, name]);
}

async function loadOwnedModule(id: string, ownerId: string): Promise<ModuleRecord> {
  const row = await one<ModuleRecord>(`SELECT ${MODULE_COLUMNS} FROM modules m WHERE m.id = $1`, [id]);
  if (!row) throw notFound('module');
  if (row.owner_id !== ownerId) throw forbidden('not_owner');
  return row;
}

/** Канонический MAC-идентификатор платы: esp32-<12 hex>. */
/** Обратный порядок байт MAC: esp32-<hex> -> esp32-<reversed hex>. */
function reversedHardwareId(value: string): string | null {
  const hex = value.toLowerCase().replace(/^esp32-/, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  const bytes = hex.match(/.{2}/g);
  return bytes ? `esp32-${bytes.reverse().join('')}` : null;
}

/**
 * Сливает исторический дубль с перевёрнутым MAC в каноническую запись.
 * Раньше прошивка форматировала eFuse MAC в обратном порядке, из-за чего
 * один физический модуль попадал в БД дважды (esp32-ab.. и esp32-..ba).
 */
async function mergeReversedModule(canonical: string): Promise<void> {
  const reversed = reversedHardwareId(canonical);
  if (!reversed || reversed === canonical) return;
  try {
    const exact = await one<{ id: string }>(
      'SELECT id FROM modules WHERE lower(hardware_id) = $1 LIMIT 1',
      [canonical],
    );
    const legacy = await one<{ id: string }>(
      'SELECT id FROM modules WHERE lower(hardware_id) = $1 LIMIT 1',
      [reversed],
    );
    if (!legacy) return;
    const system = await one<{ id: string }>("SELECT id FROM users WHERE username = 'system_modules' LIMIT 1");
    if (!exact) {
      await query(
        `UPDATE modules SET hardware_id = $2, board_uuid = $2, mesh_addr = $2,
                updated_at = now() WHERE id = $1`,
        [legacy.id, canonical],
      );
      log('info', 'module_mac_canonicalized', { id: legacy.id, from: reversed, to: canonical });
      return;
    }
    // Обе записи существуют: переносим владельца/имя/токен и удаляем старую.
    // Сначала освобождаем BLE-алиас, иначе unique index не даст обновить target.
    await query("UPDATE modules SET ble_mac = '' WHERE id = $1", [legacy.id]);
    await query(
      `UPDATE modules t SET
         owner_id = CASE WHEN t.owner_id = $3 THEN s.owner_id ELSE t.owner_id END,
         name = COALESCE(NULLIF(t.name, ''), s.name),
         ble_mac = CASE WHEN t.ble_mac <> '' THEN t.ble_mac ELSE s.ble_mac END,
         token_version = GREATEST(t.token_version, s.token_version),
         last_seen_at = GREATEST(COALESCE(t.last_seen_at, s.last_seen_at), COALESCE(s.last_seen_at, t.last_seen_at)),
         updated_at = now()
       FROM modules s
       WHERE t.id = $1 AND s.id = $2`,
      [exact.id, legacy.id, system?.id ?? ''],
    );
    await query('DELETE FROM modules WHERE id = $1', [legacy.id]);
    log('info', 'module_duplicate_merged', { kept: exact.id, removed: legacy.id, from: reversed, to: canonical });
  } catch (error) {
    log('warn', 'module_duplicate_merge_failed', {
      canonical,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function canonicalHardwareId(value: string): string | null {
  const raw = value.trim().toLowerCase();
  const hex = raw.replace(/^esp32-/, '').replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return `esp32-${hex}`;
}

/** BLE MAC как алиас: aa:bb:cc:dd:ee:ff (или через дефис). */
function normalizeBleMac(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/-/g, ':') : '';
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(raw) ? raw : '';
}

function hardwareIdOrThrow(value: string, field = 'hardwareId'): string {
  const canonical = canonicalHardwareId(value);
  if (canonical) return canonical;
  // Идентичность — только заводской MAC. UUID/публичные ID/имена запрещены:
  // иначе один модуль создаёт новую запись при каждом pairing.
  throw badRequest(`${field}_invalid`);
}

function signModuleToken(moduleId: string, publicId: string, tokenVersion = 0): string {
  const now = Math.floor(Date.now() / 1000);
  return signToken(
    {
      sub: moduleId,
      pid: publicId,
      tv: Number(tokenVersion) || 0,
      type: 'module',
      iat: now,
      exp: now + 365 * 24 * 3600,
    },
    config.jwtSecret,
  );
}

export function requireModule() {
  return async (req: FastifyRequest): Promise<void> => {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized('module_token_required');
    const claims = verifyToken(token, config.jwtSecret);
    if (!claims || claims.type !== 'module') throw unauthorized('invalid_module_token');
    const row = await one<{
      owner_id: string;
      module_type: string;
      is_public: boolean;
      hardware_id: string;
      board_uuid: string;
      public_id: string;
      role: string;
      transport: string;
      attached: boolean;
      blocked: boolean;
      token_version: number;
    }>(
      `SELECT owner_id, module_type, is_public, hardware_id, board_uuid, public_id, role, transport, attached, blocked, token_version
         FROM modules WHERE id = $1`,
      [claims.sub],
    );
    if (!row) throw unauthorized('module_not_found');
    const tokenVersion = Number((claims as { tv?: unknown }).tv ?? 0) || 0;
    if (tokenVersion !== Number(row.token_version ?? 0)) {
      throw unauthorized('module_token_stale');
    }
    const hardwareId = (row.hardware_id || row.board_uuid || '').toLowerCase();
    if (row.blocked || (await isHardwareBlocked(hardwareId))) {
      throw new ApiError(403, 'module_blocked', 'module_blocked');
    }
    req.module = {
      moduleId: String(claims.sub),
      ownerId: row.owner_id,
      moduleType: row.module_type,
      isPublic: row.is_public,
      hardwareId,
      publicId: row.public_id || '',
      role: row.role,
      transport: row.transport,
      attached: Boolean(row.attached),
    };
  };
}

/* ------------------------------------------------------------ OTA jobs ---- */

function otaJobDto(row: {
  id: string;
  status: string;
  progress: number;
  error: string | null;
  version: string | null;
  app_size_bytes: number | null;
  app_sha256: string | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: row.id,
    status: row.status,
    progress: Number(row.progress ?? 0),
    error: row.error,
    version: row.version ?? '',
    sizeBytes: Number(row.app_size_bytes ?? 0),
    sha256: row.app_sha256 ?? '',
    url: `/v1/modules/ota/firmware/${row.id}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Актуальное OTA-задание модуля (для check-in и отдельного поллинга). */
async function activeOtaJob(moduleId: string) {
  const row = await one<{
    id: string;
    status: string;
    progress: number;
    error: string | null;
    version: string | null;
    app_size_bytes: number | null;
    app_sha256: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT j.id, j.status, j.progress, j.error, b.version,
            b.app_size_bytes, b.app_sha256, j.created_at, j.updated_at
       FROM module_ota_jobs j
       JOIN firmware_builds b ON b.id = j.build_id
      WHERE j.module_id = $1 AND j.status IN ('pending','downloading','installing')
      ORDER BY j.created_at DESC LIMIT 1`,
    [moduleId],
  );
  return row ? otaJobDto(row) : null;
}

interface RelayEnvelopeItem {
  chatId?: string;
  packetId?: string;
  envelope?: unknown;
  /** Base64 от JSON-конверта: устойчиво к кавычкам/юникоду на прошивке. */
  envelopeB64?: string;
}

interface MessageEnvelopeFields {
  objectId?: unknown;
  nonce?: unknown;
  header?: unknown;
  kind?: unknown;
  replyTo?: unknown;
  clientId?: unknown;
  asChannel?: unknown;
}

/**
 * Пытается сохранить mesh-конверт как обычное сообщение Hub.
 * Возвращает true, если сообщение сохранено (или уже было — идемпотентность
 * по client_id/packetId). Если конверт не содержит метаданных объекта,
 * возвращает false: строка остаётся в mesh_inbox в статусе queued.
 */
async function persistRelayMessage(
  ownerId: string,
  moduleId: string,
  chatId: string,
  packetId: string,
  envelope: Record<string, unknown>,
): Promise<boolean> {
  const env = envelope as MessageEnvelopeFields;
  let objectId = String(env.objectId ?? '');
  const initialHeader: Record<string, unknown> =
    env.header && typeof env.header === 'object' && !Array.isArray(env.header)
      ? { ...(env.header as Record<string, unknown>) }
      : {};
  // nonce может лежать как в самом конверте, так и в header.
  const nonce = String(env.nonce ?? initialHeader.nonce ?? '');
  if (!nonce) return false;

  let obj = UUID_RE.test(objectId)
    ? await one<{ id: string; owner_id: string }>(
        `SELECT id, owner_id FROM objects WHERE id = $1 AND state = 'active'`,
        [objectId],
      )
    : null;

  // Офлайн-сообщение из mesh: объекта ещё нет (upload не удался), но есть
  // ciphertext в envelopeB64. Сохраняем его на сервере от имени владельца.
  const inline = typeof (env as { envelopeB64?: unknown }).envelopeB64 === 'string'
    ? String((env as { envelopeB64?: string }).envelopeB64)
    : '';
  if ((!obj || obj.owner_id !== ownerId) && inline) {
    try {
      const normalized = inline.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Buffer.from(normalized, 'base64');
      if (bytes.length) {
        const stored = await storeEncrypted(ownerId, Readable.from(bytes), 8 * 1024 * 1024, config.replicas);
        objectId = stored.objectId;
        obj = { id: stored.objectId, owner_id: ownerId };
      }
    } catch {
      /* ниже вернём false */
    }
  }
  if (!obj || obj.owner_id !== ownerId || !UUID_RE.test(objectId)) return false;

  const clientId = String(env.clientId ?? packetId ?? '').slice(0, 128);
  if (clientId) {
    const found = await one('SELECT 1 FROM messages WHERE chat_id = $1 AND client_id = $2', [chatId, clientId]);
    if (found) return true;
  }

  const headerObj: Record<string, unknown> = initialHeader;
  if (typeof headerObj.nonce !== 'string' || !headerObj.nonce) headerObj.nonce = nonce;
  headerObj.relayed = true;
  if (packetId) headerObj.meshPacketId = packetId;

  const kind = typeof env.kind === 'string' && env.kind.length > 0 && env.kind.length <= 24 ? env.kind : 'text';
  const members = await query<{ user_id: string }>('SELECT user_id FROM chat_members WHERE chat_id = $1', [chatId]);
  if (!members.length) return false;

  for (const m of members) {
    await query('INSERT INTO object_grants (object_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      objectId,
      m.user_id,
    ]);
  }

  const id = uuid();
  const replyTo = typeof env.replyTo === 'string' && UUID_RE.test(env.replyTo) ? env.replyTo : null;
  const asChannel = env.asChannel === true;
  const sender = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [ownerId]);
  const row = await one<{ seq: number; created_at: string }>(
    `INSERT INTO messages (id, chat_id, sender_user_id, sender_device_id, kind, header, object_id, reply_to, client_id, as_channel)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,NULLIF($8,''),$9) RETURNING seq, created_at`,
    [id, chatId, ownerId, kind, JSON.stringify(headerObj), objectId, replyTo, clientId, asChannel],
  );
  if (!row) return false;

  await query('UPDATE chats SET last_seq = GREATEST(last_seq, $2), updated_at = now() WHERE id = $1', [
    chatId,
    row.seq,
  ]);

  const message = {
    id,
    seq: row.seq,
    chatId,
    kind,
    objectId,
    nonce,
    header: headerObj,
    replyTo,
    asChannel,
    senderUserId: ownerId,
    senderUsername: sender?.username ?? '',
    senderDeviceId: null,
    createdAt: row.created_at,
    clientId: clientId || null,
    relayed: true,
    meshModuleId: moduleId,
    meshPacketId: packetId,
  };
  for (const m of members) publish(m.user_id, { type: 'message', chatId, message });
  // Отдельное событие для клиентов, которые не разбирают message из mesh.
  publishMany(members.map((m) => m.user_id), { type: 'chat_updated', chatId, messageId: id });
  return true;
}

/* -------------------------------------------------------------- routes --- */

const moduleRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Привязка носимого модуля по физическому подключению (USB/BLE).
   * Клиент передаёт hardwareId (и, по возможности, publicId). Мягкая
   * перепривязка: прежний владелец получает «тень», запрос не блокируется.
   */
  app.post('/modules/pair', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const systemId = await systemOwnerId();
    rateLimit(`mod:${me}`, 20, 60 * 60 * 1000);
    const body = (req.body ?? {}) as {
      hardwareId?: string;
      boardUuid?: string;
      /** BLE MAC — только алиас для сопоставления с Wi-Fi MAC. */
      bleMac?: string;
      ble_mac?: string;
      publicId?: string | number;
      role?: string;
      transport?: string;
      moduleType?: string; // personal | public | latent
      isPublic?: boolean; // для personal: релеить чужие конверты или нет
      kind?: string; // radio: wifi | lora
      firmware?: string;
      battery?: number;
      board?: string;
      firmwareConfig?: unknown;
    };

    // hardwareId — основной идентификатор, boardUuid — legacy-имя того же поля.
    const hardwareId = hardwareIdOrThrow(str(body.hardwareId ?? body.boardUuid, 'hardwareId', { max: 64 }));
    if (hardwareId.length < 8) throw badRequest('invalid_hardware_id');
    const bleMac = normalizeBleMac(body.bleMac ?? body.ble_mac);
    // Сначала сливаем исторический дубль с перевёрнутым MAC, если он есть.
    await mergeReversedModule(hardwareId);

    const computedPublicId = publicIdFromHardware(hardwareId);
    const providedPublicId = body.publicId === undefined || body.publicId === null
      ? ''
      : String(body.publicId).trim();
    // Переданный public_id должен совпадать с вычисленным (или с уже сохранённым).
    if (providedPublicId && !isPublicId(providedPublicId)) throw badRequest('public_id_mismatch');

    if (await isHardwareBlocked(hardwareId)) {
      throw new ApiError(403, 'hardware_blocked', 'hardware_blocked');
    }

    const existing = await one<{
      id: string;
      owner_id: string;
      blocked: boolean;
      public_id: string;
      role: string;
      transport: string;
      token_version: number;
    }>(
      `SELECT id, owner_id, blocked, public_id, role, transport, token_version FROM modules
        WHERE lower(hardware_id) = $1 OR lower(board_uuid) = $1
           OR ($2 <> '' AND lower(ble_mac) = $2)
           OR ($3 <> '' AND public_id = $3)
        ORDER BY (lower(hardware_id) = $1) DESC, (lower(board_uuid) = $1) DESC,
                 (public_id = $3) DESC LIMIT 1`,
      [hardwareId, bleMac, providedPublicId],
    );
    if (existing?.blocked) throw new ApiError(403, 'hardware_blocked', 'hardware_blocked');

    if (
      providedPublicId &&
      providedPublicId !== computedPublicId &&
      providedPublicId !== (existing?.public_id ?? '')
    ) {
      throw badRequest('public_id_mismatch');
    }

    // Чужой реальный модуль не перепривязываем сразу: создаём заявку.
    if (existing) {
      const pending = await requestTransferIfForeign(
        { ...existing, hardware_id: hardwareId, board_uuid: hardwareId },
        me,
      );
      if (pending) {
        return reply.code(202).send({
          ok: false,
          pendingTransfer: true,
          transferId: pending.transferId,
          ownerUsername: pending.ownerUsername,
          moduleId: pending.moduleId,
        });
      }
    }

    const role = asRole(body.role, asRole(existing?.role, 'wearable'));
    const kind = body.kind === 'lora' ? 'lora' : 'wifi';
    const transport = asTransport(
      body.transport,
      asTransport(existing?.transport, defaultTransport(role, kind)),
    );
    const moduleType = ['personal', 'public', 'latent'].includes(String(body.moduleType ?? ''))
      ? String(body.moduleType)
      : 'personal';
    const isPublic = moduleType === 'public' ? true : Boolean(body.isPublic ?? false);
    // Физическое подключение: носимый модуль сразу attached (BLE/USB).
    const attached = role === 'wearable' ? transport === 'ble' || transport === 'usb' : true;
    const ip = clientIp(req);

    const reassignedFrom = existing && existing.owner_id !== me && existing.owner_id !== systemId ? existing.owner_id : null;
    let moduleId: string;
    let publicId: string;

    if (existing) {
      moduleId = existing.id;
      if (reassignedFrom) {
        await createShadow(
          moduleId,
          reassignedFrom,
          me,
          hardwareId,
          existing.public_id || computedPublicId,
          existing.role,
        );
        publish(reassignedFrom, {
          type: 'module_unbound',
          moduleId,
          hardwareId,
          publicId: existing.public_id || computedPublicId,
          reason: 'reassigned',
        });
      }
      // Если у меня осталась старая shadow-запись на этот модуль — она больше
      // не актуальна: модуль снова мой.
      await dismissShadowsFor(moduleId, me);
      await query(
        `UPDATE modules SET owner_id = $2,
                board_uuid = CASE WHEN hardware_id ~* '^esp32-[0-9a-f]{12}$' THEN hardware_id ELSE $3 END,
                hardware_id = CASE WHEN hardware_id ~* '^esp32-[0-9a-f]{12}$' THEN hardware_id ELSE $3 END,
                mesh_addr = CASE WHEN hardware_id ~* '^esp32-[0-9a-f]{12}$' THEN hardware_id ELSE $3 END,
                ble_mac = CASE WHEN $15 <> '' THEN $15 ELSE ble_mac END,
                role = $4, transport = $5,
                module_type = $6, is_public = $7, kind = $8, firmware = COALESCE(NULLIF($9,''), firmware),
                battery = $10, attached = $11, status = 'online', last_seen_at = now(), last_ip = $12,
                board = COALESCE($13, board),
                firmware_config = COALESCE($14::jsonb, firmware_config),
                detached_to_owner = CASE WHEN owner_id <> $2 THEN owner_id ELSE detached_to_owner END,
                updated_at = now()
          WHERE id = $1`,
        [
          moduleId,
          me,
          hardwareId,
          role,
          transport,
          moduleType,
          isPublic,
          kind,
          body.firmware ?? '',
          Number(body.battery ?? 0),
          attached,
          ip,
          typeof body.board === 'string' ? body.board.slice(0, 32) : null,
          body.firmwareConfig && typeof body.firmwareConfig === 'object' ? JSON.stringify(body.firmwareConfig) : null,
          bleMac,
        ],
      );
      // public_id: сохраняем существующий (даже солёный), иначе вычисляем.
      publicId = existing.public_id || (await assignPublicId(moduleId, hardwareId));
    } else {
      // Вставка с ретраями при коллизии публичного ID.
      let inserted: { id: string } | null = null;
      publicId = computedPublicId;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        // Переданный клиентом ID используем только на первой попытке:
        // при коллизии переходим на соль hardwareId#2, #3, ...
        const candidate = ensurePublicId(
          hardwareId,
          attempt === 0 ? providedPublicId || null : null,
          attempt,
        );
        try {
          inserted = await one<{ id: string }>(
            `INSERT INTO modules
               (owner_id, board_uuid, hardware_id, mesh_addr, ble_mac, public_id, role, transport, module_type, is_public,
                kind, firmware, battery, attached, status, last_seen_at, last_ip, board, firmware_config)
             VALUES ($1,$2,$2,$2,$15,$3,$4,$5,$6,$7,$8,$9,$10,$11,'online',now(),$12,$13,$14::jsonb) RETURNING id`,
            [
              me,
              hardwareId,
              candidate,
              role,
              transport,
              moduleType,
              isPublic,
              kind,
              body.firmware ?? '',
              Number(body.battery ?? 0),
              attached,
              ip,
              typeof body.board === 'string' ? body.board.slice(0, 32) : null,
              body.firmwareConfig && typeof body.firmwareConfig === 'object' ? JSON.stringify(body.firmwareConfig) : null,
              bleMac,
            ],
          );
          publicId = candidate;
          break;
        } catch (error) {
          if (!isPublicIdCollision(error)) throw error;
        }
      }
      if (!inserted) throw badRequest('public_id_generation_failed');
      moduleId = inserted.id;
    }

    if (reassignedFrom) {
      log('info', 'module_reassigned', { moduleId, from: reassignedFrom, to: me, hardwareId, publicId, role, transport });
    }
    await assignModuleName(me, moduleId, Boolean(reassignedFrom)).catch(() => undefined);

    const moduleToken = signModuleToken(moduleId, publicId, existing?.token_version ?? 0);
    log('info', 'module_paired', { moduleId, owner: me, hardwareId, publicId, role, transport, kind });

    return reply.send({
      id: moduleId,
      boardUuid: hardwareId,
      hardwareId,
      publicId,
      role,
      transport,
      moduleType,
      isPublic,
      kind,
      online: true,
      attached,
      moduleToken,
      checkinIntervalSec: 60,
      // Совместимость.
      board_uuid: hardwareId,
    });
  });

  /**
   * Привязка ретранслятора/шлюза по 8-значному публичному ID.
   * Online не требуется: подтверждения по ID достаточно. Если модуль уже
   * привязан к другому аккаунту — мягкая перепривязка + «тень» прежнему.
   */
  app.post('/modules/claim', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    rateLimit(`mod-claim:${me}`, 30, 60 * 60 * 1000);
    const body = (req.body ?? {}) as { publicId?: string | number };
    const publicId = String(body.publicId ?? '').trim();
    if (!isPublicId(publicId)) throw badRequest('invalid_public_id');

    const row = await one<ModuleRecord>(
      `SELECT ${MODULE_COLUMNS} FROM modules m WHERE m.public_id = $1`,
      [publicId],
    );
    if (!row) {
      // Клиент опрашивает повторно: модуль мог ещё не прислать check-in.
      throw new ApiError(404, 'module_not_found', 'module_not_found');
    }
    const hardwareId = (row.hardware_id || row.board_uuid || '').toLowerCase();
    if (row.blocked || (await isHardwareBlocked(hardwareId))) {
      throw new ApiError(403, 'module_blocked', 'module_blocked');
    }

    // Модуль принадлежит другому пользователю — не отбираем, а просим перенос.
    const pending = await requestTransferIfForeign(row, me);
    if (pending) {
      return reply.send({
        ok: false,
        pendingTransfer: true,
        transferId: pending.transferId,
        ownerUsername: pending.ownerUsername,
        moduleId: pending.moduleId,
      });
    }

    const ip = clientIp(req);
    const systemId = await systemOwnerId();
    const reassignedFrom = row.owner_id !== me && row.owner_id !== systemId ? row.owner_id : null;
    if (reassignedFrom) {
      await createShadow(row.id, reassignedFrom, me, hardwareId, publicId, row.role);
      publish(reassignedFrom, {
        type: 'module_unbound',
        moduleId: row.id,
        hardwareId,
        publicId,
        reason: 'reclaimed',
      });
      await query(
        `UPDATE modules SET owner_id = $2, last_claim_at = now(), last_ip = $3,
                detached_to_owner = owner_id, updated_at = now()
          WHERE id = $1`,
        [row.id, me, ip],
      );
      log('warn', 'module_reclaimed', { moduleId: row.id, from: reassignedFrom, to: me, publicId, hardwareId });
    } else {
      await dismissShadowsFor(row.id, me);
      await query('UPDATE modules SET last_claim_at = now(), last_ip = $2, updated_at = now() WHERE id = $1', [
        row.id,
        ip,
      ]);
    }
    // Повторный возврат модуля: старая shadow-запись у нового владельца
    // становится неактуальной.
    await dismissShadowsFor(row.id, me);
    await assignModuleName(me, row.id, true).catch(() => undefined);

    const fresh = await one<ModuleRecord>(`SELECT ${MODULE_COLUMNS} FROM modules m WHERE m.id = $1`, [row.id]);
    const view = moduleView(fresh ?? row, await activeBlockedHashes());
    log('info', 'module_claimed', { moduleId: row.id, owner: me, publicId, reassigned: Boolean(reassignedFrom) });

    return reply.send({
      ok: true,
      ...view,
      moduleToken: signModuleToken(row.id, publicId, row.token_version),
      reassigned: Boolean(reassignedFrom),
    });
  });

  /* ------------------------------------------- заявки на перенос модуля ---- */

  /** Входящие/исходящие заявки на перенос + недавние закрытые. */
  app.get('/modules/transfers', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const rows = await query<TransferQueryRow>(
      `SELECT ${TRANSFER_COLUMNS}
         FROM module_transfers t
         JOIN modules m ON m.id = t.module_id
         JOIN users fu ON fu.id = t.from_owner_id
         JOIN users tu ON tu.id = t.to_owner_id
        WHERE t.from_owner_id = $1 OR t.to_owner_id = $1
        ORDER BY t.created_at DESC
        LIMIT 100`,
      [me],
    );
    const views = rows.map((row) => transferView(row, me));
    const recent = (direction: 'incoming' | 'outgoing') =>
      views.filter((v) => v.direction === direction && v.status !== 'pending').slice(0, 20);
    return reply.send({
      incoming: views.filter((v) => v.direction === 'incoming' && v.status === 'pending'),
      outgoing: views.filter((v) => v.direction === 'outgoing' && v.status === 'pending'),
      recentIncoming: recent('incoming'),
      recentOutgoing: recent('outgoing'),
    });
  });

  /** Владелец просит перенести свой модуль другому пользователю. */
  app.post('/modules/:id/transfer', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    rateLimit(`mod-transfer:${me}`, 30, 60 * 60 * 1000);
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw notFound('module');

    const body = (req.body ?? {}) as { username?: string; userId?: string };
    const module = await one<TransferModuleRef>(
      'SELECT id, owner_id, public_id, hardware_id, board_uuid, role FROM modules WHERE id = $1',
      [id],
    );
    if (!module) throw notFound('module');
    if (module.owner_id !== me) throw forbidden('not_owner');

    const userId = typeof body.userId === 'string' && UUID_RE.test(body.userId) ? body.userId : '';
    const username =
      typeof body.username === 'string' ? body.username.trim().replace(/^@/, '') : '';
    if (!userId && !username) throw badRequest('target_required');

    const target = userId
      ? await one<{ id: string; username: string }>(
          `SELECT id, username FROM users WHERE id = $1 AND status = 'active'`,
          [userId],
        )
      : await one<{ id: string; username: string }>(
          `SELECT id, username FROM users WHERE lower(username) = lower($1) AND status = 'active' LIMIT 1`,
          [username],
        );
    if (!target) throw notFound('user');
    if (target.id === me) throw badRequest('cannot_transfer_to_self');
    const requester = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [me]);

    const hardwareId = (module.hardware_id || module.board_uuid || '').toLowerCase();
    const transfer = await ensurePendingTransfer({
      moduleId: module.id,
      fromOwnerId: me,
      toOwnerId: target.id,
      requestedBy: me,
      hardwareId,
      publicId: module.public_id || '',
    });

    if (transfer.created) {
      await enqueueNotification(target.id, {
        kind: 'system',
        title: 'Запрос на перенос модуля',
        body: `@${requester?.username ?? 'Пользователь'} хочет передать вам модуль${module.public_id ? ` ${module.public_id}` : ''}.`,
        data: {
          type: 'module_transfer',
          transferId: transfer.id,
          moduleId: module.id,
          direction: 'incoming',
        },
      }).catch(() => undefined);
      publish(target.id, {
        type: 'module_transfer',
        transferId: transfer.id,
        moduleId: module.id,
        status: 'pending',
        direction: 'incoming',
      });
      log('info', 'module_transfer_requested', {
        transferId: transfer.id,
        moduleId: module.id,
        from: me,
        to: target.id,
      });
    }

    return reply.code(transfer.created ? 201 : 200).send({
      ok: true,
      transferId: transfer.id,
      moduleId: module.id,
      status: 'pending',
      to: { id: target.id, username: target.username },
    });
  });

  /** Принять заявку: только целевой пользователь, атомарно меняем владельца. */
  app.post('/modules/transfers/:id/accept', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw notFound('transfer');

    const pre = await one<TransferQueryRow>(
      `SELECT ${TRANSFER_COLUMNS}
         FROM module_transfers t
         JOIN modules m ON m.id = t.module_id
         JOIN users fu ON fu.id = t.from_owner_id
         JOIN users tu ON tu.id = t.to_owner_id
        WHERE t.id = $1`,
      [id],
    );
    if (!pre) throw notFound('transfer');
    if (pre.to_owner_id !== me) throw forbidden('not_target_owner');
    if (pre.status !== 'pending') throw conflict('transfer_not_pending');
    if (new Date(pre.expires_at).getTime() <= Date.now()) {
      await query(
        `UPDATE module_transfers SET status = 'cancelled', resolved_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [id],
      );
      throw conflict('transfer_expired');
    }

    const locked = await tx(async ({ query: q }) => {
      const rows = await q<{
        id: string;
        module_id: string;
        from_owner_id: string;
        to_owner_id: string;
        status: string;
      }>(
        `SELECT id, module_id, from_owner_id, to_owner_id, status
           FROM module_transfers WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const transfer = rows[0];
      if (!transfer || transfer.status !== 'pending') throw conflict('transfer_not_pending');
      if (transfer.to_owner_id !== me) throw forbidden('not_target_owner');

      const mods = await q<{ owner_id: string }>(
        'SELECT owner_id FROM modules WHERE id = $1 FOR UPDATE',
        [transfer.module_id],
      );
      const mod = mods[0];
      if (!mod || mod.owner_id !== transfer.from_owner_id) throw conflict('transfer_stale');

      const user = await q<{ username: string }>('SELECT username FROM users WHERE id = $1', [me]);
      const count = await q<{ c: number }>(
        'SELECT count(*)::int AS c FROM modules WHERE owner_id = $1 AND id <> $2',
        [me, transfer.module_id],
      );
      const name = user[0]?.username
        ? `${user[0].username} #${Number(count[0]?.c ?? 0) + 1}`
        : null;

      await q(
        `UPDATE modules
            SET owner_id = $2, token_version = token_version + 1,
                name = COALESCE($3, name), updated_at = now()
          WHERE id = $1`,
        [transfer.module_id, me, name],
      );
      // Прежние «тени» этого модуля больше не актуальны.
      await q('UPDATE module_shadows SET dismissed = true WHERE module_id = $1 AND dismissed = false', [
        transfer.module_id,
      ]);
      await q(
        `UPDATE module_transfers SET status = 'accepted', resolved_at = now() WHERE id = $1`,
        [id],
      );
      return transfer;
    });

    const hardwareId = (pre.hardware_id || '').toLowerCase();
    publish(locked.from_owner_id, {
      type: 'module_unbound',
      moduleId: locked.module_id,
      hardwareId,
      publicId: pre.public_id,
      reason: 'transferred',
    });
    publish(me, {
      type: 'module_transferred',
      moduleId: locked.module_id,
      hardwareId,
      publicId: pre.public_id,
      fromOwnerId: locked.from_owner_id,
    });
    await enqueueNotification(locked.from_owner_id, {
      kind: 'system',
      title: 'Перенос модуля подтверждён',
      body: `@${pre.to_username || me} принял${pre.public_id ? ` модуль ${pre.public_id}` : ' модуль'}.`,
      data: {
        type: 'module_transfer',
        transferId: id,
        moduleId: locked.module_id,
        status: 'accepted',
        direction: 'outgoing',
      },
    }).catch(() => undefined);
    log('info', 'module_transfer_accepted', {
      transferId: id,
      moduleId: locked.module_id,
      from: locked.from_owner_id,
      to: me,
    });

    return reply.send({ ok: true, transferId: id, moduleId: locked.module_id, status: 'accepted' });
  });

  /** Отклонить заявку: только целевой пользователь. */
  app.post('/modules/transfers/:id/decline', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw notFound('transfer');

    const row = await one<{
      id: string;
      module_id: string;
      from_owner_id: string;
      to_owner_id: string;
      status: string;
    }>(
      `SELECT id, module_id, from_owner_id, to_owner_id, status
         FROM module_transfers WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('transfer');
    if (row.to_owner_id !== me) throw forbidden('not_target_owner');
    if (row.status !== 'pending') throw conflict('transfer_not_pending');

    const meUser = await one<{ username: string }>('SELECT username FROM users WHERE id = $1', [me]);
    await query(
      `UPDATE module_transfers SET status = 'declined', resolved_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [id],
    );
    publish(row.from_owner_id, {
      type: 'module_transfer',
      transferId: id,
      moduleId: row.module_id,
      status: 'declined',
      direction: 'outgoing',
    });
    await enqueueNotification(row.from_owner_id, {
      kind: 'system',
      title: 'Заявка на перенос отклонена',
      body: `@${meUser?.username ?? 'Пользователь'} отклонил заявку на перенос модуля.`,
      data: {
        type: 'module_transfer',
        transferId: id,
        moduleId: row.module_id,
        status: 'declined',
        direction: 'outgoing',
      },
    }).catch(() => undefined);
    log('info', 'module_transfer_declined', { transferId: id, moduleId: row.module_id, by: me });
    return reply.send({ ok: true, transferId: id, status: 'declined' });
  });

  /** Отменить заявку: только прежний владелец модуля. */
  app.post('/modules/transfers/:id/cancel', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) throw notFound('transfer');

    const row = await one<{
      id: string;
      module_id: string;
      from_owner_id: string;
      to_owner_id: string;
      status: string;
    }>(
      `SELECT id, module_id, from_owner_id, to_owner_id, status
         FROM module_transfers WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('transfer');
    if (row.from_owner_id !== me) throw forbidden('not_owner');
    if (row.status !== 'pending') throw conflict('transfer_not_pending');

    await query(
      `UPDATE module_transfers SET status = 'cancelled', resolved_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [id],
    );
    publish(row.to_owner_id, {
      type: 'module_transfer',
      transferId: id,
      moduleId: row.module_id,
      status: 'cancelled',
      direction: 'incoming',
    });
    log('info', 'module_transfer_cancelled', { transferId: id, moduleId: row.module_id, by: me });
    return reply.send({ ok: true, transferId: id, status: 'cancelled' });
  });

  /**
   * Регистрация/ heartbeat модуля без пользовательского токена.
   * Нужна шлюзу: он выходит в интернет и представляется hardwareId/publicId
   * до того, как пользователь добавил его в аккаунт. Новый модуль попадает
   * к системному владельцу и позже перепривязывается через claim/pair.
   */
  /**
   * Зашифрованный API-туннель через шлюз.
   *
   * Клиент шифрует запрос ключом устройства (deriveMeshRelayKey), шлюз видит
   * только base64-блоб. Hub расшифровывает, выполняет запрос к своему же API
   * от имени пользователя и возвращает зашифрованный ответ.
   */
  app.post('/modules/http', { onRequest: [requireModule()] }, async (req, reply) => {
    const body = (req.body ?? {}) as { userId?: string; deviceId?: string; blob?: string };
    if (!body.userId || !body.deviceId || !body.blob) throw badRequest('relay_payload_required');
    if (body.blob.length > 48_000) throw badRequest('relay_too_large');

    const key = Buffer.from(deriveMeshRelayKey(body.userId, body.deviceId), 'base64');
    let request: {
      v?: number;
      id?: string;
      ts?: number;
      method?: string;
      path?: string;
      body?: unknown;
    };
    try {
      const raw = JSON.parse(Buffer.from(body.blob, 'base64').toString('utf8')) as {
        nonce: string; ciphertext: string;
      };
      const full = Buffer.from(raw.ciphertext, 'base64');
      if (full.length < 17) throw new Error('short');
      const ct = full.subarray(0, full.length - 16);
      const tag = full.subarray(full.length - 16);
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(raw.nonce, 'base64'));
      d.setAuthTag(tag);
      const text = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
      request = JSON.parse(text);
    } catch {
      throw new ApiError(400, 'relay_decrypt_failed', 'relay_decrypt_failed');
    }

    if (!request || request.v !== 1 || typeof request.path !== 'string') throw badRequest('relay_invalid');
    if (request.ts && Math.abs(Date.now() - Number(request.ts)) > 120_000) throw forbidden('relay_expired');
    const method = String(request.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw badRequest('method_invalid');
    // Только небольшой прикладной API. Никаких auth/admin/upload.
    if (!/^\/v1\/(me|chats|users|modules|notifications|channels|groups|search|firmware)(\/|\?|$)/.test(request.path)) {
      throw forbidden('relay_path_forbidden');
    }
    if (request.path.startsWith('/v1/admin') || request.path.startsWith('/v1/auth') || request.path.startsWith('/v1/objects')) {
      throw forbidden('relay_path_forbidden');
    }

    const now = Math.floor(Date.now() / 1000);
    const token = signToken(
      { sub: body.userId, did: body.deviceId, type: 'access', iat: now, exp: now + 120 },
      config.jwtSecret,
    );
    let upstream: Response;
    try {
      upstream = await fetch(`http://127.0.0.1:${config.port}${request.path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(request.body ?? {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiError(502, 'relay_upstream_failed', 'relay_upstream_failed');
    }

    const text = await upstream.text();
    if (text.length > 60_000) throw new ApiError(413, 'relay_response_too_large', 'relay_response_too_large');
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text.slice(0, 2000); }

    const payload = JSON.stringify({ status: upstream.status, body: parsed, id: request.id ?? '' });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    const blob = Buffer.from(JSON.stringify({
      nonce: iv.toString('base64'),
      ciphertext: ct.toString('base64'),
    }), 'utf8').toString('base64');

    return reply.send({ ok: true, blob });
  });

  app.post('/modules/register', async (req, reply) => {
    const ip = clientIp(req);
    rateLimit(`modreg:${ip}`, 120, 60 * 60 * 1000);
    const body = (req.body ?? {}) as {
      hardwareId?: string;
      bleMac?: string;
      ble_mac?: string;
      publicId?: string | number;
      role?: string;
      transport?: string;
      kind?: string;
      firmware?: string;
      battery?: number;
      attached?: boolean;
      gateway?: boolean;
      neighbors?: {
        publicId?: string;
        hardwareId?: string;
        role?: string;
        clusterId?: string | number;
        neighbors?: number;
        battery?: number;
        rssi?: number;
      }[];
      claimToken?: string;
      rssi?: number;
      uptime?: number;
      cluster_id?: string | number;
      clusterId?: string | number;
      border?: boolean | number;
      wifi?: boolean | number;
      lora?: boolean | number;
      pins?: Record<string, unknown>;
    };

    const hardwareId = hardwareIdOrThrow(str(body.hardwareId, 'hardwareId', { max: 64 }));
    if (hardwareId.length < 8) throw badRequest('invalid_hardware_id');
    const bleMac = normalizeBleMac(body.bleMac ?? body.ble_mac);
    // Сначала сливаем исторический дубль с перевёрнутым MAC, если он есть.
    await mergeReversedModule(hardwareId);
    const computed = publicIdFromHardware(hardwareId);
    const provided = body.publicId === undefined || body.publicId === null ? '' : String(body.publicId).trim();
    if (provided && !isPublicId(provided)) throw badRequest('public_id_mismatch');

    if (await isHardwareBlocked(hardwareId)) {
      throw new ApiError(403, 'hardware_blocked', 'hardware_blocked');
    }

    const system = await one<{ id: string }>(
      `SELECT id FROM users WHERE username = 'system_modules' LIMIT 1`,
    );
    if (!system) throw new ApiError(503, 'system_owner_missing', 'system_owner_missing');

    // Прошивка, собранная пользователем, содержит одноразовый claim-токен:
    // после перепрошивки модуль сам возвращается в его аккаунт.
    let claimOwner: string | null = null;
    if (typeof body.claimToken === 'string' && body.claimToken.length > 20) {
      const claims = verifyToken(body.claimToken, config.jwtSecret);
      if (claims?.type === 'claim' && typeof claims.sub === 'string') {
        const owner = await one('SELECT 1 FROM users WHERE id = $1 AND status = $2', [claims.sub, 'active']);
        if (owner) claimOwner = claims.sub;
      }
    }

    let existing = await one<{
      id: string;
      owner_id: string;
      blocked: boolean;
      public_id: string;
      role: string;
      transport: string;
      token_version: number;
      cluster_id?: string;
    }>(
      `SELECT id, owner_id, blocked, public_id, role, transport, token_version, cluster_id FROM modules
        WHERE lower(hardware_id) = $1 OR lower(board_uuid) = $1
           OR ($2 <> '' AND lower(ble_mac) = $2)
           OR ($3 <> '' AND public_id = $3)
        ORDER BY (lower(hardware_id) = $1) DESC, (lower(board_uuid) = $1) DESC,
                 (public_id = $3) DESC LIMIT 1`,
      [hardwareId, bleMac, provided],
    );
    if (existing?.blocked) throw new ApiError(403, 'hardware_blocked', 'hardware_blocked');

    // Claim/adopt-путь: если модуль принадлежит другому реальному пользователю,
    // не перепривязываем его автоматически, а создаём заявку на перенос.
    if (existing && claimOwner) {
      const pending = await requestTransferIfForeign(
        { ...existing, hardware_id: hardwareId, board_uuid: hardwareId },
        claimOwner,
      );
      if (pending) {
        return reply.code(202).send({
          ok: false,
          pendingTransfer: true,
          transferId: pending.transferId,
          ownerUsername: pending.ownerUsername,
          moduleId: pending.moduleId,
        });
      }
    }

    const role = asRole(body.role, asRole(existing?.role, 'gateway'));
    const kind = body.kind === 'lora' ? 'lora' : 'wifi';
    const transport = asTransport(body.transport, asTransport(existing?.transport, defaultTransport(role, kind)));
    const attached = role === 'wearable' ? Boolean(body.attached) : true;

    let moduleId: string;
    let publicId: string;
    let tokenVersion = 0;
    const neighbors = (body.neighbors ?? []).slice(0, 100);
    const rssi = Math.trunc(Number(body.rssi ?? 0)) | 0;
    const uptime = Math.max(0, Math.trunc(Number(body.uptime ?? 0)));
    const adoptOwner = claimOwner && existing && existing.owner_id === system.id ? claimOwner : null;
    const clusterId = String(body.cluster_id ?? body.clusterId ?? '').slice(0, 24);
    const border = body.border === true || Number(body.border ?? 0) !== 0;
    const transports: string[] = [];
    if (body.wifi === true || Number(body.wifi ?? 0) !== 0) transports.push('wifi');
    if (body.lora === true || Number(body.lora ?? 0) !== 0) transports.push('lora');
    if (!transports.length) transports.push(kind === 'lora' ? 'lora' : 'wifi');
    if (transport === 'ble' || transport === 'usb') transports.push(transport);
    if (existing) {
      moduleId = existing.id;
      tokenVersion = Number(existing.token_version ?? 0);
      await query(
        `UPDATE modules SET
                board_uuid = CASE WHEN hardware_id ~* '^esp32-[0-9a-f]{12}$' THEN hardware_id ELSE $2 END,
                hardware_id = CASE WHEN hardware_id ~* '^esp32-[0-9a-f]{12}$' THEN hardware_id ELSE $2 END,
                mesh_addr = CASE WHEN hardware_id ~* '^esp32-[0-9a-f]{12}$' THEN hardware_id ELSE $2 END,
                ble_mac = CASE WHEN $19 <> '' THEN $19 ELSE ble_mac END,
                role = $3, transport = $4, kind = $5,
                firmware = COALESCE(NULLIF($6,''), firmware), battery = $7, attached = $8,
                status = 'online', last_seen_at = now(), last_ip = $9, updated_at = now(),
                rssi = CASE WHEN $11 <> 0 THEN $11 ELSE rssi END,
                uptime = CASE WHEN $12 > 0 THEN $12 ELSE uptime END,
                neighbors = $13,
                owner_id = COALESCE($10, owner_id),
                cluster_id = $14, border = $15, transports = $16::text[],
                last_neighbors = $17::jsonb,
                firmware_config = CASE WHEN $18::jsonb IS NULL THEN firmware_config ELSE $18::jsonb END
          WHERE id = $1`,
        [moduleId, hardwareId, role, transport, kind, body.firmware ?? '', Number(body.battery ?? 0), attached, ip, adoptOwner, rssi, uptime, neighbors.length,
          clusterId, border, transports, JSON.stringify(neighbors.slice(0, 32)),
          body.pins && typeof body.pins === 'object' ? JSON.stringify(body.pins) : null, bleMac],
      );
      publicId = existing.public_id || (await assignPublicId(moduleId, hardwareId));
    } else {
      const inserted = await one<{ id: string }>(
        `INSERT INTO modules (owner_id, board_uuid, hardware_id, mesh_addr, ble_mac, public_id, role, transport, kind, firmware, battery, attached, status, last_seen_at, last_ip, rssi, uptime, neighbors, cluster_id, border, transports, last_neighbors, firmware_config)
         VALUES ($1,$2,$2,$2,$18,'',$3,$4,$5,$6,$7,$8,'online',now(),$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb) RETURNING id`,
        [claimOwner ?? system.id, hardwareId, role, transport, kind, body.firmware ?? '', Number(body.battery ?? 0), attached, ip, rssi, uptime, neighbors.length,
          clusterId, border, transports, JSON.stringify(neighbors.slice(0, 32)),
          body.pins && typeof body.pins === 'object' ? JSON.stringify(body.pins) : null, bleMac],
      );
      moduleId = inserted!.id;
      publicId = await assignPublicId(moduleId, hardwareId);
    }
    const ownerForName = adoptOwner ?? claimOwner;
    if (ownerForName) await assignModuleName(ownerForName, moduleId, Boolean(adoptOwner)).catch(() => undefined);

    // Gossip: шлюз сообщает, какие модули он видит в mesh. Это позволяет
    // считать ретрансляторы/носимые онлайн без их собственного интернета.
    // Матчим по MAC (каноническая идентичность), public_id — только fallback.
    for (const n of neighbors) {
      const pid = String(n.publicId ?? '').trim();
      const hwRaw = String(n.hardwareId ?? '').trim().toLowerCase();
      const hw = hwRaw ? canonicalHardwareId(hwRaw) : null;
      const rev = hw ? reversedHardwareId(hw) : null;
      if (!hw && !isPublicId(pid)) continue;
      const rssiN = Number(n.rssi ?? 0) | 0;
      const peerNeighbors = Math.max(0, Number(n.neighbors ?? 0) | 0);
      const peerCluster = String(n.clusterId ?? '').slice(0, 24);
      const peerBattery = Math.max(0, Math.min(100, Number(n.battery ?? 0) | 0));
      const updatedPeer = await query<{ id: string }>(
        `UPDATE modules SET last_seen_at = now(), status = 'online',
                rssi = CASE WHEN $2 <> 0 THEN $2 ELSE rssi END,
                neighbors = CASE WHEN $4 > 0 THEN $4 ELSE GREATEST(neighbors, 1) END,
                cluster_id = CASE WHEN $5 <> '' THEN $5 WHEN $8 <> '' THEN $8 ELSE cluster_id END,
                transports = CASE WHEN transports = '{}' THEN $9::text[] ELSE transports END,
                battery = CASE WHEN $6 > 0 THEN $6 ELSE battery END,
                updated_at = now()
          WHERE blocked = false AND (
            ($1::text IS NOT NULL AND lower(hardware_id) = $1)
            OR ($7::text IS NOT NULL AND lower(hardware_id) = $7)
            OR ($3::text <> '' AND public_id = $3)
          )
          RETURNING id`,
        [hw, rssiN, pid, peerNeighbors, peerCluster, peerBattery, rev, clusterId, ['wifi']],
      ).catch(() => []);
      await query(
        `INSERT INTO mesh_devices
           (mesh_addr, hardware_id, public_id, role, transport, kind, cluster_id,
            border, transports, neighbors, last_rssi, firmware, status, last_seen_at)
         SELECT hardware_id, hardware_id, public_id, role, transport, kind,
                CASE WHEN $5 <> '' THEN $5 WHEN $7 <> '' THEN $7 ELSE cluster_id END,
                border,
                CASE WHEN transports = '{}' THEN $8::text[] ELSE transports END,
                CASE WHEN $4 > 0 THEN $4 ELSE GREATEST(neighbors, 1) END,
                $2, firmware, 'online', now()
           FROM modules
          WHERE blocked = false AND (
            ($1::text IS NOT NULL AND lower(hardware_id) = $1)
            OR ($6::text IS NOT NULL AND lower(hardware_id) = $6)
            OR ($3::text <> '' AND public_id = $3)
          )
          LIMIT 1
         ON CONFLICT (mesh_addr) DO UPDATE SET
           role = CASE WHEN EXCLUDED.role <> '' THEN EXCLUDED.role ELSE mesh_devices.role END,
           transport = CASE WHEN EXCLUDED.transport <> '' THEN EXCLUDED.transport ELSE mesh_devices.transport END,
           kind = CASE WHEN EXCLUDED.kind <> '' THEN EXCLUDED.kind ELSE mesh_devices.kind END,
           cluster_id = CASE WHEN EXCLUDED.cluster_id <> '' THEN EXCLUDED.cluster_id ELSE mesh_devices.cluster_id END,
           border = EXCLUDED.border,
           transports = CASE WHEN EXCLUDED.transports = '{}' THEN mesh_devices.transports ELSE EXCLUDED.transports END,
           neighbors = EXCLUDED.neighbors,
           status = 'online', last_rssi = EXCLUDED.last_rssi, last_seen_at = now(), updated_at = now()`,
        [hw, rssiN, pid, peerNeighbors, peerCluster, rev, clusterId, ['wifi']],
      ).catch(() => undefined);
      // Карточка peer-модуля: показываем шлюз как его соседа.
      const peerId = updatedPeer[0]?.id;
      if (peerId) {
        await query('DELETE FROM module_neighbors WHERE module_id = $1', [peerId]).catch(() => undefined);
        await query(
          `INSERT INTO module_neighbors (module_id, neighbor_uuid, rssi, channel, has_gateway)
           VALUES ($1,$2,$3,'wifi',true)`,
          [peerId, hardwareId, rssiN],
        ).catch(() => undefined);
      }
    }

    // Соседи самого шлюза — чтобы и его карточка показывала живые данные.
    if (neighbors.length) {
      await query('DELETE FROM module_neighbors WHERE module_id = $1', [moduleId]).catch(() => undefined);
      for (const n of neighbors.slice(0, 50)) {
        const neighborUuid = String(n.hardwareId ?? n.publicId ?? '').slice(0, 64);
        if (!neighborUuid) continue;
        await query(
          `INSERT INTO module_neighbors (module_id, neighbor_uuid, rssi, channel, has_gateway)
           VALUES ($1,$2,$3,'wifi',true)`,
          [moduleId, neighborUuid, Number(n.rssi ?? 0) | 0],
        ).catch(() => undefined);
      }
    }

    // TELEMETRY_REPORT: register/checkin уже содержит кластер, соседей и
    // транспорты — сохраняем снимок для агрегации по кластерам.
    if (clusterId) {
      const avgRssi = neighbors.length
        ? Math.round(neighbors.reduce((sum, n) => sum + Number(n.rssi ?? 0), 0) / neighbors.length)
        : 0;
      await query(
        `INSERT INTO telemetry_reports (module_id, mesh_addr, cluster_id, neighbors, avg_rssi, outbox_depth, hues)
         VALUES ($1,$2,$3,$4,$5,$6,$7::text[])`,
        [moduleId, hardwareId, clusterId, neighbors.length, avgRssi, 0, transports],
      ).catch(() => undefined);
    }

    // DeviceRegistry: одна запись на физический модуль, ключ — mesh_addr.
    await query(
      `INSERT INTO mesh_devices
         (mesh_addr, hardware_id, ble_mac, user_id, public_id, role, transport, kind,
          cluster_id, border, transports, neighbors, last_rssi, firmware, status, last_seen_at)
       VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,$13,'online',now())
       ON CONFLICT (mesh_addr) DO UPDATE SET
         ble_mac = CASE WHEN EXCLUDED.ble_mac <> '' THEN EXCLUDED.ble_mac ELSE mesh_devices.ble_mac END,
         user_id = COALESCE(EXCLUDED.user_id, mesh_devices.user_id),
         public_id = COALESCE(NULLIF(EXCLUDED.public_id, ''), mesh_devices.public_id),
         role = EXCLUDED.role, transport = EXCLUDED.transport, kind = EXCLUDED.kind,
         cluster_id = CASE WHEN EXCLUDED.cluster_id <> '' THEN EXCLUDED.cluster_id ELSE mesh_devices.cluster_id END,
         border = EXCLUDED.border,
         transports = CASE WHEN EXCLUDED.transports = '{}' THEN mesh_devices.transports ELSE EXCLUDED.transports END,
         neighbors = EXCLUDED.neighbors, last_rssi = EXCLUDED.last_rssi,
         firmware = COALESCE(NULLIF(EXCLUDED.firmware, ''), mesh_devices.firmware),
         status = 'online', last_seen_at = now(), updated_at = now()`,
      [hardwareId, bleMac, adoptOwner ?? claimOwner ?? existing?.owner_id ?? system.id, publicId,
        role, transport, kind, clusterId, border, transports, neighbors.length, rssi,
        body.firmware ?? ''],
    ).catch(() => undefined);

    // Смена кластера = завершённый хендовер. Логируем для мониторинга
    // аномалий (частые перескоки между кластерами).
    if (existing && existing.cluster_id && clusterId && existing.cluster_id !== clusterId) {
      await query(
        `INSERT INTO handover_events (module_id, mesh_addr, from_cluster, to_cluster, state)
         VALUES ($1,$2,$3,$4,'complete')`,
        [moduleId, hardwareId, existing.cluster_id, clusterId],
      ).catch(() => undefined);
      log('info', 'mesh_handover', {
        moduleId,
        meshAddr: hardwareId,
        from: existing.cluster_id,
        to: clusterId,
      });
    }

    const cfg = await getMeshConfig();
    const token = signModuleToken(moduleId, publicId, tokenVersion);
    log('info', 'module_registered', { moduleId, hardwareId, publicId, role, ip });
    publish(adoptOwner ?? claimOwner ?? existing?.owner_id ?? system.id, {
      type: 'module_status',
      moduleId,
      hardwareId,
      publicId,
      status: 'online',
      online: true,
      rssi,
      uptime,
      firmware: body.firmware ?? '',
    });
    return reply.send({
      ok: true,
      moduleId,
      hardwareId,
      publicId,
      role,
      moduleToken: token,
      intervalSec: 60,
      mesh: meshPublicConfig(cfg),
    });
  });

  app.get('/modules', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const rows = await query<ModuleRecord>(
      `SELECT ${MODULE_COLUMNS} FROM modules m WHERE m.owner_id = $1 ORDER BY m.created_at DESC`,
      [me],
    );
    const shadows = await query<ShadowRecord>(
      `SELECT id, module_id, public_id, hardware_id, role, created_at
         FROM module_shadows
        WHERE old_owner_id = $1 AND dismissed = false
        ORDER BY created_at DESC`,
      [me],
    );
    const blockedHashes = await activeBlockedHashes();
    return reply.send([
      ...rows.map((row) => moduleView(row, blockedHashes)),
      ...shadows.map(shadowView),
    ]);
  });

  /** Публичная часть глобальной mesh-конфигурации (без пароля). */
  app.get('/modules/mesh', { onRequest: [requireAuth()] }, async (_req, reply) => {
    const cfg = await getMeshConfig();
    return reply.send(meshPublicConfig(cfg));
  });

  /** Скрыть «тень» у прежнего владельца (удалить запись из своего списка). */
  app.post('/modules/shadows/:id/dismiss', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { id } = req.params as { id: string };
    const row = await one<{ id: string }>(
      'SELECT id FROM module_shadows WHERE id = $1 AND old_owner_id = $2',
      [id, me],
    );
    if (!row) throw notFound('module_shadow');
    await query('UPDATE module_shadows SET dismissed = true WHERE id = $1', [id]);
    log('info', 'module_shadow_dismissed', { shadowId: id, owner: me });
    return reply.send({ ok: true });
  });

  /** «Это не я»: помечаем тень как жалобу. Владельца не меняем автоматически. */
  app.post('/modules/shadows/:id/report', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { id } = req.params as { id: string };
    const row = await one<{ id: string; module_id: string; public_id: string }>(
      'SELECT id, module_id, public_id FROM module_shadows WHERE id = $1 AND old_owner_id = $2',
      [id, me],
    );
    if (!row) throw notFound('module_shadow');
    await query('UPDATE module_shadows SET reported = true WHERE id = $1', [id]);
    log('warn', 'module_shadow_reported', {
      shadowId: id,
      moduleId: row.module_id,
      publicId: row.public_id,
      owner: me,
    });
    return reply.send({ ok: true });
  });

  /**
   * Mesh-шлюз пересылает конверты в Hub. Каждый конверт проверяется на
   * членство владельца модуля в чате, кладётся в mesh_inbox и, если в нём
   * есть метаданные объекта, сохраняется как обычное сообщение.
   */
  app.post('/modules/relay', { onRequest: [requireModule()] }, async (req, reply) => {
    const mod = req.module!;
    if (mod.role !== 'gateway') throw forbidden('gateway_required');
    rateLimit(`mod-relay:${mod.moduleId}`, 120, 60_000);

    const body = (req.body ?? {}) as { envelopes?: unknown };
    const items = Array.isArray(body.envelopes) ? (body.envelopes as RelayEnvelopeItem[]) : [];
    if (!items.length) throw badRequest('envelopes_required');
    if (items.length > 100) throw badRequest('too_many_envelopes');

    let accepted = 0;
    let failed = 0;
    let processed = 0;

    for (const item of items.slice(0, 100)) {
      const chatId = String(item?.chatId ?? '');
      const packetId = String(item?.packetId ?? '').slice(0, 128);
      let envelope: Record<string, unknown> =
        item?.envelope && typeof item.envelope === 'object' && !Array.isArray(item.envelope)
          ? (item.envelope as Record<string, unknown>)
          : {};
      // Новая прошивка присылает envelopeB64 (base64 от JSON): так тело
      // relay всегда валидный JSON, без проблем с экранированием.
      if (!Object.keys(envelope).length && typeof item?.envelopeB64 === 'string' && item.envelopeB64) {
        try {
          const decoded = Buffer.from(item.envelopeB64, 'base64').toString('utf8');
          const parsed = JSON.parse(decoded) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            envelope = parsed as Record<string, unknown>;
          }
        } catch {
          /* останется пустым → уйдёт в failed */
        }
      }

      // chat_id в mesh_inbox — uuid без FK; невалидный пишем как NULL.
      const chatUuid = UUID_RE.test(chatId) ? chatId : null;

      if (!chatUuid) {
        await query(
          `INSERT INTO mesh_inbox (module_id, owner_id, chat_id, packet_id, envelope, status, error)
           VALUES ($1,$2,NULL,$3,$4,'failed',$5)`,
          [mod.moduleId, mod.ownerId, packetId, JSON.stringify(envelope), 'invalid_chat_id'],
        );
        failed += 1;
        continue;
      }

      let inboxId: string | null = null;
      try {
        const membership = await one(
          'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
          [chatUuid, mod.ownerId],
        );
        if (!membership) {
          await query(
            `INSERT INTO mesh_inbox (module_id, owner_id, chat_id, packet_id, envelope, status, error)
             VALUES ($1,$2,$3,$4,$5,'failed',$6)`,
            [mod.moduleId, mod.ownerId, chatUuid, packetId, JSON.stringify(envelope), 'not_a_member'],
          );
          failed += 1;
          continue;
        }

        const inbox = await one<{ id: string }>(
          `INSERT INTO mesh_inbox (module_id, owner_id, chat_id, packet_id, envelope, status)
           VALUES ($1,$2,$3,$4,$5,'queued') RETURNING id`,
          [mod.moduleId, mod.ownerId, chatUuid, packetId, JSON.stringify(envelope)],
        );
        inboxId = inbox!.id;
        accepted += 1;

        const persisted = await persistRelayMessage(
          mod.ownerId,
          mod.moduleId,
          chatUuid,
          packetId,
          envelope,
        );
        if (persisted) {
          processed += 1;
          await query(
            `UPDATE mesh_inbox SET status = 'processed', processed_at = now() WHERE id = $1`,
            [inboxId],
          );
        } else {
          // Оставили в очереди: обработчик может дозаполнить метаданные.
          const members = await query<{ user_id: string }>(
            'SELECT user_id FROM chat_members WHERE chat_id = $1',
            [chatUuid],
          );
          publishMany(members.map((m) => m.user_id), {
            type: 'chat_updated',
            chatId: chatUuid,
            packetId,
            mesh: true,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (inboxId) {
          // Запись уже была принята в очередь — переводим её в failed.
          accepted -= 1;
          failed += 1;
          await query(
            `UPDATE mesh_inbox SET status = 'failed', error = $2 WHERE id = $1`,
            [inboxId, message.slice(0, 500)],
          ).catch(() => undefined);
        } else {
          failed += 1;
          await query(
            `INSERT INTO mesh_inbox (module_id, owner_id, chat_id, packet_id, envelope, status, error)
             VALUES ($1,$2,$3,$4,$5,'failed',$6)`,
            [mod.moduleId, mod.ownerId, chatUuid, packetId, JSON.stringify(envelope), message.slice(0, 500)],
          ).catch(() => undefined);
        }
        log('warn', 'module_relay_failed', { moduleId: mod.moduleId, chatId: chatUuid, error: message });
      }
    }

    log('info', 'module_relay', { moduleId: mod.moduleId, accepted, processed, failed });
    return reply.send({ ok: true, accepted, failed, processed });
  });

  /**
   * Очередь для шлюза: последние 50 чужих сообщений из чатов владельца.
   * `since` (ISO) и `cursor` (seq) — взаимоисключающие фильтры; клиент
   * дедуплицирует по id, сервер ничего не помечает.
   */
  app.get('/modules/relay/pending', { onRequest: [requireModule()] }, async (req, reply) => {
    const mod = req.module!;
    if (mod.role !== 'gateway') throw forbidden('gateway_required');

    const q = req.query as { since?: string; cursor?: string };
    let since: string | null = null;
    if (typeof q.since === 'string' && q.since.trim()) {
      const d = new Date(q.since);
      if (!Number.isFinite(d.getTime())) throw badRequest('invalid_since');
      since = d.toISOString();
    }
    let cursor: number | null = null;
    if (typeof q.cursor === 'string' && q.cursor.trim()) {
      const n = Number(q.cursor);
      if (!Number.isFinite(n) || n < 0) throw badRequest('invalid_cursor');
      cursor = Math.trunc(n);
    }

    const rows = await query<{
      id: string;
      chat_id: string;
      seq: number;
      kind: string;
      header: unknown;
      object_id: string | null;
      reply_to: string | null;
      as_channel: boolean;
      sender_user_id: string;
      sender_username: string;
      sender_device_id: string | null;
      created_at: string;
      client_id: string | null;
      size_bytes: number | null;
    }>(
      `SELECT m.id, m.chat_id, m.seq, m.kind, m.header, m.object_id, m.reply_to, m.as_channel,
              m.sender_user_id, u.username AS sender_username, m.sender_device_id,
              m.created_at, m.client_id, COALESCE(o.size_bytes, 0) AS size_bytes
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $1
         JOIN users u ON u.id = m.sender_user_id
         LEFT JOIN objects o ON o.id = m.object_id
        WHERE m.sender_user_id <> $1
          AND ($2::timestamptz IS NULL OR m.created_at > $2::timestamptz)
          AND ($3::bigint IS NULL OR m.seq > $3::bigint)
        ORDER BY m.seq DESC
        LIMIT 50`,
      [mod.ownerId, since, cursor],
    );

    const ordered = rows.reverse();
    const items = [];
    for (const row of ordered) {
      // Для небольших текстовых сообщений отдаём шифротекст прямо в envelope:
      // получатель без интернета не может скачать object с узлов.
      let envelopeB64: string | undefined;
      if (row.object_id && (row.size_bytes ?? 0) > 0 && (row.size_bytes ?? 0) <= 4096) {
        try {
          const frag = await one<{ index: number; node_id: string; public_url: string; ticket_secret: string }>(
            `SELECT f.index, n.id AS node_id, n.public_url, n.ticket_secret
               FROM fragments f JOIN nodes n ON n.id = f.node_id
              WHERE f.object_id = $1 AND f.state = 'ok' AND n.status <> 'banned'
              ORDER BY (n.status = 'online') DESC, n.reputation DESC
              LIMIT 1`,
            [row.object_id],
          );
          if (frag) {
            const stream = await getFragment(
              { id: frag.node_id, public_url: frag.public_url, ticket_secret: frag.ticket_secret },
              row.object_id,
              frag.index,
              mod.ownerId,
            );
            const chunks: Buffer[] = [];
            let total = 0;
            for await (const chunk of stream) {
              const buf = chunk as Buffer;
              total += buf.length;
              if (total > 4096) break;
              chunks.push(buf);
            }
            if (total > 0 && total <= 4096) {
              envelopeB64 = Buffer.concat(chunks).toString('base64url');
            }
          }
        } catch {
          /* нет узла/фрагмента — клиент попробует скачать object позже */
        }
      }
      items.push({
        id: row.id,
        chatId: row.chat_id,
        seq: row.seq,
        createdAt: row.created_at,
        envelope: {
          id: row.id,
          seq: row.seq,
          chatId: row.chat_id,
          kind: row.kind,
          objectId: row.object_id,
          nonce: extractNonce(row.header),
          header: row.header,
          replyTo: row.reply_to,
          asChannel: row.as_channel,
          senderUserId: row.sender_user_id,
          senderUsername: row.sender_username,
          senderDeviceId: row.sender_device_id,
          createdAt: row.created_at,
          clientId: row.client_id,
          ...(envelopeB64 ? { envelopeB64 } : {}),
        },
      });
    }
    return reply.send({ ok: true, items, cursor: rows.length ? rows[rows.length - 1].seq : cursor });
  });

  /** Подтверждение обработки записей mesh_inbox (опционально). */
  app.post('/modules/relay/ack', { onRequest: [requireModule()] }, async (req, reply) => {
    const mod = req.module!;
    const body = (req.body ?? {}) as { ids?: unknown; packetIds?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)) : [];
    const packetIds = Array.isArray(body.packetIds)
      ? body.packetIds.filter((v): v is string => typeof v === 'string' && v.length > 0).slice(0, 100)
      : [];
    if (!ids.length && !packetIds.length) throw badRequest('ids_required');

    const rows = await query<{ id: string }>(
      `UPDATE mesh_inbox SET status = 'processed', processed_at = now()
        WHERE module_id = $1 AND status <> 'processed'
          AND (id = ANY($2::uuid[]) OR packet_id = ANY($3::text[]))
        RETURNING id`,
      [mod.moduleId, ids, packetIds],
    );
    return reply.send({ ok: true, updated: rows.length });
  });

  /* ---------------------------------------------------- OTA: владелец ---- */

  /** Поставить модулю задание OTA. buildId необязателен — берём последнюю сборку. */
  app.post('/modules/:id/ota', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    if (!UUID_RE.test(id)) throw notFound('module');
    const mod = await one<{ id: string; hardware_id: string | null; board_uuid: string | null }>(
      'SELECT id, hardware_id, board_uuid FROM modules WHERE id = $1 AND owner_id = $2',
      [id, me],
    );
    if (!mod) throw notFound('module');

    const body = (req.body ?? {}) as { buildId?: string };
    const build = body.buildId
      ? await one<{ id: string; version: string; app_path: string | null }>(
          `SELECT id, version, app_path FROM firmware_builds
            WHERE id = $1 AND user_id = $2 AND status = 'ready'`,
          [body.buildId, me],
        )
      : await one<{ id: string; version: string; app_path: string | null }>(
          `SELECT id, version, app_path FROM firmware_builds
            WHERE user_id = $1 AND status = 'ready' AND app_path IS NOT NULL
            ORDER BY created_at DESC LIMIT 1`,
          [me],
        );
    if (!build) throw notFound('firmware_build');
    if (!build.app_path) {
      throw new ApiError(409, 'ota_image_missing', 'У сборки нет OTA-образа. Пересоберите прошивку.');
    }

    await query(
      `UPDATE module_ota_jobs SET status = 'superseded', updated_at = now()
        WHERE module_id = $1 AND status IN ('pending','downloading','installing')`,
      [id],
    );
    const job = await one<{ id: string }>(
      `INSERT INTO module_ota_jobs (module_id, build_id, requested_by, version)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [id, build.id, me, build.version],
    );
    log('info', 'module_ota_queued', { moduleId: id, buildId: build.id, jobId: job?.id });
    return reply.code(201).send({ ok: true, jobId: job?.id, version: build.version });
  });

  /** Статус последнего OTA-задания (для UI). */
  app.get('/modules/:id/ota', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    if (!UUID_RE.test(id)) throw notFound('module');
    const mod = await one('SELECT 1 FROM modules WHERE id = $1 AND owner_id = $2', [id, me]);
    if (!mod) throw notFound('module');
    const row = await one<{
      id: string; status: string; progress: number; error: string | null; version: string | null;
      app_size_bytes: number | null; app_sha256: string | null; created_at: string; updated_at: string;
    }>(
      `SELECT j.id, j.status, j.progress, j.error, b.version, b.app_size_bytes, b.app_sha256,
              j.created_at, j.updated_at
         FROM module_ota_jobs j JOIN firmware_builds b ON b.id = j.build_id
        WHERE j.module_id = $1 ORDER BY j.created_at DESC LIMIT 1`,
      [id],
    );
    return reply.send({ job: row ? otaJobDto(row) : null });
  });

  /* ------------------------------------------------------- OTA: модуль ---- */

  /** Модуль с Wi-Fi сам забирает активное задание. */
  app.get('/modules/ota/job', { onRequest: [requireModule()] }, async (req, reply) => {
    return reply.send({ ok: true, job: await activeOtaJob(req.module!.moduleId) });
  });

  /** Скачивание app-only образа по module-token. */
  app.get('/modules/ota/firmware/:jobId', { onRequest: [requireModule()] }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!UUID_RE.test(jobId)) throw notFound('ota_job');
    const row = await one<{ app_path: string | null; version: string | null }>(
      `SELECT b.app_path, b.version FROM module_ota_jobs j
         JOIN firmware_builds b ON b.id = j.build_id
        WHERE j.id = $1 AND j.module_id = $2`,
      [jobId, req.module!.moduleId],
    );
    if (!row?.app_path) throw notFound('ota_image');
    try {
      await stat(row.app_path);
    } catch {
      throw notFound('ota_image');
    }
    await query(`UPDATE module_ota_jobs SET status = 'downloading', updated_at = now() WHERE id = $1`, [jobId]);
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="kinto-ota-${row.version || jobId}.bin"`);
    return reply.send(createReadStream(row.app_path));
  });

  /** Прогресс/результат OTA от модуля. */
  app.post('/modules/ota/status', { onRequest: [requireModule()] }, async (req, reply) => {
    const body = (req.body ?? {}) as {
      jobId?: string;
      status?: string;
      progress?: number;
      error?: string;
    };
    const jobId = String(body.jobId ?? '');
    if (!UUID_RE.test(jobId)) throw badRequest('invalid_job');
    const job = await one<{ id: string; build_id: string; version: string | null }>(
      'SELECT id, build_id, version FROM module_ota_jobs WHERE id = $1 AND module_id = $2',
      [jobId, req.module!.moduleId],
    );
    if (!job) throw notFound('ota_job');
    const status = ['pending', 'downloading', 'installing', 'installed', 'failed'].includes(String(body.status))
      ? String(body.status)
      : 'downloading';
    const progress = Math.max(0, Math.min(100, Number(body.progress ?? 0) | 0));
    const error = typeof body.error === 'string' ? body.error.slice(0, 500) : null;
    await query(
      `UPDATE module_ota_jobs
          SET status = $2, progress = $3, error = $4, updated_at = now(),
              completed_at = CASE WHEN $2 IN ('installed','failed') THEN now() ELSE completed_at END
        WHERE id = $1`,
      [jobId, status, progress, error],
    );
    if (status === 'installed') {
      await query(
        `UPDATE modules SET firmware = $2, firmware_build_id = $3, firmware_updated_at = now(), updated_at = now()
          WHERE id = $1`,
        [req.module!.moduleId, job.version ?? '', job.build_id],
      );
      // Временная сборка больше не нужна: удаляем бинарники и запись.
      setTimeout(() => {
        void (async () => {
          const build = await one<{ bin_path: string | null; app_path: string | null }>(
            'SELECT bin_path, app_path FROM firmware_builds WHERE id = $1',
            [job.build_id],
          ).catch(() => null);
          if (build?.bin_path) await unlink(build.bin_path).catch(() => undefined);
          if (build?.app_path) await unlink(build.app_path).catch(() => undefined);
          await query('DELETE FROM firmware_builds WHERE id = $1', [job.build_id]).catch(() => undefined);
        })();
      }, 5 * 60_000);
    }
    publish(req.module!.ownerId, {
      type: 'module_ota',
      moduleId: req.module!.moduleId,
      jobId,
      status,
      progress,
      error,
      version: job.version,
    });
    return reply.send({ ok: true });
  });

  /** Конфигурация прошивки, сохранённая при последней прошивке модуля. */
  app.get('/modules/:id/firmware-config', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    if (!UUID_RE.test(id)) throw notFound('module');
    const row = await one<{ firmware_config: unknown; board: string | null }>(
      'SELECT firmware_config, board FROM modules WHERE id = $1 AND owner_id = $2',
      [id, me],
    );
    if (!row) throw notFound('module');
    return reply.send({ ok: true, config: row.firmware_config ?? null, board: row.board ?? '' });
  });

  /** Один модуль или «тень»: статус считается так же, как в списке. */
  app.get('/modules/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    if (UUID_RE.test(id)) {
      const row = await one<ModuleRecord>(`SELECT ${MODULE_COLUMNS} FROM modules m WHERE m.id = $1`, [id]);
      if (row && row.owner_id === me) {
        return reply.send(moduleView(row, await activeBlockedHashes()));
      }
      const shadow = await one<ShadowRecord>(
        `SELECT id, module_id, public_id, hardware_id, role, created_at
           FROM module_shadows WHERE id = $1 AND old_owner_id = $2 AND dismissed = false`,
        [id, me],
      );
      if (shadow) return reply.send(shadowView(shadow));
      throw notFound('module');
    }
    throw notFound('module');
  });

  app.delete('/modules/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await loadOwnedModule(id, me);
    // Отвязка ≠ блокировка: плату можно привязать заново.
    await query('DELETE FROM modules WHERE id = $1', [id]);
    log('info', 'module_unbound', { moduleId: id, owner: me });
    return reply.send({ ok: true });
  });

  /** Клиент подключил wearable по BLE/USB: модуль считается на связи. */
  app.post('/modules/:id/attach', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const body = (req.body ?? {}) as { transport?: string };
    const transport = asTransport(body.transport, 'usb');
    if (transport !== 'ble' && transport !== 'usb') throw badRequest('invalid_transport');

    const row = await loadOwnedModule(id, me);
    if (row.blocked || (await isHardwareBlocked(row.hardware_id || row.board_uuid))) {
      throw new ApiError(403, 'module_blocked', 'module_blocked');
    }
    await query(
      `UPDATE modules SET attached = true, attached_at = now(), last_seen_at = now(),
              transport = $2, status = 'online', updated_at = now()
        WHERE id = $1`,
      [id, transport],
    );
    log('info', 'module_attached', { moduleId: id, owner: me, transport });
    return reply.send({ ok: true, attached: true, transport });
  });

  /** Клиент отключил wearable: статус станет offline, last_seen_at не трогаем. */
  app.post('/modules/:id/detach', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    await loadOwnedModule(id, me);
    await query(
      "UPDATE modules SET attached = false, status = 'offline', updated_at = now() WHERE id = $1",
      [id],
    );
    log('info', 'module_detached', { moduleId: id, owner: me });
    return reply.send({ ok: true, attached: false });
  });

  /** Блокировка по hardware_id: перепрошивка MAC не меняет, обойти нельзя. */
  app.post('/modules/:id/block', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const body = (req.body ?? {}) as { reason?: string };
    const row = await loadOwnedModule(id, me);
    const hardwareId = (row.hardware_id || row.board_uuid).toLowerCase();
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : '';

    await query(
      `UPDATE modules SET blocked = true, block_reason = $2, blocked_reason = $2, status = 'offline', updated_at = now()
        WHERE id = $1`,
      [id, reason],
    );

    const hwHash = sha256(hardwareId);
    const already = await one('SELECT 1 FROM blocked_nodes WHERE active = true AND hw_hash = $1', [hwHash]);
    if (!already) {
      await query(
        `INSERT INTO blocked_nodes (ip, hw_hash, reason, created_by) VALUES ('', $1, $2, $3)`,
        [hwHash, reason || `module ${hardwareId}`, me],
      );
    }

    log('info', 'module_blocked', { moduleId: id, owner: me, hardwareId, reason });
    return reply.send({ ok: true, blocked: true, blockReason: reason });
  });

  app.post('/modules/:id/unblock', { onRequest: [requireAuth()] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const me = req.auth!.userId;
    const row = await loadOwnedModule(id, me);
    const hardwareId = (row.hardware_id || row.board_uuid).toLowerCase();

    await query(
      `UPDATE modules SET blocked = false, block_reason = '', blocked_reason = NULL, updated_at = now()
        WHERE id = $1`,
      [id],
    );
    await query(
      `UPDATE blocked_nodes SET active = false
        WHERE active = true AND hw_hash = ANY($1::text[])`,
      [[sha256(hardwareId), hardwareId]],
    );

    log('info', 'module_unblocked', { moduleId: id, owner: me, hardwareId });
    return reply.send({ ok: true, blocked: false });
  });

  /**
   * Телеметрия модуля: публичный ID, батарея, роль, транспорт, шлюз,
   * соседи по mesh. В ответе — глобальная mesh-конфигурация без пароля.
   */
  app.post('/modules/checkin', { onRequest: [requireModule()] }, async (req, reply) => {
    const mod = req.module!;
    const body = (req.body ?? {}) as {
      publicId?: string | number;
      hardwareId?: string;
      role?: string;
      transport?: string;
      attached?: boolean;
      rssi?: number;
      uptime?: number;
      battery?: number;
      firmware?: string;
      gateway?: boolean;
      neighbors?: { uuid: string; rssi?: number; channel?: string; hasGateway?: boolean }[];
    };
    const battery = Math.max(0, Math.min(100, Number(body.battery ?? 0) | 0));

    // hardwareId из прошивки стабилен; пустое значение не затирает сохранённое.
    const hardwareId =
      typeof body.hardwareId === 'string' && body.hardwareId.trim().length >= 8
        ? body.hardwareId.trim().toLowerCase()
        : '';
    const role = asRole(body.role, asRole(mod.role, 'gateway'));
    const transport = asTransport(body.transport, asTransport(mod.transport, defaultTransport(role, 'wifi')));
    // wearable attached=true только если реально подключён к клиенту (BLE/USB).
    const attached = role === 'wearable' ? Boolean(body.attached) : true;
    const rssi = Math.trunc(Number(body.rssi ?? 0)) | 0;
    const uptime = Math.max(0, Math.trunc(Number(body.uptime ?? 0)));
    const neighbors = Array.isArray(body.neighbors) ? body.neighbors : [];
    const ip = clientIp(req);

    // Старые модули могли не иметь public_id — дозаполняем при первом check-in.
    let publicId = mod.publicId;
    if (!publicId) {
      const hw = hardwareId || mod.hardwareId;
      if (hw) publicId = await assignPublicId(mod.moduleId, hw);
    }
    // Переданный модулем publicId не должен расходиться с серверным.
    if (body.publicId !== undefined && body.publicId !== null && String(body.publicId).trim() !== publicId) {
      log('warn', 'module_checkin_public_id_mismatch', {
        moduleId: mod.moduleId,
        expected: publicId,
        got: String(body.publicId),
      });
    }

    await tx(async ({ query: q }) => {
      await q(
        `UPDATE modules SET
                hardware_id = COALESCE(NULLIF($2,''), hardware_id),
                board_uuid = COALESCE(NULLIF($2,''), board_uuid),
                role = $3, transport = $4,
                attached = $5,
                attached_at = CASE WHEN $5 AND attached = false THEN now() ELSE attached_at END,
                battery = $6, firmware = COALESCE(NULLIF($7,''), firmware),
                rssi = $8, uptime = $9,
                gateway = $10, neighbors = $11,
                last_ip = $12,
                status = CASE WHEN $5 THEN 'online' ELSE 'offline' END,
                last_seen_at = now(), updated_at = now()
           WHERE id = $1`,
        [
          mod.moduleId,
          hardwareId,
          role,
          transport,
          attached,
          battery,
          String(body.firmware ?? ''),
          rssi,
          uptime,
          Boolean(body.gateway),
          neighbors.length,
          ip,
        ],
      );
      await q('DELETE FROM module_neighbors WHERE module_id = $1', [mod.moduleId]);
      for (const n of neighbors.slice(0, 50)) {
        const neighbor = str(n.uuid ?? '', 'uuid', { max: 64 }).toLowerCase();
        if (!neighbor) continue;
        await q(
          `INSERT INTO module_neighbors (module_id, neighbor_uuid, rssi, channel, has_gateway)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            mod.moduleId,
            neighbor,
            Number(n.rssi ?? 0) | 0,
            str(n.channel ?? 'ble', 'channel', { max: 8 }),
            Boolean(n.hasGateway),
          ],
        );
      }
    });

    publish(mod.ownerId, {
      type: 'module_status',
      moduleId: mod.moduleId,
      hardwareId: mod.hardwareId,
      publicId,
      status: 'online',
      online: true,
      role,
      transport,
      attached,
      battery,
      rssi,
      uptime,
      firmware: String(body.firmware ?? ''),
      neighbors: neighbors.length,
    });

    const owner = await one<{ email: string }>('SELECT email FROM users WHERE id = $1', [mod.ownerId]);
    const mesh = meshPublicConfig(await getMeshConfig());
    return reply.send({
      ok: true,
      ownerEmail: owner?.email ?? '',
      intervalSec: 60,
      mesh: {
        ssid: mesh.ssid,
        channel: mesh.channel,
        loraFreqMhz: mesh.loraFreqMhz,
        loraSf: mesh.loraSf,
        loraBwKhz: mesh.loraBwKhz,
        wifiHops: mesh.wifiHops,
        loraHops: mesh.loraHops,
      },
      publicId,
      blocked: false,
      // Активное OTA-задание: модуль с Wi-Fi забирает образ сам.
      ota: await activeOtaJob(mod.moduleId),
    });
  });

  /** Соседи модуля (для экрана «Сеть»). */
  app.get('/modules/neighbors', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const rows = await query(
      `SELECT mn.neighbor_uuid, mn.rssi, mn.channel, mn.has_gateway, mn.seen_at
         FROM module_neighbors mn
         JOIN modules m ON m.id = mn.module_id
        WHERE m.owner_id = $1
        ORDER BY mn.rssi DESC LIMIT 50`,
      [me],
    );
    return reply.send(rows);
  });

  // Дренаж mesh_inbox: сообщения, принятые от шлюза, но не сохранённые
  // (например, старый конверт без objectId), периодически пробуем дописать.
  const drainQueuedRelay = async () => {
    const queued = await query<{
      id: string;
      owner_id: string;
      module_id: string;
      chat_id: string;
      packet_id: string;
      envelope: unknown;
    }>(
      `SELECT id, owner_id, module_id, chat_id, packet_id, envelope
         FROM mesh_inbox
        WHERE status = 'queued' AND chat_id IS NOT NULL
          AND created_at > now() - interval '7 days'
        ORDER BY created_at ASC LIMIT 20`,
    );
    for (const row of queued) {
      let envelope: Record<string, unknown> = {};
      try {
        envelope =
          typeof row.envelope === 'string'
            ? (JSON.parse(row.envelope) as Record<string, unknown>)
            : (row.envelope as Record<string, unknown>);
      } catch {
        continue;
      }
      const ok = await persistRelayMessage(
        row.owner_id,
        row.module_id,
        row.chat_id,
        row.packet_id,
        envelope ?? {},
      ).catch(() => false);
      if (ok) {
        await query(
          "UPDATE mesh_inbox SET status = 'processed', processed_at = now() WHERE id = $1",
          [row.id],
        ).catch(() => undefined);
      }
    }
  };
  const drainTimer = setInterval(() => void drainQueuedRelay().catch(() => undefined), 30_000);
  drainTimer.unref?.();
  const drainStart = setTimeout(() => void drainQueuedRelay().catch(() => undefined), 5_000);
  drainStart.unref?.();
  app.addHook('onClose', async () => {
    clearInterval(drainTimer);
    clearTimeout(drainStart);
  });
};

/** nonce из header конверта (для pending-очереди шлюза). */
function extractNonce(header: unknown): string {
  if (header && typeof header === 'object' && typeof (header as { nonce?: unknown }).nonce === 'string') {
    return String((header as { nonce: string }).nonce);
  }
  return '';
}

export default moduleRoutes;
