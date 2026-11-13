/**
 * Klinto firmware builder.
 *
 * РњРёРЅРёРјР°Р»СЊРЅС‹Р№ HTTP-СЃРµСЂРІРµСЂ (Р±РµР· РІРЅРµС€РЅРёС… Р·Р°РІРёСЃРёРјРѕСЃС‚РµР№):
 *   GET  /health  -> { ok, core }
 *   POST /build   -> JSON-РєРѕРЅС„РёРі РІРёР·Р°СЂРґР°, РіРµРЅРµСЂРёСЂСѓРµС‚ СЃРєРµС‚С‡ Рё Р·Р°РїСѓСЃРєР°РµС‚ arduino-cli.
 *
 * РљРѕРјРїРёР»СЏС†РёСЏ СЃРµСЂРёР°Р»РёР·СѓРµС‚СЃСЏ РїРѕ РїР»Р°С‚Рµ (РѕС‡РµСЂРµРґСЊ РЅР° board): РґРІРµ СЃР±РѕСЂРєРё РѕРґРЅРѕР№
 * РїР»Р°С‚С‹ РЅРµ РёРґСѓС‚ РїР°СЂР°Р»Р»РµР»СЊРЅРѕ, СЂР°Р·РЅС‹Рµ РїР»Р°С‚С‹ вЂ” РјРѕРіСѓС‚. Р РµР·СѓР»СЊС‚Р°С‚ РєСЌС€РёСЂСѓРµС‚СЃСЏ РїРѕ
 * sha256(config) РІ /data/cache РЅР° 7 РґРЅРµР№.
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, readdir, stat, statfs, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
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
/** Portable mesh core (canonical copy lives in firmware/klinto_core). */
const CORE_DIR = (() => {
  if (process.env.KLINTO_CORE_DIR) return process.env.KLINTO_CORE_DIR;
  const local = join(dirname(fileURLToPath(import.meta.url)), 'klinto_core');
  if (existsSync(local)) return local; // Docker image /app/klinto_core
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'firmware', 'klinto_core');
})();

// РџРѕР»РЅР°СЏ СЃР±РѕСЂРєР° СЏРґСЂР° ESP32 РЅР° 1 vCPU Р·Р°РЅРёРјР°РµС‚ ~20-25 РјРёРЅСѓС‚. 20 РјРёРЅСѓС‚ вЂ”
// РіР°СЂР°РЅС‚РёСЂРѕРІР°РЅРЅС‹Р№ С‚Р°Р№РјР°СѓС‚, РїРѕСЃР»Рµ РєРѕС‚РѕСЂРѕРіРѕ РѕСЃС‚Р°С‘С‚СЃСЏ РїСѓСЃС‚РѕР№ output-dir.
const BUILD_TIMEOUT_MS = 2_400_000;
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
// РњРёРЅРёРјСѓРј СЃРІРѕР±РѕРґРЅРѕРіРѕ РјРµСЃС‚Р° РґР»СЏ РєРѕРјРїРёР»СЏС†РёРё (РІСЂРµРјРµРЅРЅС‹Рµ С„Р°Р№Р»С‹ СЏРґСЂР°).
const MIN_BUILD_FREE_MB = Number(process.env.MIN_BUILD_FREE_MB || 300);
// РљСЌС€ СЂРµР·СѓР»СЊС‚Р°С‚Р° РїСЂРѕРІРµСЂРєРё СЏРґСЂР°: arduino-cli РѕС‚РІРµС‡Р°РµС‚ РјРµРґР»РµРЅРЅРѕ.
const CORE_CHECK_TTL_MS = 30_000;

/** FQBN РїР»Р°С‚ ESP32, РїРѕРґРґРµСЂР¶РёРІР°РµРјС‹С… РІРёР·Р°СЂРґРѕРј. */
const FQBN = {
  esp32c3: 'esp32:esp32:esp32c3:PartitionScheme=min_spiffs',
  esp32: 'esp32:esp32:esp32:PartitionScheme=min_spiffs',
  esp32s3: 'esp32:esp32:esp32s3:PartitionScheme=min_spiffs',
};

/**
 * KMesh_v1 links the Wi-Fi + BLE + RadioLib stacks at once. On a 4 MB module
 * that exceeds the 1.9 MB OTA slot, so v3 uses the 3 MB single-app layout.
 * OTA for v3 requires an 8 MB module (partition scheme `max_app_8MB`).
 */
const FQBN_KMESH = {
  esp32c3: 'esp32:esp32:esp32c3:PartitionScheme=huge_app',
  esp32: 'esp32:esp32:esp32:PartitionScheme=huge_app',
  esp32s3: 'esp32:esp32:esp32s3:PartitionScheme=huge_app',
};

