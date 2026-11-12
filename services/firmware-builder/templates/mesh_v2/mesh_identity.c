#include "mesh_identity.h"

#include <stdio.h>
#include <string.h>

#if defined(ESP_PLATFORM) || defined(ARDUINO_ARCH_ESP32)
#include <esp_mac.h>
#endif

static void fallback_mac(uint8_t out[6]) {
  /* Если esp_mac.h недоступен (хост-тесты), отдаём фиксированный MAC. */
  static const uint8_t zero[6] = {0x02, 0x00, 0x00, 0x00, 0x00, 0x01};
  memcpy(out, zero, 6);
}

bool kinto_identity_read(kinto_mesh_identity_t *out) {
  if (!out) return false;
  memset(out, 0, sizeof(*out));
#if defined(ESP_PLATFORM) || defined(ARDUINO_ARCH_ESP32)
  bool ok = esp_read_mac(out->mac, ESP_MAC_WIFI_STA) == 0;
  if (!ok) fallback_mac(out->mac);
  out->ble_valid = esp_read_mac(out->alias_ble, ESP_MAC_BT) == 0;
  if (!out->ble_valid) {
    memcpy(out->alias_ble, out->mac, 6);
    out->ble_valid = true;
  }
  return ok;
#else
  fallback_mac(out->mac);
  memcpy(out->alias_ble, out->mac, 6);
  out->ble_valid = true;
  return false;
#endif
}

void kinto_mac_to_hardware_id(const uint8_t mac[6], char *out, unsigned cap) {
  if (!out || cap < KINTO_HW_ID_LEN) return;
  snprintf(out, cap, "esp32-%02x%02x%02x%02x%02x%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

void kinto_mac_to_text(const uint8_t mac[6], char *out, unsigned cap) {
  if (!out || cap < KINTO_MAC_TEXT_LEN) return;
  snprintf(out, cap, "%02x:%02x:%02x:%02x:%02x:%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

uint32_t kinto_identity_node_id(const char *hardware_id) {
  if (!hardware_id) return 0;
  uint32_t h = 2166136261UL;
  while (*hardware_id) {
    h ^= (uint8_t)(*hardware_id++);
    h *= 16777619UL;
  }
  return h;
}
