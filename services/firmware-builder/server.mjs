/**
 * Kinto firmware builder.
 *
 * Минимальный HTTP-сервер (без внешних зависимостей):
 *   GET  /health  -> { ok, core }
 *   POST /build   -> JSON-конфиг визарда, генерирует скетч и запускает arduino-cli.
 *
 * Компиляция сериализуется по плате (очередь на board): две сборки одной
 * платы не идут параллельно, разные платы — могут. Результат кэшируется по
 * sha256(config) в /data/cache на 7 дней.
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, readdir, stat, statfs, copyFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || '/data';
const CACHE_DIR = join(DATA_DIR, 'cache');
const WORK_DIR = join(DATA_DIR, 'work');
const ARDUINO_DATA = join(DATA_DIR, 'arduino');
const ARDUINO_USER = join(DATA_DIR, 'arduino-user');
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

const BUILD_TIMEOUT_MS = 1_200_000;
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
// Минимум свободного места для компиляции (временные файлы ядра).
const MIN_BUILD_FREE_MB = Number(process.env.MIN_BUILD_FREE_MB || 300);
// Кэш результата проверки ядра: arduino-cli отвечает медленно.
const CORE_CHECK_TTL_MS = 30_000;

/** FQBN плат ESP32, поддерживаемых визардом. */
const FQBN = {
  esp32c3: 'esp32:esp32:esp32c3:PartitionScheme=min_spiffs',
  esp32: 'esp32:esp32:esp32:PartitionScheme=min_spiffs',
  esp32s3: 'esp32:esp32:esp32s3:PartitionScheme=min_spiffs',
};

const log = (msg, meta = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...meta }));
};

/* --------------------------------------------------------------- очередь -- */

/**
 * Очередь на каждую плату: две сборки одной платы не могут идти параллельно
 * (у них общий build-path и одни объектные файлы), но разные платы — могут.
 * Зависшая сборка одной платы не блокирует остальные.
 *
 * Ожидание в очереди ограничено: если задача не дождалась запуска за
 * BUILD_TIMEOUT_MS, она падает с build_queue_timeout (Hub получит ошибку,
 * а не будет ждать вечно).
 */
const boardQueues = new Map();

function enqueue(board, task, waitTimeoutMs = BUILD_TIMEOUT_MS) {
  const prev = boardQueues.get(board) ?? Promise.resolve();
  const enqueuedAt = Date.now();
  let cancelled = false;
  let timer = null;

  const waitGuard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      reject(new Error('build_queue_timeout'));
    }, waitTimeoutMs);
    // не держим процесс живым только из-за таймера очереди
    if (typeof timer.unref === 'function') timer.unref();
  });

  const job = (async () => {
    await prev.catch(() => undefined);
    if (cancelled) throw new Error('build_queue_timeout');
    if (timer) clearTimeout(timer);
    const waitedMs = Date.now() - enqueuedAt;
    if (waitedMs > 1000) log('build_dequeued', { board, waitedMs });
    return task();
  })();

  const run = Promise.race([job, waitGuard]);
  // Следующая задача этой платы ждёт реального завершения текущей работы,
  // даже если эта задача уже отвалилась по таймауту ожидания.
  const settle = job.then(() => undefined, () => undefined);
  boardQueues.set(board, settle);
  settle.then(() => {
    if (boardQueues.get(board) === settle) boardQueues.delete(board);
  });
  return run;
}

/* ------------------------------------------------------------------ utils -- */

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** Стабильная сериализация: одинаковый конфиг -> одинаковый ключ кэша. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Экранирование строки для C-макроса. */
function cString(value) {
  const s = String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  return `"${s}"`;
}

function cfgBoolean(value, def = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return def;
}

function num(value, def = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : def;
}

/* -------------------------------------------------------- config.h ---------- */

/**
 * Нормализует выбор связи из визарда: "Wi-Fi + LoRa", "wifi+lora",
 * "both" и т.п. -> "wifi_lora". Прошивка понимает только wifi/wifi_lora/lora.
 */
function normalizeConnectivity(value) {
  const s = String(value ?? 'wifi').trim().toLowerCase().replace(/[\s+\-/]+/g, '_');
  const hasLora = s.includes('lora');
  const hasWifi = s.includes('wifi') || s.includes('wi_fi');
  if (s === 'both') return 'wifi_lora';
  if (hasLora && hasWifi) return 'wifi_lora';
  if (hasLora) return 'lora';
  return 'wifi';
}