/**
 * Понятная версия прошивки: 1.1, 1.2, ... Файл firmware/klinto_core/VERSION —
 * единственный источник истины; сборка не зависит от git-хеша.
 */
function readFirmwareVersion() {
  const fromEnv = String(process.env.KLINTO_FIRMWARE_VERSION || '').trim();
  if (/^\d+\.\d+$/.test(fromEnv)) return fromEnv;
  try {
    const value = readFileSync(join(CORE_DIR, 'VERSION'), 'utf8').trim();
    if (/^\d+\.\d+$/.test(value)) return value;
  } catch {
    /* файл не скопирован — используем безопасный fallback */
  }
  return '1.0';
}

const FIRMWARE_VERSION = readFirmwareVersion();

const log = (msg, meta = {}) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...meta }));
};

/* --------------------------------------------------------------- РѕС‡РµСЂРµРґСЊ -- */

/**
 * РћС‡РµСЂРµРґСЊ РЅР° РєР°Р¶РґСѓСЋ РїР»Р°С‚Сѓ: РґРІРµ СЃР±РѕСЂРєРё РѕРґРЅРѕР№ РїР»Р°С‚С‹ РЅРµ РјРѕРіСѓС‚ РёРґС‚Рё РїР°СЂР°Р»Р»РµР»СЊРЅРѕ
 * (Сѓ РЅРёС… РѕР±С‰РёР№ build-path Рё РѕРґРЅРё РѕР±СЉРµРєС‚РЅС‹Рµ С„Р°Р№Р»С‹), РЅРѕ СЂР°Р·РЅС‹Рµ РїР»Р°С‚С‹ вЂ” РјРѕРіСѓС‚.
 * Р—Р°РІРёСЃС€Р°СЏ СЃР±РѕСЂРєР° РѕРґРЅРѕР№ РїР»Р°С‚С‹ РЅРµ Р±Р»РѕРєРёСЂСѓРµС‚ РѕСЃС‚Р°Р»СЊРЅС‹Рµ.
 *
 * РћР¶РёРґР°РЅРёРµ РІ РѕС‡РµСЂРµРґРё РѕРіСЂР°РЅРёС‡РµРЅРѕ: РµСЃР»Рё Р·Р°РґР°С‡Р° РЅРµ РґРѕР¶РґР°Р»Р°СЃСЊ Р·Р°РїСѓСЃРєР° Р·Р°
 * BUILD_TIMEOUT_MS, РѕРЅР° РїР°РґР°РµС‚ СЃ build_queue_timeout (Hub РїРѕР»СѓС‡РёС‚ РѕС€РёР±РєСѓ,
 * Р° РЅРµ Р±СѓРґРµС‚ Р¶РґР°С‚СЊ РІРµС‡РЅРѕ).
 */
// РћРґРёРЅ РѕР±С‰РёР№ queue: РЅР° 1 vCPU РґРІРµ РїР°СЂР°Р»Р»РµР»СЊРЅС‹Рµ СЃР±РѕСЂРєРё (esp32 + esp32c3)
// СЃСЉРµРґР°СЋС‚ РІСЃСЋ РїР°РјСЏС‚СЊ, Рё СЃРµСЂРІРµСЂ РїРµСЂРµСЃС‚Р°С‘С‚ РѕС‚РІРµС‡Р°С‚СЊ РїРѕ SSH/HTTP. РЎРѕР±РёСЂР°РµРј СЃС‚СЂРѕРіРѕ
// РїРѕСЃР»РµРґРѕРІР°С‚РµР»СЊРЅРѕ, РґР°Р¶Рµ РµСЃР»Рё Hub РїРѕРїСЂРѕСЃРёР» РЅРµСЃРєРѕР»СЊРєРѕ РїР»Р°С‚ РѕРґРЅРѕРІСЂРµРјРµРЅРЅРѕ.
const GLOBAL_BUILD_QUEUE = 'global';
const boardQueues = new Map();

