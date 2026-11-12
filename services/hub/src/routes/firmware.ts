/**
 * Серверная сборка прошивок ESP32 по конфигурации из визарда.
 *
 * Hub не компилирует сам: он валидирует конфиг, создаёт запись истории,
 * асинхронно дергает build-сервис (arduino-cli), сохраняет .bin в tmp и
 * отдаёт клиенту статус для поллинга.
 */
import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { signToken } from '../crypto.js';
import { badRequest, log, notFound, rateLimit, serviceUnavailable } from '../util.js';
import { getMeshConfig } from './network.js';

/* ------------------------------------------------------------- конфиг ----- */

type FirmwareBoard = 'esp32c3' | 'esp32' | 'esp32s3';
type FirmwareRole = 'gateway' | 'repeater' | 'wearable';
type FirmwareConnectivity = 'wifi' | 'wifi_lora' | 'lora';
type LoraChip = 'sx1278' | 'sx1276' | 'sx1262';

interface LoraPins {
  sck: number;
  miso: number;
  mosi: number;
  cs: number;
  rst: number;
  dio0: number;
  busy?: number;
}

interface FirmwareConfig {
  board: FirmwareBoard;
  role: FirmwareRole;
  connectivity: FirmwareConnectivity;
  wifi?: { ssid: string; password: string };
  /**
   * Глобальная скрытая mesh-сеть (одна для всех модулей). Клиент эти
   * значения не присылает — Hub подставляет их из singleton `mesh_config`
   * перед сборкой. Пароль уходит только в прошивку, не в HTTP-ответы.
   */
  mesh?: {
    ssid: string;
    password: string;
    networkId: string;
    hidden: boolean;
    channel: number;
    loraFreqMhz: number;
    loraSf: number;
    loraBwKhz: number;
    wifiHops: number;
    loraHops: number;
  };
  hubUrl?: string;
  moduleToken?: string;
  claimToken?: string;
  lora?: {
    chip: LoraChip;
    /** Значение задаёт сервер (глобальная сеть), клиентское перезаписывается. */
    frequencyMhz: number;
    spreadingFactor: number;
    bandwidthKhz: 125 | 250 | 500;
    syncWord: number;
    pins: LoraPins;
  };
  battery?: { enabled: boolean; pin: number; ratio: number; intervalSec: number };
  ota?: boolean;
}

const BOARDS: FirmwareBoard[] = ['esp32c3', 'esp32', 'esp32s3'];
const ROLES: FirmwareRole[] = ['gateway', 'repeater', 'wearable'];
const CONNECTIVITY: FirmwareConnectivity[] = ['wifi', 'wifi_lora', 'lora'];
const LORA_CHIPS: LoraChip[] = ['sx1278', 'sx1276', 'sx1262'];
const LORA_DEFAULT_PINS: Record<FirmwareBoard, LoraPins & { chip: LoraChip }> = {
  esp32c3: { sck: 4, miso: 5, mosi: 6, cs: 7, rst: 3, dio0: 2, busy: 10, chip: 'sx1262' },
  esp32: { sck: 18, miso: 19, mosi: 23, cs: 5, rst: 14, dio0: 26, busy: 27, chip: 'sx1278' },
  esp32s3: { sck: 12, miso: 13, mosi: 11, cs: 10, rst: 9, dio0: 8, busy: 7, chip: 'sx1262' },
};
// 869.525 — глобальная частота Kinto; остальные оставлены для
// совместимости со старым визардом (значение всё равно перезапишет сервер).
const LORA_FREQS = [433, 868, 869.525, 915];
const LORA_BANDWIDTHS = [125, 250, 500];
const PIN_MAX = 48;

