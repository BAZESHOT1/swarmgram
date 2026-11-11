/**
 * Глобальная mesh-сеть.
 *
 * Сеть ОДНА для всех модулей всех аккаунтов: SSID `SG-MESH`, общий пароль,
 * канал Wi-Fi и единые LoRa-параметры. Конфигурация хранится в singleton-
 * таблице `mesh_config` (id = 1) и меняется только на сервере.
 *
 * Пароль по HTTP наружу не отдаётся: он уже прошит в firmware. Клиент
 * получает публичную часть (SSID, канал, частота, SF/BW, лимиты хопов),
 * а `POST /firmware/build` инжектит полный конфиг в сборку.
 *
 * Маршрут `/modules/network` оставлен для совместимости со старым клиентом,
 * но теперь возвращает глобальную конфигурацию, а не per-account сеть.
 */
import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../auth.js';
import { one } from '../db.js';
import { log } from '../util.js';

/** Полная серверная конфигурация глобальной mesh-сети. */
export interface MeshConfig {
  ssid: string;
  password: string;
  channel: number;
  loraFreqMhz: number;
  loraSf: number;
  loraBwKhz: number;
  wifiHops: number;
  loraHops: number;
}

/** Публичная часть конфигурации: без пароля. */
export interface MeshPublicConfig {
  global: true;
  hidden: true;
  ssid: string;
  channel: number;
  loraFreqMhz: number;
  loraSf: number;
  loraBwKhz: number;
  wifiHops: number;
  loraHops: number;
}

/**
 * Значения по умолчанию совпадают с миграцией 019 — на случай, если строку
 * удалили вручную. Пароль всё равно приходит только в прошивку.
 */
const DEFAULT_MESH: MeshConfig = {
  ssid: 'SG-MESH',
  password: 'sgmesh-2026-11-11-a7f3c9d2e6b14580',
  channel: 11,
  loraFreqMhz: 869.525,
  loraSf: 9,
  loraBwKhz: 125,
  wifiHops: 14,
  loraHops: 12,
};

interface MeshConfigRow {
  ssid: string;
  password: string;
  channel: number;
  lora_freq_mhz: number;
  lora_sf: number;
  lora_bw_khz: number;
  wifi_hops: number;
  lora_hops: number;
}

/** Читает singleton `mesh_config`; при отсутствии строки — значения по умолчанию. */
export async function getMeshConfig(): Promise<MeshConfig> {
  const row = await one<MeshConfigRow>(
    `SELECT ssid, password, channel, lora_freq_mhz, lora_sf, lora_bw_khz, wifi_hops, lora_hops
       FROM mesh_config WHERE id = 1`,
  );
  if (!row) return { ...DEFAULT_MESH };
  return {
    ssid: row.ssid,
    password: row.password,
    channel: Number(row.channel),
    loraFreqMhz: Number(row.lora_freq_mhz),
    loraSf: Number(row.lora_sf),
    loraBwKhz: Number(row.lora_bw_khz),
    wifiHops: Number(row.wifi_hops),
    loraHops: Number(row.lora_hops),
  };
}

/** Публичное представление: без пароля, с флагом global. */
export function meshPublicConfig(cfg: MeshConfig): MeshPublicConfig {
  return {
    global: true,
    hidden: true,
    ssid: cfg.ssid,
    channel: cfg.channel,
    loraFreqMhz: cfg.loraFreqMhz,
    loraSf: cfg.loraSf,
    loraBwKhz: cfg.loraBwKhz,
    wifiHops: cfg.wifiHops,
    loraHops: cfg.loraHops,
  };
}

const networkRoutes: FastifyPluginAsync = async (app) => {
  /** Глобальная конфигурация для клиента (совместимый со старым URL). */
  app.get('/modules/network', { onRequest: [requireAuth()] }, async (_req, reply) => {
    const cfg = await getMeshConfig();
    return reply.send(meshPublicConfig(cfg));
  });

  /**
   * Ротация per-account сети больше невозможна: сеть общая для всех,
   * её меняет только сервер. Отвечаем текущей конфигурацией, чтобы старый
   * клиент не получал ошибку и не показывал «сеть сломана».
   */
  app.post('/modules/network/rotate', { onRequest: [requireAuth()] }, async (req, reply) => {
    log('warn', 'global_mesh_rotate_ignored', { userId: req.auth!.userId });
    const cfg = await getMeshConfig();
    return reply.send({ ...meshPublicConfig(cfg), ok: true, rotated: false, reason: 'global_config_server_managed' });
  });
};

export default networkRoutes;