function enqueue(board, task, waitTimeoutMs = BUILD_TIMEOUT_MS * 2) {
  const prev = boardQueues.get(GLOBAL_BUILD_QUEUE) ?? Promise.resolve();
  const enqueuedAt = Date.now();
  let cancelled = false;
  let timer = null;

  const waitGuard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      reject(new Error('build_queue_timeout'));
    }, waitTimeoutMs);
    // РЅРµ РґРµСЂР¶РёРј РїСЂРѕС†РµСЃСЃ Р¶РёРІС‹Рј С‚РѕР»СЊРєРѕ РёР·-Р·Р° С‚Р°Р№РјРµСЂР° РѕС‡РµСЂРµРґРё
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
  // РЎР»РµРґСѓСЋС‰Р°СЏ Р·Р°РґР°С‡Р° СЌС‚РѕР№ РїР»Р°С‚С‹ Р¶РґС‘С‚ СЂРµР°Р»СЊРЅРѕРіРѕ Р·Р°РІРµСЂС€РµРЅРёСЏ С‚РµРєСѓС‰РµР№ СЂР°Р±РѕС‚С‹,
  // РґР°Р¶Рµ РµСЃР»Рё СЌС‚Р° Р·Р°РґР°С‡Р° СѓР¶Рµ РѕС‚РІР°Р»РёР»Р°СЃСЊ РїРѕ С‚Р°Р№РјР°СѓС‚Сѓ РѕР¶РёРґР°РЅРёСЏ.
  const settle = job.then(() => undefined, () => undefined);
  boardQueues.set(GLOBAL_BUILD_QUEUE, settle);
  settle.then(() => {
    if (boardQueues.get(GLOBAL_BUILD_QUEUE) === settle) boardQueues.delete(GLOBAL_BUILD_QUEUE);
  });
  return run;
}

/* ------------------------------------------------------------------ utils -- */

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** РЎС‚Р°Р±РёР»СЊРЅР°СЏ СЃРµСЂРёР°Р»РёР·Р°С†РёСЏ: РѕРґРёРЅР°РєРѕРІС‹Р№ РєРѕРЅС„РёРі -> РѕРґРёРЅР°РєРѕРІС‹Р№ РєР»СЋС‡ РєСЌС€Р°. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Р­РєСЂР°РЅРёСЂРѕРІР°РЅРёРµ СЃС‚СЂРѕРєРё РґР»СЏ C-РјР°РєСЂРѕСЃР°. */
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
 * РќРѕСЂРјР°Р»РёР·СѓРµС‚ РІС‹Р±РѕСЂ СЃРІСЏР·Рё РёР· РІРёР·Р°СЂРґР°: "Wi-Fi + LoRa", "wifi+lora",
 * "both" Рё С‚.Рї. -> "wifi_lora". РџСЂРѕС€РёРІРєР° РїРѕРЅРёРјР°РµС‚ С‚РѕР»СЊРєРѕ wifi/wifi_lora/lora.
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