/** Проверка целого числа в диапазоне. */
function intIn(value: unknown, field: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${field}_invalid`);
  return n;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`${field}_invalid`);
  if (value.length > max) throw badRequest(`${field}_too_long`);
  return value;
}

function boolValue(value: unknown, field: string, def: boolean): boolean {
  if (value === undefined || value === null) return def;
  if (typeof value !== 'boolean') throw badRequest(`${field}_invalid`);
  return value;
}

/**
 * Валидирует и нормализует конфигурацию прошивки.
 * Возвращает только известные поля (защита от мусора в jsonb).
 */
function validateConfig(raw: unknown): FirmwareConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('config_required');
  const b = raw as Record<string, any>;

  if (!BOARDS.includes(b.board)) throw badRequest('board_invalid');
  if (!ROLES.includes(b.role)) throw badRequest('role_invalid');
  if (!CONNECTIVITY.includes(b.connectivity)) throw badRequest('connectivity_invalid');

  const out: FirmwareConfig = {
    board: b.board as FirmwareBoard,
    role: b.role as FirmwareRole,
    connectivity: b.connectivity as FirmwareConnectivity,
  };
  // Wearable не поднимает STA/Wi-Fi (только BLE до телефона + LoRa до шлюза),
  // иначе он зависает в "sta is connecting" и не запускает mesh.
  if (out.role === 'wearable') out.connectivity = 'lora';
  else if (out.connectivity === 'wifi') out.connectivity = 'wifi_lora';

  if (b.wifi !== undefined) {
    if (!b.wifi || typeof b.wifi !== 'object') throw badRequest('wifi_invalid');
    const ssid = optionalString(b.wifi.ssid, 'wifi.ssid', 32) ?? '';
    const password = optionalString(b.wifi.password, 'wifi.password', 64) ?? '';
    if (ssid.length === 0) throw badRequest('wifi_ssid_required');
    out.wifi = { ssid, password };
  }

  // Mesh-сеть аккаунта клиент присылать не должен: источник истины — БД.
  // Поле принимаем только чтобы отличить «не прислали» от «прислали мусор»;
  // значения всё равно перезапишет сервер (см. POST /firmware/build).
  if (b.mesh !== undefined && (typeof b.mesh !== 'object' || b.mesh === null || Array.isArray(b.mesh))) {
    throw badRequest('mesh_invalid');
  }

  const hubUrl = optionalString(b.hubUrl, 'hubUrl', 300);
  if (hubUrl !== undefined) {
    if (hubUrl.length > 0 && !/^https?:\/\/[^\s]+$/i.test(hubUrl)) throw badRequest('hubUrl_invalid');
    // Заменяем известные нерабочие домены (Cloudflare 301 / парковка) прямым Hub.
    out.hubUrl = /(^|\/\/)(api\.)?(kinto\.is-a\.dev|kinto\.io|api\.kinto\.io|swarmgram\.is-a\.dev)/i.test(hubUrl)
      ? 'http://150.251.143.212:8080'
      : hubUrl.replace(/\/+$/, '');
  } else {
    out.hubUrl = 'http://150.251.143.212:8080';
  }

  const moduleToken = optionalString(b.moduleToken, 'moduleToken', 4096);
  if (moduleToken !== undefined) out.moduleToken = moduleToken;
  const claimToken = optionalString(b.claimToken, 'claimToken', 4096);
  if (claimToken !== undefined) out.claimToken = claimToken;

  // Новый визард не спрашивает пины/частоту: используем глобальный профиль
  // LoRa и рекомендуемые пины платы. Клиентские значения не обязательны.
  // LoRa-параметры добавляем всегда: connectivity после нормализации — wifi_lora/lora.
  {
    const l = (b.lora && typeof b.lora === 'object' ? b.lora : {}) as Record<string, any>;
    const defaults = LORA_DEFAULT_PINS[out.board];
    if (l.chip !== undefined && !LORA_CHIPS.includes(l.chip)) throw badRequest('lora.chip_invalid');
    const p = (l.pins && typeof l.pins === 'object' ? l.pins : {}) as Record<string, unknown>;
    const pin = (value: unknown, fallback: number, field: string): number =>
      value === undefined || value === null ? fallback : intIn(value, field, 0, PIN_MAX);
    const pins: LoraPins = {
      sck: pin(p.sck, defaults.sck, 'lora.pins.sck'),
      miso: pin(p.miso, defaults.miso, 'lora.pins.miso'),
      mosi: pin(p.mosi, defaults.mosi, 'lora.pins.mosi'),
      cs: pin(p.cs, defaults.cs, 'lora.pins.cs'),
      rst: pin(p.rst, defaults.rst, 'lora.pins.rst'),
      dio0: pin(p.dio0, defaults.dio0, 'lora.pins.dio0'),
      busy: pin(p.busy, defaults.busy ?? -1, 'lora.pins.busy'),
    };
    out.lora = {
      chip: (l.chip as LoraChip) || defaults.chip,
      frequencyMhz: 869.525,
      spreadingFactor: 9,
      bandwidthKhz: 125,
      syncWord: 0x12,
      pins,
    };
  }

  if (b.battery !== undefined) {
    if (!b.battery || typeof b.battery !== 'object') throw badRequest('battery_invalid');
    const bt = b.battery as Record<string, any>;
    const ratio = Number(bt.ratio);
    if (!Number.isFinite(ratio) || ratio < 1 || ratio > 10) throw badRequest('battery.ratio_invalid');
    out.battery = {
      enabled: boolValue(bt.enabled, 'battery.enabled', true),
      pin: intIn(bt.pin, 'battery.pin', 0, PIN_MAX),
      ratio,
      intervalSec: intIn(bt.intervalSec, 'battery.intervalSec', 10, 86_400),
    };
  }

  if (b.ota !== undefined) out.ota = boolValue(b.ota, 'ota', false);

  return out;
}

/* ------------------------------------------------------------- строки ----- */

interface BuildRow {
  id: string;
  user_id: string;
  status: string;
  config: FirmwareConfig;
  version: string;
  size_bytes: number;
  sha256: string;
  log: string;
  bin_path: string;
  app_path: string | null;
  app_sha256: string | null;
  app_size_bytes: number | null;
  merged: boolean;
  progress: number;
  phase: string;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Публичное представление сборки (camelCase для клиента). */
function toDto(row: BuildRow) {
  return {
    id: row.id,
    status: row.status,
    version: row.version,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    log: row.log,
    config: row.config,
    merged: row.merged === true,
    progress: Number(row.progress ?? 0),
    phase: row.phase || 'queued',
    startedAt: row.started_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const BUILD_COLUMNS =
  'id, user_id, status, config, version, size_bytes, sha256, log, bin_path, app_path, app_sha256, app_size_bytes, merged, progress, phase, started_at, created_at, updated_at';

/**
 * Помечает зависшие сборки (после перезапуска Hub/сборщика) как failed.
 * Порог — 10 минут: дольше сборка жить не должна (таймаут builder/Hub 5 мин).
 */
async function failStaleBuilds(userId?: string): Promise<void> {
  await query(
    `UPDATE firmware_builds
        SET status = 'failed',
            phase = 'timeout',
            progress = 100,
            log = CASE WHEN log = '' THEN '[hub] build timed out' ELSE log || E'\n[hub] build timed out' END,
            updated_at = now()
      WHERE status IN ('queued', 'building')
        AND updated_at < now() - interval '35 minutes'
        ${userId ? 'AND user_id = $1' : ''}`,
    userId ? [userId] : [],
  ).catch(() => undefined);
}

/* ------------------------------------------------------------- сборка ----- */

interface BuilderResponse {
  ok?: boolean;
  error?: string;
  binBase64?: string;
  size?: number;
  sha256?: string;
  appBase64?: string;
  appSize?: number;
  appSha256?: string;
  version?: string;
  log?: string;
  merged?: boolean;
}

function builderUrl(): string {
  return (process.env.FIRMWARE_BUILDER_URL || 'http://firmware-builder:8090').replace(/\/+$/, '');
}

interface BuilderHealth {
  ok?: boolean;
  core?: boolean;
  freeMb?: number | null;
  coreVersion?: string | null;
  boards?: string[];
}

/**
 * Быстрая проверка build-сервиса. Возвращает null, если он недоступен
 * (не запущен / выключен профилем `firmware` в compose).
 */
async function builderHealth(): Promise<BuilderHealth | null> {
  try {
    const res = await fetch(`${builderUrl()}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return (await res.json()) as BuilderHealth;
  } catch {
    return null;
  }
}

