/**
 * Klinto KMesh_v1 — конфигурация времени выполнения.
 *
 * Узел собирается пользователем, поэтому наличие LoRa, чип и пины —
 * данные, а не выбор при компиляции. Builder задаёт значения по умолчанию,
 * NVS/JSON может переопределить их на устройстве.
 */
#ifndef KLINTO_CONFIG_H
#define KLINTO_CONFIG_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define KL_MAX_PAYLOAD 200
#define KL_MAX_PACKET_SIZE 256
#define KL_MAX_TEXT 160

#define KL_BROADCAST_ID 0xFFFFFFFFu
#define KL_ANY_GATEWAY_ID 0x00000001u
#define KL_INVALID_ID 0x00000000u

#define KL_DEFAULT_TTL 7
#define KL_DEFAULT_GW_HOPS 8
#define KL_DEFAULT_PRESENCE_MS 180000u
#define KL_DEFAULT_GW_BEACON_MS 90000u
#define KL_DEFAULT_ROUTE_EXPIRY_MS 120000u
#define KL_DEFAULT_ACK_TIMEOUT_MS 1800u
#define KL_DEFAULT_ACK_RETRIES 3

enum kl_role_t : uint8_t {
  KL_ROLE_CLIENT = 0,  /* wearable: battery first, transit only as fallback */
  KL_ROLE_ROUTER = 1,  /* stationary relay / cross-band bridge           */
  KL_ROLE_GATEWAY = 2  /* internet uplink                                */
};

enum kl_lora_chip_t : uint8_t {
  KL_LORA_SX1278 = 0,
  KL_LORA_SX1262 = 1,
  KL_LORA_SX1276 = 2
};

struct kl_lora_config_t {
  bool present;
  uint8_t chip;              /* kl_lora_chip_t */
  int8_t sck;
  int8_t miso;
  int8_t mosi;
  int8_t cs;
  int8_t rst;
  int8_t dio0;
  int8_t dio1;
  int8_t busy;
  float freq_mhz;
  uint8_t sf;
  float bw_khz;
  uint8_t cr;
  uint16_t preamble;
  int8_t power_dbm;
  uint8_t sync_word;
  uint32_t max_airtime_ms_per_min; /* regulatory duty-cycle budget */
};

struct kl_config_t {
  kl_role_t role;
  uint32_t node_id;    /* stable 32-bit id derived from the hardware id */
  uint32_t gateway_id; /* == node_id when role == GATEWAY              */

  bool espnow_enabled;
  uint8_t wifi_channel;
  bool allow_transit_for_client;

  bool lora_present;
  kl_lora_config_t lora;

  uint8_t ttl;
  uint8_t gw_max_hops;
  uint32_t presence_interval_ms;
  uint32_t gw_beacon_interval_ms;
  uint32_t route_expiry_ms;
  uint32_t ack_timeout_ms;
  uint8_t ack_retries;
  uint8_t lora_low_watermark; /* percent: drop LOW when queue above this */

  uint8_t temp_mesh_key[32];
  bool has_temp_key;

  char hub_url[128];
  char module_token[80];
  char hardware_id[24];
};

void kl_config_defaults(kl_config_t *cfg);
bool kl_config_validate(kl_config_t *cfg);
/** Merge a JSON object over the current config. Unknown keys are ignored. */
bool kl_config_from_json(kl_config_t *cfg, const char *json);
size_t kl_config_to_json(const kl_config_t *cfg, char *out, size_t cap);
/** True when the key is present and not all zeroes. */
bool kl_config_set_temp_key_hex(kl_config_t *cfg, const char *hex);

/* Минимальный поиск JSON-скаляра для парсера конфигурации и декодера шлюза.
 * Возвращает указатель на значение (после ':') или nullptr. */
const char *kl_json_value(const char *json, const char *key);
bool kl_json_get_string(const char *json, const char *key, char *out, size_t cap);
bool kl_json_get_uint(const char *json, const char *key, uint32_t *out);
bool kl_json_get_int(const char *json, const char *key, int32_t *out);
bool kl_json_get_bool(const char *json, const char *key, bool *out);
bool kl_json_get_double(const char *json, const char *key, double *out);

#endif  // KLINTO_CONFIG_H