/** Р“РµРЅРµСЂРёСЂСѓРµС‚ config.h РёР· JSON-РєРѕРЅС„РёРіСѓСЂР°С†РёРё РІРёР·Р°СЂРґР°. */
function generateConfigHeader(config, version) {
  const board = String(config.board || 'esp32');
  const role = String(config.role || 'gateway');
  const connectivity = normalizeConnectivity(config.connectivity);
  const wifi = config.wifi || config.gatewayWifi || {};
  const mesh = config.mesh || {};
  const kmesh = config.kmesh || {};
  const lora = config.lora || null;
  const battery = config.battery || {};
  const useLora = connectivity === 'wifi_lora' || connectivity === 'lora';
  const useWifiMesh = connectivity !== 'lora';
  const battEnabled = cfgBoolean(battery.enabled, false) ? 1 : 0;

  // РџРёРЅС‹ LoRa РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ: РІРёР·Р°СЂРґ Р±РѕР»СЊС€Рµ РЅРµ СЃРїСЂР°С€РёРІР°РµС‚ РёС… РІСЂСѓС‡РЅСѓСЋ.
  const LORA_DEFAULTS = {
    esp32c3: { sck: 4, miso: 5, mosi: 6, cs: 7, rst: 3, dio0: 2, busy: 10, chip: 'sx1262' },
    esp32: { sck: 18, miso: 19, mosi: 23, cs: 5, rst: 14, dio0: 26, busy: 27, chip: 'sx1278' },
    esp32s3: { sck: 12, miso: 13, mosi: 11, cs: 10, rst: 9, dio0: 8, busy: 7, chip: 'sx1262' },
  };
  const defaults = LORA_DEFAULTS[board] || LORA_DEFAULTS.esp32c3;

  // Deep sleep РёРјРµРµС‚ СЃРјС‹СЃР» С‚РѕР»СЊРєРѕ РґР»СЏ РЅРѕСЃРёРјС‹С… СѓР·Р»РѕРІ СЃ Р±Р°С‚Р°СЂРµРµР№.
  // OTA РІ deep sleep РЅРµРґРѕСЃС‚СѓРїРЅР° вЂ” СЃРј. РєРѕРјРјРµРЅС‚Р°СЂРёР№ РІ СЃРєРµС‚С‡Рµ.
  const deepSleep = battEnabled && role === 'wearable' ? 1 : 0;

  const pins = { ...defaults, ...(lora?.pins || {}) };
  const chip = lora?.chip || defaults.chip;
  const isSx1262 = chip === 'sx1262';

  const useKmeshV1 = cfgBoolean(kmesh.v1, false);
  const tempMeshKey = String(kmesh.tempKey ?? config.mesh?.tempKey ?? config.tempMeshKey ?? '').replace(/[^0-9a-fA-F]/g, '').slice(0, 64);
  if (useKmeshV1 && tempMeshKey.length !== 64) {
    // All nodes of one mesh share this transport key. Never generate a
    // per-build key silently: that would isolate every device.
    throw new Error('temp_mesh_key_required');
  }

  const lines = [
    '// РђРІС‚РѕРјР°С‚РёС‡РµСЃРєРё СЃРіРµРЅРµСЂРёСЂРѕРІР°РЅРѕ build-СЃРµСЂРІРёСЃРѕРј Klinto. РќРµ СЂРµРґР°РєС‚РёСЂРѕРІР°С‚СЊ.',
    '#pragma once',
    '',
    `#define KL_FIRMWARE_VERSION ${cString(version)}`,
    `#define KL_BOARD ${cString(board)}`,
    `#define KL_ROLE ${cString(role)}`,
    // Гибридный носимый узел включён по умолчанию для wearable.
    `#define KL_HYBRID_PORTABLE ${role === 'wearable' ? 1 : 0}`,
    `#define KL_RELAY_ALLOWED 1`,
    `#define KL_CONNECTIVITY ${cString(connectivity)}`,
    `#define KL_IS_GATEWAY ${role === 'gateway' ? 1 : 0}`,
    `#define KL_IS_WEARABLE ${role === 'wearable' ? 1 : 0}`,
    `#define KL_USE_WIFI_MESH ${useWifiMesh ? 1 : 0}`,
    // РџРѕР»РЅС‹Р№ ESP-WIFI-MESH (ESP-IDF) РїРѕРєР° РІС‹РєР»СЋС‡РµРЅ: API mesh_cfg_t РІ core 2.0.17
    // РѕС‚Р»РёС‡Р°РµС‚СЃСЏ, Р° СЃР±РѕСЂРєР° СЃ РЅРёРј РЅРµ РїСЂРѕС…РѕРґРёС‚. Fallback вЂ” СЃРєСЂС‹С‚С‹Р№ AP + UDP mesh.
    `#define KL_USE_ESP_MESH 0`,
    // Р РѕСѓС‚РµСЂ РґР»СЏ С€Р»СЋР·Р° (РЅРµ mesh-СЃРµС‚СЊ).
    `#define KL_WIFI_SSID ${cString(wifi.ssid ?? '')}`,
    `#define KL_WIFI_PASS ${cString(wifi.password ?? '')}`,
    // Р•РґРёРЅР°СЏ РіР»РѕР±Р°Р»СЊРЅР°СЏ СЃРєСЂС‹С‚Р°СЏ mesh-СЃРµС‚СЊ (СЃРµСЂРІРµСЂ РїРѕРґСЃС‚Р°РІР»СЏРµС‚ Р·РЅР°С‡РµРЅРёСЏ).
    `#define KL_MESH_SSID ${cString(mesh.ssid ?? 'SG-MESH')}`,
    `#define KL_MESH_PASS ${cString(mesh.password ?? 'sgmesh-2026-11-11-a7f3c9d2e6b14580')}`,
    `#define KL_MESH_ID ${cString(mesh.networkId ?? 'SG-MESH')}`,
    // РЎРєСЂС‹С‚С‹Р№ SSID РЅРµРІРѕР·РјРѕР¶РЅРѕ РЅР°РґС‘Р¶РЅРѕ РЅР°Р№С‚Рё СЃРєР°РЅРёСЂРѕРІР°РЅРёРµРј: ESP32 РѕС‚РґР°С‘С‚
    // РїСѓСЃС‚РѕР№ SSID. Mesh-СЃРµС‚СЊ РІСЃРµРіРґР° РІРёРґРёРјР°СЏ вЂ” СЌС‚Рѕ РєСЂРёС‚РёС‡РЅРѕ РґР»СЏ РґРёСЃРєР°РІРµСЂРё.
    `#define KL_MESH_HIDDEN 0`,
    `#define KL_MESH_CHANNEL ${num(mesh.channel, 11) | 0}`,
    `#define KL_WIFI_MAX_HOPS ${num(mesh.wifiHops, 14) | 0}`,
    `#define KL_LORA_MAX_HOPS ${num(mesh.loraHops, 12) | 0}`,
    // Mesh v2 (РєР»Р°СЃС‚РµСЂС‹/border/handover/РіРёР±СЂРёРґРЅС‹Р№ СЂРѕСѓС‚РёРЅРі) РІРєР»СЋС‡С‘РЅ РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ.
    `#define KL_MESH_V2 ${cfgBoolean(mesh.v2, true) ? 1 : 0}`,
    // KMesh_v1: РЅРѕРІС‹Р№ dual-band СЃС‚РµРє (klinto_core). РўСЂРµР±СѓРµС‚ С€Р°Р±Р»РѕРЅР° v3.
    `#define KL_KMESH_V1 ${cfgBoolean(kmesh.v1, false) ? 1 : 0}`,
    `#define KL_HUB_URL ${cString(config.hubUrl || 'http://150.251.143.212:8080')}`,
    `#define KL_MODULE_TOKEN ${cString(config.moduleToken ?? '')}`,
    // Temporary mesh key (32 bytes hex). Never the user's permanent E2EE key.
    `#define KL_TEMP_MESH_KEY ${cString(tempMeshKey)}`,
    '',
    `#define KL_USE_LORA ${useLora ? 1 : 0}`,
    `#define KL_OTA ${cfgBoolean(config.ota, role !== 'wearable') ? 1 : 0}`,
    `#define KL_DEEP_SLEEP ${deepSleep}`,
    '',
  ];

  if (useLora) {
    lines.push(
      `#define KL_LORA_CHIP ${cString(chip)}`,
      `#define KL_LORA_CHIP_SX1262 ${isSx1262 ? 1 : 0}`,
      // Р“Р»РѕР±Р°Р»СЊРЅС‹Р№ РїСЂРѕС„РёР»СЊ LoRa (СѓС‚РІРµСЂР¶РґС‘РЅ): 869.525 / SF9 / BW125 / CR5.
      `#define KL_LORA_FREQ 869.525`,
      `#define KL_LORA_SF 9`,
      `#define KL_LORA_BW 125.0`,
      `#define KL_LORA_CR 5`,
      `#define KL_LORA_SYNC 0x12`,
      `#define KL_LORA_POWER 17`,
      `#define KL_LORA_SCK ${num(pins.sck, defaults.sck) | 0}`,
      `#define KL_LORA_MISO ${num(pins.miso, defaults.miso) | 0}`,
      `#define KL_LORA_MOSI ${num(pins.mosi, defaults.mosi) | 0}`,
      `#define KL_LORA_CS ${num(pins.cs, defaults.cs) | 0}`,
      `#define KL_LORA_RST ${num(pins.rst, defaults.rst) | 0}`,
      `#define KL_LORA_DIO0 ${num(pins.dio0, defaults.dio0) | 0}`,
      `#define KL_LORA_BUSY ${num(pins.busy, defaults.busy) | 0}`,
      '',
    );
  }

  lines.push(
    `#define KL_BATT_ENABLED ${battEnabled}`,
    `#define KL_BATT_PIN ${num(battery.pin, 0) | 0}`,
    `#define KL_BATT_CHARGING_PIN ${battery.chargingPin !== undefined && battery.chargingPin !== null ? num(battery.chargingPin, -1) | 0 : -1}`,
    `#define KL_BATT_RATIO ${num(battery.ratio, 2.0)}`,
    `#define KL_LED_PIN ${config.ledPin !== undefined && config.ledPin !== null ? num(config.ledPin, -1) | 0 : -1}`,
    `#define KL_BATT_INTERVAL ${Math.max(10, num(battery.intervalSec, 300)) | 0}`,
    '',
  );

  return lines.join('\n');
}