async function setBuildFailed(id: string, logText: string, phase = 'failed'): Promise<void> {
  await query(
    `UPDATE firmware_builds
        SET status = 'failed', phase = $3, progress = 100, log = $2, updated_at = now()
      WHERE id = $1`,
    [id, logText.slice(0, 100_000), phase],
  ).catch((e) => log('error', 'firmware_build_update_failed', { id, error: e instanceof Error ? e.message : String(e) }));
}

/** Таймаут запроса к builder. Сборка дольше 5 минут считается зависшей. */
const BUILD_HTTP_TIMEOUT_MS = 1_500_000;
/** Как часто Hub пишет прогресс в БД (клиент поллит каждые 2 с). */
const PROGRESS_TICK_MS = 4_500;

const BUILD_TIMEOUT_MESSAGE =
  'Сборка превысила 5 минут и была прервана по таймауту. Сборщик мог зависнуть — попробуйте ещё раз; ' +
  'если ошибка повторяется, проверьте firmware-builder (место на диске и процесс arduino-cli).';

/** Фаза сборки по времени с её начала. */
function phaseForElapsed(elapsedMs: number): string {
  if (elapsedMs >= 80_000) return 'finalizing';
  if (elapsedMs >= 40_000) return 'linking';
  if (elapsedMs >= 10_000) return 'compiling';
  return 'preparing';
}

