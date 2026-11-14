#include "klinto_config.h"
#include "klinto_util.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

void kl_config_defaults(kl_config_t *cfg) {
  if (!cfg) return;
  memset(cfg, 0, sizeof(*cfg));
  cfg->role = KL_ROLE_CLIENT;
  cfg->node_id = KL_INVALID_ID;
  cfg->gateway_id = KL_INVALID_ID;
  cfg->espnow_enabled = true;
  cfg->wifi_channel = 11;
  cfg->allow_transit_for_client = true;
  cfg->hybrid_portable = true;
  cfg->relay_allowed = true;
  cfg->relay_battery_min = 20;
  cfg->relay_battery_resume = 25;
  cfg->mobile_gw_beacon_ms = 25000;
  cfg->mobile_gw_ttl_ms = 60000;
  cfg->mobile_gw_hops = 2;
  cfg->relay_penalty_espnow_ms = 60;
  cfg->relay_penalty_lora_ms = 250;
  cfg->lora_present = false;

  cfg->lora.present = false;
  cfg->lora.chip = KL_LORA_SX1262;
  cfg->lora.sck = 4;
  cfg->lora.miso = 5;
  cfg->lora.mosi = 6;
  cfg->lora.cs = 7;
  cfg->lora.rst = 3;
  cfg->lora.dio0 = 2;
  cfg->lora.dio1 = 2;
  cfg->lora.busy = 10;
  cfg->lora.freq_mhz = 869.525f;
  cfg->lora.sf = 9;
  cfg->lora.bw_khz = 125.0f;
  cfg->lora.cr = 5;
  cfg->lora.preamble = 8;
  cfg->lora.power_dbm = 17;
  cfg->lora.sync_word = 0x12;
  cfg->lora.max_airtime_ms_per_min = 36000; /* 60% -> 1% regulatory cap */

  cfg->ttl = KL_DEFAULT_TTL;
  cfg->gw_max_hops = KL_DEFAULT_GW_HOPS;
  cfg->presence_interval_ms = KL_DEFAULT_PRESENCE_MS;
  cfg->station_presence_ms = KL_DEFAULT_STATION_PRESENCE_MS;
  cfg->gw_beacon_interval_ms = KL_DEFAULT_GW_BEACON_MS;
  cfg->route_expiry_ms = KL_DEFAULT_ROUTE_EXPIRY_MS;
  cfg->ack_timeout_ms = KL_DEFAULT_ACK_TIMEOUT_MS;
  cfg->ack_retries = KL_DEFAULT_ACK_RETRIES;
  cfg->lora_low_watermark = 70;

  cfg->has_temp_key = false;
  cfg->hub_url[0] = '\0';
  cfg->module_token[0] = '\0';
  cfg->hardware_id[0] = '\0';
}