/* ------------------------------------------------------------- РєРѕРјРїРёР»СЏС†РёСЏ -- */

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
    // РЎРѕС…СЂР°РЅСЏРµРј С…РІРѕСЃС‚ РєРѕРјРїРёР»СЏС‚РѕСЂР°: Р±РµР· РЅРµРіРѕ В«РѕС€РёР±РєР° СЃР±РѕСЂРєРёВ» Р±РµСЃРїРѕР»РµР·РЅР°.
    const out = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}`.trim().slice(-4000);
    const killed = e?.killed ? '\n(killed by timeout)' : '';
    const err = new Error(`${e?.message ?? 'arduino-cli failed'}${killed}${out ? `\n${out}` : ''}`);
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

/** РљСЌС€РёСЂРѕРІР°РЅРЅР°СЏ РїСЂРѕРІРµСЂРєР° СЏРґСЂР°: /health РґРµСЂРіР°РµС‚СЃСЏ С‡Р°СЃС‚Рѕ (Hub-РїСЂРµС„Р»Р°Р№С‚). */
let coreCache = { value: false, at: 0 };
async function esp32CoreReady() {
  if (Date.now() - coreCache.at < CORE_CHECK_TTL_MS) return coreCache.value;
  const value = await hasEsp32Core();
  coreCache = { value, at: Date.now() };
  return value;
}

/** РЎРІРѕР±РѕРґРЅРѕРµ РјРµСЃС‚Рѕ РЅР° СЂР°Р·РґРµР»Рµ СЃ /data (РњР‘) Р»РёР±Рѕ null, РµСЃР»Рё СѓР·РЅР°С‚СЊ РЅРµ РІС‹С€Р»Рѕ. */
async function diskFreeMb() {
  try {
    const s = await statfs(DATA_DIR);
    return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

/** Р’РѕР·РІСЂР°С‰Р°РµС‚ РїСѓС‚СЊ Рє РїСЂРѕС€РёРІРєРµ .bin Р»РёР±Рѕ null. */
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

/** Р РµРєСѓСЂСЃРёРІРЅС‹Р№ РїРѕРёСЃРє С„Р°Р№Р»Р° (flash_args Р»РµР¶РёС‚ РІРЅСѓС‚СЂРё build-path). */
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

/** Р РµРєСѓСЂСЃРёРІРЅС‹Р№ РїРѕРёСЃРє С„Р°Р№Р»Р° РїРѕ СЃСѓС„С„РёРєСЃСѓ (build-path РёРјРµРЅР°: *.bootloader.bin). */
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

/** РџСѓС‚СЊ/РєРѕРјР°РЅРґР° esptool РёР· СѓСЃС‚Р°РЅРѕРІР»РµРЅРЅРѕРіРѕ ESP32 core (2.x script РёР»Рё 3.x binary). */
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
        /* РёС‰РµРј РґР°Р»СЊС€Рµ */
      }
    }
  }
  return null;
}

/**
 * РЎРѕР±РёСЂР°РµС‚ РµРґРёРЅС‹Р№ merged.bin (bootloader + partitions + boot_app0 + app).
 * РРјРµРЅРЅРѕ РµРіРѕ РјРѕР¶РЅРѕ РїРёСЃР°С‚СЊ СЃ Р°РґСЂРµСЃР° 0x0 РёР· Р±СЂР°СѓР·РµСЂР°; app-only .bin РёР·
 * arduino-cli РґР»СЏ СЌС‚РѕРіРѕ РЅРµ РїРѕРґС…РѕРґРёС‚.
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

  // arduino-cli РЅРµ РІСЃРµРіРґР° РїРёС€РµС‚ flash_args РІ --build-path: СЃРѕР±РёСЂР°РµРј
  // СЃС‚Р°РЅРґР°СЂС‚РЅСѓСЋ СЂР°СЃРєР»Р°РґРєСѓ ESP32 (РѕРґРёРЅР°РєРѕРІР° РґР»СЏ C3/S3/РєР»Р°СЃСЃРёС‡РµСЃРєРѕРіРѕ ESP32).
  if (!parts.length) {
    const bootloader = await findFileBySuffix(buildDir, '.bootloader.bin');
    const partitions = await findFileBySuffix(buildDir, '.partitions.bin');
    const bootApp = (await findFileRecursive(buildDir, 'boot_app0.bin'))
      || (await findFileRecursive(ARDUINO_DATA, 'boot_app0.bin'));
    const app = (await findFileRecursive(buildDir, 'klinto_module.ino.bin'))
      || (await findFileBySuffix(buildDir, '.ino.bin'))
      || (await findBinary(buildDir, 'klinto_module'));
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

/** РЎРѕР±СЃС‚РІРµРЅРЅРѕ СЃР±РѕСЂРєР°: РіРµРЅРµСЂР°С†РёСЏ СЃРєРµС‚С‡Р° -> arduino-cli -> С‡С‚РµРЅРёРµ .bin. */
async function compileFirmware(config, version) {
  const board = config.board;
  const useKmeshV1 = cfgBoolean(config.kmesh?.v1, false);
  const fqbn = (useKmeshV1 ? FQBN_KMESH : FQBN)[board];
  if (!fqbn) throw new Error(`unsupported_board:${board}`);

  const templateName = useKmeshV1 ? 'klinto_module_kmesh_v1.ino' : 'klinto_module_v2.ino';
  const template = await readFile(join(TEMPLATE_DIR, templateName), 'utf8');
  const work = join(WORK_DIR, `${Date.now()}-${randomBytes(4).toString('hex')}`);
  const sketchDir = join(work, 'sketch', 'klinto_module');
  const outDir = join(work, 'out');
  // РџРѕСЃС‚РѕСЏРЅРЅС‹Р№ build-path РЅР° РїР»Р°С‚Сѓ: СЏРґСЂРѕ Рё Р±РёР±Р»РёРѕС‚РµРєРё РєРѕРјРїРёР»РёСЂСѓСЋС‚СЃСЏ РѕРґРёРЅ СЂР°Р·,
  // РїРѕСЃР»РµРґСѓСЋС‰РёРµ СЃР±РѕСЂРєРё РїРµСЂРµРёСЃРїРѕР»СЊР·СѓСЋС‚ РѕР±СЉРµРєС‚РЅС‹Рµ С„Р°Р№Р»С‹ (РІР°Р¶РЅРѕ РґР»СЏ 1 vCPU).
  const buildDir = join(DATA_DIR, 'build', board);
  const sketchName = 'klinto_module';

  try {
    await mkdir(sketchDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });
    await writeFile(join(sketchDir, `${sketchName}.ino`), template, 'utf8');
    await writeFile(join(sketchDir, 'config.h'), generateConfigHeader(config, version), 'utf8');
    // mesh v2 core (cluster/border/РјР°СЂС€СЂСѓС‚РёР·Р°С†РёСЏ/РєР»Р°СЃСЃРёС„РёРєР°С‚РѕСЂ) РєР»Р°РґС‘Рј СЂСЏРґРѕРј
    // СЃРѕ СЃРєРµС‚С‡РµРј: Arduino СЃРѕР±РёСЂР°РµС‚ .c/.h РёР· РєРѕСЂРЅСЏ СЃРєРµС‚С‡Р°.
    if (useKmeshV1) {
      // Flatten the portable core into the sketch root: Arduino compiles every
      // .c/.cpp there and resolves headers next to the .ino.
      for (const sub of ['src', 'include']) {
        const dir = join(CORE_DIR, sub);
        const files = await readdir(dir);
        await Promise.all(
          files
            .filter((name) => /\.(c|cpp|h|hpp)$/i.test(name))
            .map((name) => copyFile(join(dir, name), join(sketchDir, name))),
        );
      }
    } else {
      const meshDir = join(TEMPLATE_DIR, 'mesh_v2');
      const meshFiles = await readdir(meshDir).catch(() => []);
      await Promise.all(
        meshFiles.map((name) => copyFile(join(meshDir, name), join(sketchDir, name)).catch(() => undefined)),
      );
    }

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
      // РўР°Р№РјР°СѓС‚ РЅРµ РїРѕРІС‚РѕСЂСЏРµРј: СЌС‚Рѕ РЅРµ РїРѕРІСЂРµР¶РґС‘РЅРЅС‹Р№ РєСЌС€, Р° РґРѕР»РіР°СЏ РєРѕРјРїРёР»СЏС†РёСЏ.
      const message = String(firstError);
      if (/timed out|ETIMEDOUT|killed/i.test(message)) {
        await writeFile(join(DATA_DIR, 'last-build.log'), message).catch(() => undefined);
        throw firstError;
      }
      // РџРѕРІС‚РѕСЂ Р±РµР· СѓРґР°Р»РµРЅРёСЏ buildDir: РЅР° 1 vCPU РїРµСЂРµСЃР±РѕСЂРєР° РІСЃРµРіРѕ СЏРґСЂР°
      // РґРѕР»СЊС€Рµ С‚Р°Р№РјР°СѓС‚Р°. РќРµРґРѕСЃС‚Р°СЋС‰РёРµ РѕР±СЉРµРєС‚С‹ РґРѕСЃРѕР±РµСЂСѓС‚СЃСЏ РёРЅРєСЂРµРјРµРЅС‚Р°Р»СЊРЅРѕ.
      log('build_retry', { board, error: message.slice(0, 300) });
      await writeFile(join(DATA_DIR, 'last-build.log'), message).catch(() => undefined);
      try {
        ({ stdout, stderr } = await arduinoCli(compileArgs, BUILD_TIMEOUT_MS));
      } catch (secondError) {
        await writeFile(join(DATA_DIR, 'last-build.log'), String(secondError)).catch(() => undefined);
        throw secondError;
      }
    }
    const compileLog = `${stdout}\n${stderr}`.trim();

    // Р”Р»СЏ Р±СЂР°СѓР·РµСЂРЅРѕР№ РїСЂРѕС€РёРІРєРё РЅСѓР¶РµРЅ merged.bin СЃ Р°РґСЂРµСЃР° 0x0.
    log('build_stage', { board, stage: 'merging' });
    const merged = await mergeBinary(board, buildDir, work);
    const binPath = await findBinary(outDir, sketchName);
    const output = [compileLog, merged.log, binPath ? `app: ${binPath}` : ''].filter(Boolean).join('\n');

    const bin = merged.bin;
    if (!bin.length) throw new Error('binary_empty');

    // OTA-РѕР±СЂР°Р·: С‚РѕР»СЊРєРѕ РїСЂРёР»РѕР¶РµРЅРёРµ (Р±РµР· bootloader/partitions). РРјРµРЅРЅРѕ РµРіРѕ
    // РїСЂРёРЅРёРјР°РµС‚ Update.h РЅР° РјРѕРґСѓР»Рµ.
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

/* ----------------------------------------------------------------- РєСЌС€ ----- */

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
  // v3: РєСЌС€ СѓС‡РёС‚С‹РІР°РµС‚ РІРµСЂСЃРёСЋ С€Р°Р±Р»РѕРЅР°, РёРЅР°С‡Рµ РёР·РјРµРЅРµРЅРёСЏ РїСЂРѕС€РёРІРєРё РЅРµ РїРѕРїР°РґР°СЋС‚
  // РІ СѓР¶Рµ СЃРѕР±СЂР°РЅРЅС‹Рµ РєРѕРЅС„РёРіСѓСЂР°С†РёРё. РЎС‚Р°СЂС‹Рµ app-only Р·Р°РїРёСЃРё РёРіРЅРѕСЂРёСЂСѓСЋС‚СЃСЏ.
  const useKmeshV1 = cfgBoolean(config.kmesh?.v1, false);
  const templateHash = sha256(
    (await readFile(join(TEMPLATE_DIR, useKmeshV1 ? 'klinto_module_kmesh_v1.ino' : 'klinto_module_v2.ino'), 'utf8')) +
      (useKmeshV1 ? await readFile(join(CORE_DIR, 'src', 'klinto_router.cpp'), 'utf8') : ''),
  ).slice(0, 16);
  const version = FIRMWARE_VERSION;
  const key = sha256(`merged4:${templateHash}:${version}:${stableStringify(config)}`);
  // Версия прошивки понятная (1.1, 1.2, ...) и общая для всех модулей,
  // собранных из текущего шаблона. Это нужно для OTA-бейджа и UI.

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
      log: `${cached.log ? `${cached.log}\n` : ''}[builder] РІР·СЏС‚Рѕ РёР· РєСЌС€Р°`,
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
      firmwareVersion: FIRMWARE_VERSION,
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

    // РџСЂРµС„Р»Р°Р№С‚: РїРѕРЅСЏС‚РЅР°СЏ РїСЂРёС‡РёРЅР° РІРјРµСЃС‚Рѕ Р·Р°РіР°РґРѕС‡РЅРѕРіРѕ С‚Р°Р№РјР°СѓС‚Р° РєРѕРјРїРёР»СЏС†РёРё.
    const coreReady = await esp32CoreReady();
    if (!coreReady) {
      return sendJson(res, 503, {
        ok: false,
        error: 'esp32_core_missing',
        log:
          'РЇРґСЂРѕ ESP32 РЅРµ СѓСЃС‚Р°РЅРѕРІР»РµРЅРѕ РІ build-СЃРµСЂРІРёСЃРµ. РћР±С‹С‡РЅРѕ СЌС‚Рѕ Р·РЅР°С‡РёС‚, С‡С‚Рѕ РЅР° РґРёСЃРєРµ РЅРµ С…РІР°С‚РёР»Рѕ РјРµСЃС‚Р° ' +
          'РїСЂРё РїРµСЂРІРѕРј Р·Р°РїСѓСЃРєРµ. РћСЃРІРѕР±РѕРґРёС‚Рµ ~4 Р“Р‘ Рё РїРµСЂРµР·Р°РїСѓСЃС‚РёС‚Рµ РєРѕРЅС‚РµР№РЅРµСЂ (РёР»Рё РёСЃРїРѕР»СЊР·СѓР№С‚Рµ СЃР±РѕСЂС‰РёРє РЅР° РґСЂСѓРіРѕР№ РјР°С€РёРЅРµ).',
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
          `РџР»Р°С‚Р° "${config.board}" РЅРµ СѓСЃС‚Р°РЅРѕРІР»РµРЅР° РІ СЃР±РѕСЂС‰РёРєРµ. Р”РѕСЃС‚СѓРїРЅС‹: ${installedBoards.join(', ') || 'РЅРµС‚'}. ` +
          'Р”РѕР±Р°РІСЊС‚Рµ РїР»Р°С‚Сѓ РІ ESP32_BOARDS Рё РїРµСЂРµР·Р°РїСѓСЃС‚РёС‚Рµ СЃР±РѕСЂС‰РёРє РЅР° РјР°С€РёРЅРµ СЃ РґРѕСЃС‚Р°С‚РѕС‡РЅС‹Рј РґРёСЃРєРѕРј.',
      });
    }
    const freeMb = await diskFreeMb();
    if (freeMb !== null && freeMb < MIN_BUILD_FREE_MB) {
      return sendJson(res, 503, {
        ok: false,
        error: 'insufficient_disk_space',
        log: `РќРµРґРѕСЃС‚Р°С‚РѕС‡РЅРѕ СЃРІРѕР±РѕРґРЅРѕРіРѕ РјРµСЃС‚Р° РґР»СЏ СЃР±РѕСЂРєРё: ${freeMb} РњР‘ (РЅСѓР¶РЅРѕ РјРёРЅРёРјСѓРј ${MIN_BUILD_FREE_MB} РњР‘).`,
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