/**
 * Плавный прогресс 0..90 по времени: подготовка 0–10, компиляция 10–50,
 * линковка 50–75, финализация 75–90 (за оставшиеся ~220 с). Значение
 * монотонное, поэтому progress никогда не убывает.
 */
function progressForElapsed(elapsedMs: number): number {
  const sec = Math.max(0, elapsedMs) / 1000;
  if (sec < 10) return Math.round((sec / 10) * 10);
  if (sec < 40) return Math.round(10 + ((sec - 10) / 30) * 40);
  if (sec < 80) return Math.round(50 + ((sec - 40) / 40) * 25);
  return Math.min(90, Math.round(75 + ((sec - 80) / 220) * 15));
}

/**
 * Фоновая сборка: HTTP-запрос к builder, сохранение .bin, обновление БД.
 * Клиент поллит GET /v1/firmware/builds/:id.
 */
async function runBuild(id: string, cfg: FirmwareConfig): Promise<void> {
  const startedAt = Date.now();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastProgress = 0;
  let lastPhase = 'preparing';

  /** Обновляет progress/phase, не давая прогрессу откатиться назад. */
  const writeProgress = async (): Promise<void> => {
    const elapsed = Date.now() - startedAt;
    const progress = Math.max(lastProgress, progressForElapsed(elapsed));
    const phase = phaseForElapsed(elapsed);
    if (progress === lastProgress && phase === lastPhase) return;
    lastProgress = progress;
    lastPhase = phase;
    await query(
      `UPDATE firmware_builds
          SET progress = GREATEST(progress, $2), phase = $3, updated_at = now()
        WHERE id = $1 AND status = 'building'`,
      [id, progress, phase],
    ).catch((e) => log('warn', 'firmware_build_progress_failed', {
      id,
      error: e instanceof Error ? e.message : String(e),
    }));
  };

  try {
    await query(
      `UPDATE firmware_builds
          SET status = 'building', phase = 'preparing', progress = 0,
              started_at = now(), updated_at = now()
        WHERE id = $1`,
      [id],
    );

    ticker = setInterval(() => void writeProgress(), PROGRESS_TICK_MS);

    const res = await fetch(`${builderUrl()}/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
      // Таймаут builder тоже 5 минут; клиенту нужно успеть получить внятную ошибку.
      signal: AbortSignal.timeout(BUILD_HTTP_TIMEOUT_MS),
    });

    const data = (await res.json().catch(() => ({}))) as BuilderResponse;
    const logText = typeof data.log === 'string' ? data.log : '';

    if (!res.ok || data.ok !== true || !data.binBase64) {
      const reason = data.error || `builder_http_${res.status}`;
      throw Object.assign(new Error(reason), { buildLog: logText });
    }

    const bin = Buffer.from(data.binBase64, 'base64');
    if (!bin.length) throw Object.assign(new Error('binary_empty'), { buildLog: logText });

    // Контрольная сумма пересчитывается на стороне Hub — не доверяем слепо.
    const sha = createHash('sha256').update(bin).digest('hex');
    const dir = join(config.tmpDir, 'firmware');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}.bin`);
    await writeFile(file, bin);

    // app-only образ для OTA (Update.h). Если builder старый — поля пустые.
    const appBin = typeof data.appBase64 === 'string' && data.appBase64 ? Buffer.from(data.appBase64, 'base64') : null;
    let appFile: string | null = null;
    let appSha: string | null = null;
    if (appBin && appBin.length) {
      appSha = createHash('sha256').update(appBin).digest('hex');
      appFile = join(dir, `${id}.app.bin`);
      await writeFile(appFile, appBin);
    }

    await query(
      `UPDATE firmware_builds
          SET status = 'ready', phase = 'ready', progress = 100,              version = $2, size_bytes = $3, sha256 = $4, log = $5,
              bin_path = $6, merged = $7,
              app_path = $8, app_sha256 = $9, app_size_bytes = $10,
              updated_at = now()
        WHERE id = $1`,
      [
        id,
        String(data.version ?? ''),
        bin.length,
        sha,
        logText.slice(0, 100_000),
        file,
        data.merged === true,
        appFile,
        appSha,
        appBin?.length ?? 0,
      ],
    );
    log('info', 'firmware_build_ready', { id, size: bin.length, sha256: sha });
    // Последняя версия для доски — для бейджа «Доступно обновление».
    await query(
      `INSERT INTO firmware_releases (board, version, updated_at)
       VALUES ($1,$2,now())
       ON CONFLICT (board) DO UPDATE SET version = EXCLUDED.version, updated_at = now()`,
      [cfg.board, String(data.version ?? '')],
    ).catch(() => undefined);
  } catch (e) {
    const err = e as Error & { buildLog?: string };
    const buildLog = err.buildLog ?? '';
    const timedOut =
      err.name === 'TimeoutError' ||
      err.name === 'AbortError' ||
      /timeout|timed out|aborted/i.test(err.message || '');
    log('warn', 'firmware_build_failed', { id, error: err.message, timedOut });
    if (timedOut) {
      await setBuildFailed(id, BUILD_TIMEOUT_MESSAGE, 'timeout');
    } else {
      await setBuildFailed(id, buildLog || `builder: ${err.message}`);
    }
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

/* ------------------------------------------------------------- routes ----- */

const firmwareRoutes: FastifyPluginAsync = async (app) => {
  /** Последние версии прошивок по платам (для бейджа обновления). */
  app.get('/firmware/releases', { onRequest: [requireAuth()] }, async (_req, reply) => {
    const rows = await query<{ board: string; version: string; updated_at: string }>(
      'SELECT board, version, updated_at FROM firmware_releases ORDER BY board',
    );
    return reply.send(rows.map((r) => ({ board: r.board, version: r.version, updatedAt: r.updated_at })));
  });

  /** Создать сборку. Возвращает сразу queued; сборка идёт в фоне. */
  app.post('/firmware/build', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    // Лимит: 5 сборок в час на пользователя.
    rateLimit(`fw-build:${me}`, 5, 60 * 60 * 1000);

    const body = (req.body ?? {}) as { config?: unknown };
    const cfg = validateConfig(body.config);

    // Глобальная mesh-сеть: одна для всех модулей и аккаунтов.
    // Берём серверный singleton и жёстко перезаписываем конфиг — клиентские
    // значения mesh/lora-радио игнорируются, подменить сеть нельзя.
    const mesh = await getMeshConfig();
    cfg.mesh = {
      ssid: mesh.ssid,
      password: mesh.password,
      networkId: 'global',
      hidden: true,
      channel: mesh.channel,
      loraFreqMhz: mesh.loraFreqMhz,
      loraSf: mesh.loraSf,
      loraBwKhz: mesh.loraBwKhz,
      wifiHops: mesh.wifiHops,
      loraHops: mesh.loraHops,
    };
    // Модуль сам вернётся в аккаунт после перепрошивки: claim-токен
    // действует 10 лет и принимается только для system-owned модулей.
    const nowSec = Math.floor(Date.now() / 1000);
    cfg.claimToken = signToken(
      { sub: me, type: 'claim', iat: nowSec, exp: nowSec + 10 * 365 * 24 * 3600 },
      config.jwtSecret,
    );
    // LoRa-параметры радио — тоже серверные (sync word 0x12 = 18).
    if (cfg.lora) {
      cfg.lora.frequencyMhz = mesh.loraFreqMhz;
      cfg.lora.spreadingFactor = mesh.loraSf;
      cfg.lora.bandwidthKhz = mesh.loraBwKhz as 125 | 250 | 500;
      cfg.lora.syncWord = 0x12;    }

    // Честно сообщаем, что сборщик выключен/не готов, вместо «queued»,
    // который потом молча упадёт в фоне.
    const health = await builderHealth();
    if (!health) {
      throw serviceUnavailable(
        'Сборщик прошивок недоступен: сервис firmware-builder не запущен. ' +
          'Прошейте готовый .bin или включите сборщик на машине с достаточным диском.',
      );
    }
    if (health.core === false) {
      throw serviceUnavailable(
        'Сборщик прошивок ещё не готов: ядро ESP32 не установлено (обычно не хватило диска). ' +
          'Освободите место и перезапустите сборщик.',
      );
    }
    if (typeof health.freeMb === 'number' && health.freeMb >= 0 && health.freeMb < 300) {
      throw serviceUnavailable(
        `На сервере сборки мало свободного места (${health.freeMb} МБ). ` +
          'Освободите диск или используйте локальный сборщик.',
      );
    }

    const id = randomUUID();
    await query(
      `INSERT INTO firmware_builds (id, user_id, status, phase, progress, config)
       VALUES ($1, $2, 'queued', 'queued', 0, $3)`,
      [id, me, JSON.stringify(cfg)],
    );

    // Не блокируем HTTP: сборка живёт в фоне, клиент поллит статус.
    setImmediate(() => {
      void runBuild(id, cfg).catch((e) => {
        log('error', 'firmware_build_crashed', { id, error: e instanceof Error ? e.message : String(e) });
      });
    });

    return reply.status(202).send({ id, status: 'queued', progress: 0, phase: 'queued' });
  });

  /** Состояние build-сервиса: визард может показать честную плашку заранее. */
  app.get('/firmware/builder', { onRequest: [requireAuth()] }, async (_req, reply) => {
    const health = await builderHealth();
    if (!health) {
      return reply.send({ available: false, reason: 'unreachable', core: false, freeMb: null, boards: [] });
    }
    const core = health.core !== false;
    return reply.send({
      available: core,
      core,
      freeMb: typeof health.freeMb === 'number' ? health.freeMb : null,
      coreVersion: health.coreVersion ?? null,
      boards: Array.isArray(health.boards) ? health.boards : [],
      reason: core ? null : 'core_missing',
    });
  });

  /** История сборок пользователя (без тяжёлого лога и путей). */
  app.get('/firmware/builds', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    await failStaleBuilds(me);
    const rows = await query<BuildRow>(
      `SELECT ${BUILD_COLUMNS} FROM firmware_builds
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [me],
    );
    return reply.send(rows.map(toDto));
  });

  /** Детали одной сборки. */
  app.get('/firmware/builds/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    await failStaleBuilds(me);
    const { id } = req.params as { id: string };
    const row = await one<BuildRow>(
      `SELECT ${BUILD_COLUMNS} FROM firmware_builds WHERE id = $1 AND user_id = $2`,
      [id, me],
    );
    if (!row) throw notFound('firmware_build');
    return reply.send(toDto(row));
  });

  /** Скачивание готового .bin. */
  app.get('/firmware/builds/:id/download', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { id } = req.params as { id: string };
    const row = await one<BuildRow>(
      `SELECT ${BUILD_COLUMNS} FROM firmware_builds WHERE id = $1 AND user_id = $2`,
      [id, me],
    );
    if (!row) throw notFound('firmware_build');
    if (row.status !== 'ready' || !row.bin_path) throw notFound('firmware_binary');

    try {
      await stat(row.bin_path);
    } catch {
      throw notFound('firmware_binary');
    }

    const filename = `swarmgram-${row.version || id.slice(0, 8)}.bin`;
    reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${filename}"`);
    return reply.send(createReadStream(row.bin_path));
  });

  /** Удаление своей сборки (файл + запись). */
  app.delete('/firmware/builds/:id', { onRequest: [requireAuth()] }, async (req, reply) => {
    const me = req.auth!.userId;
    const { id } = req.params as { id: string };
    const row = await one<{ bin_path: string; app_path: string | null }>(
      `SELECT bin_path, app_path FROM firmware_builds WHERE id = $1 AND user_id = $2`,
      [id, me],
    );
    if (!row) throw notFound('firmware_build');

    if (row.bin_path) await unlink(row.bin_path).catch(() => undefined);
    if (row.app_path) await unlink(row.app_path).catch(() => undefined);
    await query('DELETE FROM firmware_builds WHERE id = $1', [id]);
    return reply.send({ ok: true });
  });
};

export default firmwareRoutes;