bool kl_config_validate(kl_config_t *cfg) {
  if (!cfg) return false;
  if (cfg->role > KL_ROLE_GATEWAY) return false;
  if (cfg->wifi_channel < 1 || cfg->wifi_channel > 14) return false;
  if (cfg->ttl == 0) cfg->ttl = KL_DEFAULT_TTL;
  if (cfg->ttl > 16) cfg->ttl = 16;
  if (cfg->gw_max_hops == 0) cfg->gw_max_hops = KL_DEFAULT_GW_HOPS;
  if (cfg->gw_max_hops > 16) cfg->gw_max_hops = 16;
  if (cfg->ack_retries > 5) cfg->ack_retries = 5;
  if (cfg->relay_battery_min < 5) cfg->relay_battery_min = 20;
  if (cfg->relay_battery_resume <= cfg->relay_battery_min) {
    cfg->relay_battery_resume = (uint8_t)(cfg->relay_battery_min + 5);
  }
  if (cfg->mobile_gw_beacon_ms < 5000) cfg->mobile_gw_beacon_ms = 25000;
  if (cfg->mobile_gw_ttl_ms < cfg->mobile_gw_beacon_ms) cfg->mobile_gw_ttl_ms = 60000;
  if (cfg->mobile_gw_hops < 1 || cfg->mobile_gw_hops > 4) cfg->mobile_gw_hops = 2;
  if (cfg->relay_penalty_lora_ms < cfg->relay_penalty_espnow_ms) cfg->relay_penalty_lora_ms = 250;
  if (cfg->ack_timeout_ms < 300) cfg->ack_timeout_ms = 300;
  if (cfg->presence_interval_ms < 30000) cfg->presence_interval_ms = 30000;
  if (cfg->station_presence_ms < cfg->presence_interval_ms) {
    cfg->station_presence_ms = KL_DEFAULT_STATION_PRESENCE_MS;
  }
  if (cfg->gw_beacon_interval_ms < 30000) cfg->gw_beacon_interval_ms = 30000;
  if (cfg->lora.sf < 6 || cfg->lora.sf > 12) cfg->lora.sf = 9;
  if (cfg->lora.cr < 5 || cfg->lora.cr > 8) cfg->lora.cr = 5;
  if (cfg->lora.bw_khz <= 0) cfg->lora.bw_khz = 125.0f;
  if (cfg->lora.freq_mhz <= 0) cfg->lora.freq_mhz = 869.525f;
  if (cfg->lora.max_airtime_ms_per_min == 0) cfg->lora.max_airtime_ms_per_min = 36000;
  if (cfg->lora_low_watermark < 50 || cfg->lora_low_watermark > 95) cfg->lora_low_watermark = 70;
  if (cfg->role == KL_ROLE_GATEWAY && cfg->gateway_id == KL_INVALID_ID) cfg->gateway_id = cfg->node_id;
  /* 0 and 1 are protocol sentinels (KL_INVALID_ID / KL_ANY_GATEWAY_ID). */
  if (cfg->node_id <= KL_ANY_GATEWAY_ID) return false;
  return true;
}

/* --------------------------------------------------------------- JSON ---- */

static const char *skip_ws(const char *p) {
  while (p && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) ++p;
  return p;
}

/**
 * Минимальный нерекурсивный поиск: находит "key" и ':' в любом месте
 * документа. Ключи конфигурации уникальны, поэтому JSON-зависимость не нужна.
 */
const char *kl_json_value(const char *json, const char *key) {
  if (!json || !key) return nullptr;
  char pattern[80];
  int n = snprintf(pattern, sizeof(pattern), "\"%s\"", key);
  if (n <= 0 || (size_t)n >= sizeof(pattern)) return nullptr;
  const char *p = json;
  while ((p = strstr(p, pattern)) != nullptr) {
    const char *q = skip_ws(p + n);
    if (*q == ':') return skip_ws(q + 1);
    p += n;
  }
  return nullptr;
}

static bool copy_json_string(const char *v, char *out, size_t cap) {
  if (!v || *v != '"' || !cap) return false;
  ++v;
  size_t o = 0;
  while (*v && *v != '"' && o + 1 < cap) {
    if (*v == '\\' && v[1]) {
      ++v;
      switch (*v) {
        case 'n': out[o++] = '\n'; break;
        case 'r': out[o++] = '\r'; break;
        case 't': out[o++] = '\t'; break;
        default: out[o++] = *v; break;
      }
      ++v;
    } else {
      out[o++] = *v++;
    }
  }
  out[o] = '\0';
  return true;
}

bool kl_json_get_string(const char *json, const char *key, char *out, size_t cap) {
  return copy_json_string(kl_json_value(json, key), out, cap);
}

bool kl_json_get_uint(const char *json, const char *key, uint32_t *out) {
  const char *v = kl_json_value(json, key);
  if (!v) return false;
  char *end = nullptr;
  unsigned long long parsed = strtoull(v, &end, 10);
  if (end == v) return false;
  if (out) *out = (uint32_t)parsed;
  return true;
}

bool kl_json_get_int(const char *json, const char *key, int32_t *out) {
  const char *v = kl_json_value(json, key);
  if (!v) return false;
  char *end = nullptr;
  long parsed = strtol(v, &end, 10);
  if (end == v) return false;
  if (out) *out = (int32_t)parsed;
  return true;
}