/** Генерирует config.h из JSON-конфигурации визарда. */
function generateConfigHeader(config, version) {
  const board = String(config.board || 'esp32');
  const role = String(config.role || 'gateway');
  const connectivity = normalizeConnectivity(config.connectivity);
  const wifi = config.wifi || config.gatewayWifi || {};
  const mesh = config.mesh || {};
  const lora = config.lora || null;
  const battery = config.battery || {};
  const useLora = connectivity === 'wifi_lora' || connectivity === 'lora';
  const useWifiMesh = connectivity !== 'lora';
  const battEnabled = cfgBoolean(battery.enabled, false) ? 1 : 0;

  // Пины LoRa по умолчанию: визард больше не спрашивает их вручную.
  const LORA_DEFAULTS = {
    esp32c3: { sck: 4, miso: 5, mosi: 6, cs: 7, rst: 3, dio0: 2, busy: 10, chip: 'sx1262' },
    esp32: { sck: 18, miso: 19, mosi: 23, cs: 5, rst: 14, dio0: 26, busy: 27, chip: 'sx1278' },
    esp32s3: { sck: 12, miso: 13, mosi: 11, cs: 10, rst: 9, dio0: 8, busy: 7, chip: 'sx1262' },
  };
  const defaults = LORA_DEFAULTS[board] || LORA_DEFAULTS.esp32c3;

  // Deep sleep имеет смысл только для носимых узлов с батареей.
  // OTA в deep sleep недоступна — см. комментарий в скетче.
  const deepSleep = battEnabled && role === 'wearable' ? 1 : 0;

  const pins = { ...defaults, ...(lora?.pins || {}) };
  const chip = lora?.chip || defaults.chip;
  const isSx1262 = chip === 'sx1262';

  const lines = [
    '// Автоматически сгенерировано build-сервисом Kinto. Не редактировать.',
    '#pragma once',
    '',
    `#define SG_FIRMWARE_VERSION ${cString(version)}`,
    `#define SG_BOARD ${cString(board)}`,
    `#define SG_ROLE ${cString(role)}`,
    `#define SG_CONNECTIVITY ${cString(connectivity)}`,
    `#define SG_IS_GATEWAY ${role === 'gateway' ? 1 : 0}`,
    `#define SG_IS_WEARABLE ${role === 'wearable' ? 1 : 0}`,
    `#define SG_USE_WIFI_MESH ${useWifiMesh ? 1 : 0}`,
    // Полный ESP-WIFI-MESH (ESP-IDF) пока выключен: API mesh_cfg_t в core 2.0.17
    // отличается, а сборка с ним не проходит. Fallback — скрытый AP + UDP mesh.
    `#define SG_USE_ESP_MESH 0`,
    // Роутер для шлюза (не mesh-сеть).
    `#define SG_WIFI_SSID ${cString(wifi.ssid ?? '')}`,
    `#define SG_WIFI_PASS ${cString(wifi.password ?? '')}`,
    // Единая глобальная скрытая mesh-сеть (сервер подставляет значения).
    `#define SG_MESH_SSID ${cString(mesh.ssid ?? 'SG-MESH')}`,
    `#define SG_MESH_PASS ${cString(mesh.password ?? 'sgmesh-2026-11-11-a7f3c9d2e6b14580')}`,
    `#define SG_MESH_ID ${cString(mesh.networkId ?? 'SG-MESH')}`,
    `#define SG_MESH_HIDDEN ${cfgBoolean(mesh.hidden, true) ? 1 : 0}`,
    `#define SG_MESH_CHANNEL ${num(mesh.channel, 11) | 0}`,
    `#define SG_WIFI_MAX_HOPS ${num(mesh.wifiHops, 14) | 0}`,
    `#define SG_LORA_MAX_HOPS ${num(mesh.loraHops, 12) | 0}`,
    // Mesh v2 (кластеры/border/handover/гибридный роутинг) включён по умолчанию.
    `#define SG_MESH_V2 ${cfgBoolean(mesh.v2, true) ? 1 : 0}`,
    `#define SG_HUB_URL ${cString(config.hubUrl || 'http://150.251.143.212:8080')}`,
    `#define SG_MODULE_TOKEN ${cString(config.moduleToken ?? '')}`,
    '',
    `#define SG_USE_LORA ${useLora ? 1 : 0}`,
    `#define SG_OTA ${cfgBoolean(config.ota, role !== 'wearable') ? 1 : 0}`,
    `#define SG_DEEP_SLEEP ${deepSleep}`,
    '',
  ];

  if (useLora) {
    lines.push(
      `#define SG_LORA_CHIP ${cString(chip)}`,
      `#define SG_LORA_CHIP_SX1262 ${isSx1262 ? 1 : 0}`,
      // Глобальный профиль LoRa (утверждён): 869.525 / SF9 / BW125 / CR5.
      `#define SG_LORA_FREQ 869.525`,
      `#define SG_LORA_SF 9`,
      `#define SG_LORA_BW 125.0`,
      `#define SG_LORA_CR 5`,
      `#define SG_LORA_SYNC 0x12`,
      `#define SG_LORA_POWER 17`,
      `#define SG_LORA_SCK ${num(pins.sck, defaults.sck) | 0}`,
      `#define SG_LORA_MISO ${num(pins.miso, defaults.miso) | 0}`,
      `#define SG_LORA_MOSI ${num(pins.mosi, defaults.mosi) | 0}`,
      `#define SG_LORA_CS ${num(pins.cs, defaults.cs) | 0}`,
      `#define SG_LORA_RST ${num(pins.rst, defaults.rst) | 0}`,
      `#define SG_LORA_DIO0 ${num(pins.dio0, defaults.dio0) | 0}`,
      `#define SG_LORA_BUSY ${num(pins.busy, defaults.busy) | 0}`,
      '',
    );
  }

  lines.push(
    `#define SG_BATT_ENABLED ${battEnabled}`,
    `#define SG_BATT_PIN ${num(battery.pin, 0) | 0}`,
    `#define SG_BATT_RATIO ${num(battery.ratio, 2.0)}`,
    `#define SG_LED_PIN ${config.ledPin !== undefined && config.ledPin !== null ? num(config.ledPin, -1) | 0 : -1}`,
    `#define SG_BATT_INTERVAL ${Math.max(10, num(battery.intervalSec, 300)) | 0}`,
    '',
  );

  return lines.join('\n');
}

