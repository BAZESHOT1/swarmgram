#include "klinto_platform_esp32.h"
#include "klinto_util.h"

#if defined(ESP32)

#include <Arduino.h>
#include <Preferences.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <esp_system.h>
#include <time.h>
#include <string.h>

uint32_t kl_uptime_ms() { return (uint32_t)millis(); }

uint64_t kl_epoch_ms() {
  const time_t now = time(nullptr);
  if (now < 1700000000) return 0;
  return (uint64_t)now * 1000ULL;
}

void kl_random_bytes(uint8_t *out, size_t len) {
  if (!out || !len) return;
  esp_fill_random(out, len);
}

uint32_t kl_node_id_from_mac() {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char text[16];
  snprintf(text, sizeof(text), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3],
           mac[4], mac[5]);
  uint32_t id = kl_fnv1a32(text);
  /* Reserved sentinels: 0 (invalid), 1 (ANY_GATEWAY), 0xFFFFFFFF (broadcast). */
  id = (id & 0x7FFFFFFE) | 0x10000000u;
  if (id <= 1u) id = 0x10000002u;
  return id;
}

bool kl_nvs_get_str(const char *ns, const char *key, char *out, size_t cap) {
  Preferences prefs;
  if (!prefs.begin(ns, true)) return false;
  const size_t len = prefs.getString(key, out, cap);
  prefs.end();
  return len > 0;
}

bool kl_nvs_set_str(const char *ns, const char *key, const char *value) {
  Preferences prefs;
  if (!prefs.begin(ns, false)) return false;
  const bool ok = prefs.putString(key, value ? value : "") > 0;
  prefs.end();
  return ok;
}

uint32_t kl_nvs_get_uint(const char *ns, const char *key, uint32_t fallback) {
  Preferences prefs;
  if (!prefs.begin(ns, true)) return fallback;
  const uint32_t value = prefs.getUInt(key, fallback);
  prefs.end();
  return value;
}

bool kl_nvs_set_uint(const char *ns, const char *key, uint32_t value) {
  Preferences prefs;
  if (!prefs.begin(ns, false)) return false;
  const bool ok = prefs.putUInt(key, value) > 0;
  prefs.end();
  return ok;
}

bool kl_config_load_nvs(kl_config_t *cfg) {
  if (!cfg) return false;
  char json[1024];
  if (!kl_nvs_get_str("klinto3", "cfg", json, sizeof(json))) return false;
  return kl_config_from_json(cfg, json);
}

bool kl_config_save_nvs(const kl_config_t *cfg) {
  if (!cfg) return false;
  char json[1024];
  if (!kl_config_to_json(cfg, json, sizeof(json))) return false;
  return kl_nvs_set_str("klinto3", "cfg", json);
}

#endif  // ESP32