bool kl_json_get_bool(const char *json, const char *key, bool *out) {
  const char *v = kl_json_value(json, key);
  if (!v) return false;
  if (!strncmp(v, "true", 4) || *v == '1') {
    if (out) *out = true;
    return true;
  }
  if (!strncmp(v, "false", 5) || *v == '0') {
    if (out) *out = false;
    return true;
  }
  return false;
}

bool kl_json_get_double(const char *json, const char *key, double *out) {
  const char *v = kl_json_value(json, key);
  if (!v) return false;
  char *end = nullptr;
  double parsed = strtod(v, &end);
  if (end == v) return false;
  if (out) *out = parsed;
  return true;
}

bool kl_config_set_temp_key_hex(kl_config_t *cfg, const char *hex) {
  if (!cfg || !hex) return false;
  uint8_t key[32];
  if (kl_hex_decode(hex, strlen(hex), key, sizeof(key)) != sizeof(key)) return false;
  uint8_t acc = 0;
  for (size_t i = 0; i < sizeof(key); ++i) acc |= key[i];
  if (acc == 0) return false;
  memcpy(cfg->temp_mesh_key, key, sizeof(key));
  cfg->has_temp_key = true;
  return true;
}

bool kl_config_from_json(kl_config_t *cfg, const char *json) {
  if (!cfg || !json) return false;
  char text[96];
  uint32_t u = 0;
  int32_t i = 0;
  bool b = false;
  double d = 0;

  if (kl_json_get_string(json, "role", text, sizeof(text))) {
    if (!strcmp(text, "gateway")) cfg->role = KL_ROLE_GATEWAY;
    else if (!strcmp(text, "router") || !strcmp(text, "repeater")) cfg->role = KL_ROLE_ROUTER;
    else if (!strcmp(text, "client") || !strcmp(text, "wearable")) cfg->role = KL_ROLE_CLIENT;
  }
  if (kl_json_get_uint(json, "node_id", &u)) cfg->node_id = u;
  if (kl_json_get_uint(json, "wifi_channel", &u)) cfg->wifi_channel = (uint8_t)u;
  if (kl_json_get_bool(json, "espnow", &b)) cfg->espnow_enabled = b;
  if (kl_json_get_bool(json, "allow_transit_for_client", &b)) cfg->allow_transit_for_client = b;
  if (kl_json_get_bool(json, "hybrid_portable", &b)) cfg->hybrid_portable = b;
  if (kl_json_get_bool(json, "relay_allowed", &b)) cfg->relay_allowed = b;
  if (kl_json_get_uint(json, "relay_battery_min", &u)) cfg->relay_battery_min = (uint8_t)u;
  if (kl_json_get_uint(json, "relay_battery_resume", &u)) cfg->relay_battery_resume = (uint8_t)u;
  if (kl_json_get_uint(json, "mobile_gw_beacon_ms", &u)) cfg->mobile_gw_beacon_ms = (uint16_t)u;
  if (kl_json_get_uint(json, "mobile_gw_ttl_ms", &u)) cfg->mobile_gw_ttl_ms = (uint16_t)u;
  if (kl_json_get_uint(json, "mobile_gw_hops", &u)) cfg->mobile_gw_hops = (uint8_t)u;
  if (kl_json_get_uint(json, "relay_penalty_espnow_ms", &u)) cfg->relay_penalty_espnow_ms = (uint16_t)u;
  if (kl_json_get_uint(json, "relay_penalty_lora_ms", &u)) cfg->relay_penalty_lora_ms = (uint16_t)u;
  if (kl_json_get_uint(json, "ttl", &u)) cfg->ttl = (uint8_t)u;
  if (kl_json_get_uint(json, "gw_max_hops", &u)) cfg->gw_max_hops = (uint8_t)u;
  if (kl_json_get_uint(json, "presence_interval_ms", &u)) cfg->presence_interval_ms = u;
  if (kl_json_get_uint(json, "station_presence_ms", &u)) cfg->station_presence_ms = u;
  if (kl_json_get_uint(json, "gw_beacon_interval_ms", &u)) cfg->gw_beacon_interval_ms = u;
  if (kl_json_get_uint(json, "route_expiry_ms", &u)) cfg->route_expiry_ms = u;
  if (kl_json_get_uint(json, "ack_timeout_ms", &u)) cfg->ack_timeout_ms = u;
  if (kl_json_get_uint(json, "ack_retries", &u)) cfg->ack_retries = (uint8_t)u;
  if (kl_json_get_uint(json, "lora_low_watermark", &u)) cfg->lora_low_watermark = (uint8_t)u;
  if (kl_json_get_string(json, "hardware_id", text, sizeof(text))) {
    strncpy(cfg->hardware_id, text, sizeof(cfg->hardware_id) - 1);
    cfg->hardware_id[sizeof(cfg->hardware_id) - 1] = '\0';
  }
  if (kl_json_get_string(json, "hub_url", text, sizeof(text))) {
    strncpy(cfg->hub_url, text, sizeof(cfg->hub_url) - 1);
    cfg->hub_url[sizeof(cfg->hub_url) - 1] = '\0';
  }
  if (kl_json_get_string(json, "module_token", text, sizeof(text))) {
    strncpy(cfg->module_token, text, sizeof(cfg->module_token) - 1);
    cfg->module_token[sizeof(cfg->module_token) - 1] = '\0';
  }
  if (kl_json_get_string(json, "temp_mesh_key", text, sizeof(text))) {
    kl_config_set_temp_key_hex(cfg, text);
  }

  const char *lora = kl_json_value(json, "lora");
  if (lora && *lora == '{') {
    cfg->lora_present = true;
    if (kl_json_get_bool(json, "present", &b)) cfg->lora_present = b;
    if (kl_json_get_string(json, "chip", text, sizeof(text))) {
      if (!strcmp(text, "sx1262")) cfg->lora.chip = KL_LORA_SX1262;
      else if (!strcmp(text, "sx1276")) cfg->lora.chip = KL_LORA_SX1276;
      else if (!strcmp(text, "sx1278") || !strcmp(text, "sx127x")) cfg->lora.chip = KL_LORA_SX1278;
    }
    if (kl_json_get_int(json, "sck", &i)) cfg->lora.sck = (int8_t)i;
    if (kl_json_get_int(json, "miso", &i)) cfg->lora.miso = (int8_t)i;
    if (kl_json_get_int(json, "mosi", &i)) cfg->lora.mosi = (int8_t)i;
    if (kl_json_get_int(json, "cs", &i)) cfg->lora.cs = (int8_t)i;
    if (kl_json_get_int(json, "rst", &i)) cfg->lora.rst = (int8_t)i;
    if (kl_json_get_int(json, "dio0", &i)) cfg->lora.dio0 = (int8_t)i;
    if (kl_json_get_int(json, "dio1", &i)) cfg->lora.dio1 = (int8_t)i;
    if (kl_json_get_int(json, "busy", &i)) cfg->lora.busy = (int8_t)i;
    if (kl_json_get_double(json, "freq", &d)) cfg->lora.freq_mhz = (float)d;
    if (kl_json_get_double(json, "bw", &d)) cfg->lora.bw_khz = (float)d;
    if (kl_json_get_uint(json, "sf", &u)) cfg->lora.sf = (uint8_t)u;
    if (kl_json_get_uint(json, "cr", &u)) cfg->lora.cr = (uint8_t)u;
    if (kl_json_get_uint(json, "power", &u)) cfg->lora.power_dbm = (int8_t)u;
  }
  cfg->lora.present = cfg->lora_present;
  kl_config_validate(cfg);
  return true;
}