/* ------------------------------------------------------------- компиляция -- */

async function arduinoCli(args, timeout = BUILD_TIMEOUT_MS) {
  try {
    return await execFileAsync('arduino-cli', args, {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        ARDUINO_DIRECTORIES_DATA: ARDUINO_DATA,
        ARDUINO_DIRECTORIES_USER: ARDUINO_USER,
      },
    });
  } catch (e) {
    // Сохраняем хвост компилятора: без него «ошибка сборки» бесполезна.
    const out = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}`.trim().slice(-4000);
    const err = new Error(`${e?.message ?? 'arduino-cli failed'}${out ? `\n${out}` : ''}`);
    err.name = e?.name ?? 'Error';
    throw err;
  }
}

async function hasEsp32Core() {
  try {
    const { stdout } = await arduinoCli(
      ['core', 'list', '--additional-urls', 'https://espressif.github.io/arduino-esp32/package_esp32_index.json'],
      20_000,
    );
    return /esp32:esp32/.test(stdout);
  } catch {
    return false;
  }
}

/** Кэшированная проверка ядра: /health дергается часто (Hub-префлайт). */
let coreCache = { value: false, at: 0 };
async function esp32CoreReady() {
  if (Date.now() - coreCache.at < CORE_CHECK_TTL_MS) return coreCache.value;
  const value = await hasEsp32Core();
  coreCache = { value, at: Date.now() };
  return value;
}

/** Свободное место на разделе с /data (МБ) либо null, если узнать не вышло. */
async function diskFreeMb() {
  try {
    const s = await statfs(DATA_DIR);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

/** Возвращает путь к прошивке .bin либо null. */
async function findBinary(outDir, sketchName) {
  let files;
  try {
    files = await readdir(outDir);
  } catch {
    return null;
  }
  const preferred = `${sketchName}.ino.bin`;
  if (files.includes(preferred)) return join(outDir, preferred);
  const inoBin = files.filter((f) => f.endsWith('.ino.bin'));
  if (inoBin.length) return join(outDir, inoBin[0]);
  const anyBin = files.filter((f) => extname(f) === '.bin');
  return anyBin.length ? join(outDir, anyBin[0]) : null;
}

const CHIP_NAME = { esp32c3: 'esp32c3', esp32: 'esp32', esp32s3: 'esp32s3' };

/** Рекурсивный поиск файла (flash_args лежит внутри build-path). */
async function findFileRecursive(dir, name, depth = 0) {
  if (depth > 8) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFileRecursive(join(dir, entry.name), name, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Рекурсивный поиск файла по суффиксу (build-path имена: *.bootloader.bin). */
async function findFileBySuffix(dir, suffix, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(suffix)) return join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFileBySuffix(join(dir, entry.name), suffix, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Путь/команда esptool из установленного ESP32 core (2.x script или 3.x binary). */
async function esptoolInvocation() {
  const base = join(ARDUINO_DATA, 'packages', 'esp32', 'tools', 'esptool_py');
  const versions = await readdir(base).catch(() => []);
  for (const version of versions.sort().reverse()) {
    const dir = join(base, version);
    for (const name of ['esptool', 'esptool.py']) {
      const candidate = join(dir, name);
      try {
        await stat(candidate);
        if (name === 'esptool') return { command: candidate, baseArgs: [], env: {} };
        return { command: 'python3', baseArgs: [candidate], env: {} };
      } catch {
        /* ищем дальше */
      }
    }
  }
  return null;
}

/**
 * Собирает единый merged.bin (bootloader + partitions + boot_app0 + app).
 * Именно его можно писать с адреса 0x0 из браузера; app-only .bin из
 * arduino-cli для этого не подходит.
 */
async function mergeBinary(board, buildDir, workDir) {
  const flashArgs = await findFileRecursive(buildDir, 'flash_args');
  let mode = 'dio';
  let freq = '80m';
  let size = '4MB';
  const parts = [];

  if (flashArgs) {
    const lines = (await readFile(flashArgs, 'utf8'))
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (line.startsWith('--flash_mode')) { mode = line.split(/\s+/)[1] || mode; continue; }
      if (line.startsWith('--flash_freq')) { freq = line.split(/\s+/)[1] || freq; continue; }
      if (line.startsWith('--flash_size')) { size = line.split(/\s+/)[1] || size; continue; }
      const match = /^(0x[0-9a-fA-F]+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const file = match[2].startsWith('/') ? match[2] : join(buildDir, match[2]);
      parts.push([match[1], file]);
    }
  }

  // arduino-cli не всегда пишет flash_args в --build-path: собираем
  // стандартную раскладку ESP32 (одинакова для C3/S3/классического ESP32).
  if (!parts.length) {
    const bootloader = await findFileBySuffix(buildDir, '.bootloader.bin');
    const partitions = await findFileBySuffix(buildDir, '.partitions.bin');
    const bootApp = (await findFileRecursive(buildDir, 'boot_app0.bin'))
      || (await findFileRecursive(ARDUINO_DATA, 'boot_app0.bin'));
    const app = (await findFileRecursive(buildDir, 'swarm_module.ino.bin'))
      || (await findFileBySuffix(buildDir, '.ino.bin'))
      || (await findBinary(buildDir, 'swarm_module'));
    if (!bootloader || !partitions || !bootApp || !app) {
      throw new Error(`flash_parts_missing:${[
        bootloader ? '' : 'bootloader',
        partitions ? '' : 'partitions',
        bootApp ? '' : 'boot_app0',
        app ? '' : 'app',
      ].filter(Boolean).join(',')}`);
    }
    parts.push(['0x0', bootloader], ['0x8000', partitions], ['0xe000', bootApp], ['0x10000', app]);
  }

  if (!parts.length) throw new Error('flash_args_empty');

  const tool = await esptoolInvocation();
  if (!tool) throw new Error('esptool_not_found');

  const out = join(workDir, 'merged.bin');
  const args = [
    ...tool.baseArgs,
    '--chip', CHIP_NAME[board] || 'esp32',
    'merge_bin',
    '-o', out,
    '--flash_mode', mode,
    '--flash_freq', freq,
    '--flash_size', size,
  ];
  for (const [address, file] of parts) args.push(address, file);

  const { stdout, stderr } = await execFileAsync(tool.command, args, {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      ...tool.env,
      ARDUINO_DIRECTORIES_DATA: ARDUINO_DATA,
      ARDUINO_DIRECTORIES_USER: ARDUINO_USER,
    },
  });

  const bin = await readFile(out);
  if (!bin.length) throw new Error('merged_binary_empty');
  return { bin, log: `${stdout}\n${stderr}`.trim() };
}

/** Собственно сборка: генерация скетча -> arduino-cli -> чтение .bin. */
async function compileFirmware(config, version) {
  const board = config.board;
  const fqbn = FQBN[board];
  if (!fqbn) throw new Error(`unsupported_board:${board}`);

  const template = await readFile(join(TEMPLATE_DIR, 'swarm_module.ino'), 'utf8');
  const work = join(WORK_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}`);
  const sketchDir = join(work, 'sketch', 'swarm_module');
  const outDir = join(work, 'out');
  // Постоянный build-path на плату: ядро и библиотеки компилируются один раз,
  // последующие сборки переиспользуют объектные файлы (важно для 1 vCPU).
  const buildDir = join(DATA_DIR, 'build', board);
  const sketchName = 'swarm_module';

  try {
    await mkdir(sketchDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });
    await writeFile(join(sketchDir, `${sketchName}.ino`), template, 'utf8');
    await writeFile(join(sketchDir, 'config.h'), generateConfigHeader(config, version), 'utf8');
    // mesh v2 core (cluster/border/маршрутизация/классификатор) кладём рядом
    // со скетчем: Arduino собирает .c/.h из корня скетча.
    const meshDir = join(TEMPLATE_DIR, 'mesh_v2');
    const meshFiles = await readdir(meshDir).catch(() => []);
    await Promise.all(
      meshFiles.map((name) => copyFile(join(meshDir, name), join(sketchDir, name)).catch(() => undefined)),
    );

    log('build_start', { board, fqbn, version });
    log('build_stage', { board, stage: 'compiling' });
    const compileArgs = [
      'compile',
      '--fqbn', fqbn,
      '--build-path', buildDir,
      '--output-dir', outDir,
      join(work, 'sketch', sketchName),
    ];
    let stdout = '';
    let stderr = '';
    try {
      ({ stdout, stderr } = await arduinoCli(compileArgs, BUILD_TIMEOUT_MS));
    } catch (firstError) {
      // Таймаут не повторяем: это не повреждённый кэш, а долгая компиляция.
      const message = String(firstError);
      if (/timed out|ETIMEDOUT|killed/i.test(message)) {
        await writeFile(join(DATA_DIR, 'last-build.log'), message).catch(() => undefined);
        throw firstError;
      }
      // Повреждённый incremental build — частая причина «ошибка сборки».
      log('build_retry', { board, error: message.slice(0, 300) });
      await writeFile(join(DATA_DIR, 'last-build.log'), message).catch(() => undefined);
      await rm(buildDir, { recursive: true, force: true }).catch(() => undefined);
      await mkdir(buildDir, { recursive: true });
      try {
        ({ stdout, stderr } = await arduinoCli(compileArgs, BUILD_TIMEOUT_MS));
      } catch (secondError) {
        await writeFile(join(DATA_DIR, 'last-build.log'), String(secondError)).catch(() => undefined);
        throw secondError;
      }
    }
    const compileLog = `${stdout}\n${stderr}`.trim();

    // Для браузерной прошивки нужен merged.bin с адреса 0x0.
    log('build_stage', { board, stage: 'merging' });
    const merged = await mergeBinary(board, buildDir, work);
    const binPath = await findBinary(outDir, sketchName);
    const output = [compileLog, merged.log, binPath ? `app: ${binPath}` : ''].filter(Boolean).join('\n');

    const bin = merged.bin;
    if (!bin.length) throw new Error('binary_empty');

    // OTA-образ: только приложение (без bootloader/partitions). Именно его
    // принимает Update.h на модуле.
    const appBin = binPath ? await readFile(binPath) : Buffer.alloc(0);

    return {
      bin,
      size: bin.length,
      sha256: sha256(bin),
      app: appBin,
      appSize: appBin.length,
      appSha256: appBin.length ? sha256(appBin) : '',
      log: output.slice(0, 64 * 1024),
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ----------------------------------------------------------------- кэш ----- */

async function readCache(key) {
  try {
    const file = join(CACHE_DIR, `${key}.json`);
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > CACHE_TTL_MS) return null;
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!data?.binBase64) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCache(key, payload) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify(payload), 'utf8');
  } catch (e) {
    log('cache_write_failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

/* ------------------------------------------------------------- HTTP -------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleBuild(config) {
  // v3: кэш учитывает версию шаблона, иначе изменения прошивки не попадают
  // в уже собранные конфигурации. Старые app-only записи игнорируются.
  const templateHash = sha256(await readFile(join(TEMPLATE_DIR, 'swarm_module.ino'), 'utf8')).slice(0, 16);
  const key = sha256(`merged4:${templateHash}:${stableStringify(config)}`);
  // Версия отражает исходники, а не конфигурацию: у всех модулей одной платы,
  // собранных из текущего шаблона, версия одинаковая — это нужно для OTA-бейджа.
  const version = `1.0.0-${templateHash.slice(0, 8)}`;

  const cached = await readCache(key);
  if (cached) {
    log('build_cache_hit', { key, version: cached.version });
    return {
      ok: true,
      binBase64: cached.binBase64,
      size: cached.size,
      sha256: cached.sha256,
      version: cached.version,
      merged: cached.merged === true,
      appBase64: cached.appBase64,
      appSize: cached.appSize,
      appSha256: cached.appSha256,
      log: `${cached.log ? `${cached.log}\n` : ''}[builder] взято из кэша`,
      cached: true,
    };
  }

  const result = await compileFirmware(config, version);
  const payload = {
    binBase64: result.bin.toString('base64'),
    size: result.size,
    sha256: result.sha256,
    version,
    merged: true,
    appBase64: result.app.toString('base64'),
    appSize: result.appSize,
    appSha256: result.appSha256,
    log: result.log,
  };
  await writeCache(key, payload);

  return { ok: true, ...payload, cached: false };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    const [core, freeMb] = await Promise.all([esp32CoreReady(), diskFreeMb()]);
    return sendJson(res, 200, {
      ok: true,
      core,
      freeMb,
      coreVersion: process.env.ESP32_CORE_VERSION || null,
      boards: String(process.env.ESP32_BOARDS || 'esp32c3').split(',').map((b) => b.trim()).filter(Boolean),
    });
  }

  if (req.method === 'POST' && url.pathname === '/build') {
    let config;
    try {
      const raw = await readBody(req);
      config = JSON.parse(raw || '{}');
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return sendJson(res, 400, { ok: false, error: `bad_request:${error}`, log: '' });
    }

    if (!config || typeof config !== 'object' || !config.board) {
      return sendJson(res, 400, { ok: false, error: 'config_required', log: '' });
    }

    // Префлайт: понятная причина вместо загадочного таймаута компиляции.
    const coreReady = await esp32CoreReady();
    if (!coreReady) {
      return sendJson(res, 503, {
        ok: false,
        error: 'esp32_core_missing',
        log:
          'Ядро ESP32 не установлено в build-сервисе. Обычно это значит, что на диске не хватило места ' +
          'при первом запуске. Освободите ~4 ГБ и перезапустите контейнер (или используйте сборщик на другой машине).',
      });
    }
    const installedBoards = String(process.env.ESP32_BOARDS || 'esp32c3')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    if (!installedBoards.includes(config.board)) {
      return sendJson(res, 422, {
        ok: false,
        error: 'board_not_installed',
        log:
          `Плата "${config.board}" не установлена в сборщике. Доступны: ${installedBoards.join(', ') || 'нет'}. ` +
          'Добавьте плату в ESP32_BOARDS и перезапустите сборщик на машине с достаточным диском.',
      });
    }
    const freeMb = await diskFreeMb();
    if (freeMb !== null && freeMb < MIN_BUILD_FREE_MB) {
      return sendJson(res, 503, {
        ok: false,
        error: 'insufficient_disk_space',
        log: `Недостаточно свободного места для сборки: ${freeMb} МБ (нужно минимум ${MIN_BUILD_FREE_MB} МБ).`,
      });
    }

    try {
      const result = await enqueue(config.board, () => handleBuild(config));
      return sendJson(res, 200, result);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const logText = e && typeof e === 'object' && 'stdout' in e
        ? `${e.stdout || ''}\n${e.stderr || ''}`.trim().slice(0, 64 * 1024)
        : '';
      log('build_failed', { error });
      return sendJson(res, 422, { ok: false, error, log: logText });
    }
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
});

await mkdir(CACHE_DIR, { recursive: true }).catch(() => undefined);
await mkdir(WORK_DIR, { recursive: true }).catch(() => undefined);

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;

server.listen(PORT, '0.0.0.0', () => {
  log('builder_listening', { port: PORT, dataDir: DATA_DIR });
});