size_t kl_config_to_json(const kl_config_t *cfg, char *out, size_t cap) {
  if (!cfg || !out || cap < 64) return 0;
  char keyhex[65] = "";
  if (cfg->has_temp_key) kl_hex_encode(cfg->temp_mesh_key, 32, keyhex, sizeof(keyhex), false);
  const char *role = cfg->role == KL_ROLE_GATEWAY ? "gateway"
                     : cfg->role == KL_ROLE_ROUTER ? "router"
                                                    : "client";
  const char *chip = cfg->lora.chip == KL_LORA_SX1262 ? "sx1262"
                     : cfg->lora.chip == KL_LORA_SX1276 ? "sx1276"
                                                        : "sx1278";
  int n = snprintf(
      out, cap,
      "{\"role\":\"%s\",\"node_id\":%lu,\"hardware_id\":\"%s\",\"wifi_channel\":%u,"
      "\"espnow\":%s,\"allow_transit_for_client\":%s,\"hybrid_portable\":%s,"
      "\"relay_allowed\":%s,\"relay_battery_min\":%u,\"relay_battery_resume\":%u,"
      "\"mobile_gw_beacon_ms\":%u,\"mobile_gw_ttl_ms\":%u,\"mobile_gw_hops\":%u,"
      "\"relay_penalty_espnow_ms\":%u,\"relay_penalty_lora_ms\":%u,"
      "\"ttl\":%u,\"gw_max_hops\":%u,"
      "\"presence_interval_ms\":%lu,\"station_presence_ms\":%lu,"
      "\"gw_beacon_interval_ms\":%lu,\"route_expiry_ms\":%lu,"
      "\"ack_timeout_ms\":%lu,\"ack_retries\":%u,\"lora_low_watermark\":%u,"
      "\"temp_mesh_key\":\"%s\",\"hub_url\":\"%s\",\"module_token\":\"%s\","
      "\"lora\":{\"present\":%s,\"chip\":\"%s\",\"sck\":%d,\"miso\":%d,\"mosi\":%d,"
      "\"cs\":%d,\"rst\":%d,\"dio0\":%d,\"dio1\":%d,\"busy\":%d,\"freq\":%.3f,"
      "\"sf\":%u,\"bw\":%.1f,\"cr\":%u,\"power\":%d}}",
      role, (unsigned long)cfg->node_id, cfg->hardware_id, (unsigned)cfg->wifi_channel,
      cfg->espnow_enabled ? "true" : "false", cfg->allow_transit_for_client ? "true" : "false",
      cfg->hybrid_portable ? "true" : "false", cfg->relay_allowed ? "true" : "false",
      (unsigned)cfg->relay_battery_min, (unsigned)cfg->relay_battery_resume,
      (unsigned)cfg->mobile_gw_beacon_ms, (unsigned)cfg->mobile_gw_ttl_ms,
      (unsigned)cfg->mobile_gw_hops, (unsigned)cfg->relay_penalty_espnow_ms,
      (unsigned)cfg->relay_penalty_lora_ms,
      (unsigned)cfg->ttl, (unsigned)cfg->gw_max_hops, (unsigned long)cfg->presence_interval_ms,
      (unsigned long)cfg->station_presence_ms,
      (unsigned long)cfg->gw_beacon_interval_ms, (unsigned long)cfg->route_expiry_ms,
      (unsigned long)cfg->ack_timeout_ms, (unsigned)cfg->ack_retries,
      (unsigned)cfg->lora_low_watermark, keyhex, cfg->hub_url, cfg->module_token,
      cfg->lora.present ? "true" : "false", chip, cfg->lora.sck, cfg->lora.miso, cfg->lora.mosi,
      cfg->lora.cs, cfg->lora.rst, cfg->lora.dio0, cfg->lora.dio1, cfg->lora.busy,
      (double)cfg->lora.freq_mhz, (unsigned)cfg->lora.sf, (double)cfg->lora.bw_khz,
      (unsigned)cfg->lora.cr, cfg->lora.power_dbm);
  if (n <= 0 || (size_t)n >= cap) {
    out[0] = '\0';
    return 0;
  }
  return (size_t)n;
}
