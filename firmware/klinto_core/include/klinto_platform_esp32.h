/**
 * Klinto KMesh_v1 — платформенные адаптеры ESP32 (Arduino core 3.x).
 * Компилируется только при определённом ESP32.
 */
#ifndef KLINTO_PLATFORM_ESP32_H
#define KLINTO_PLATFORM_ESP32_H

#include "klinto_config.h"

bool kl_config_load_nvs(kl_config_t *cfg);
bool kl_config_save_nvs(const kl_config_t *cfg);
bool kl_nvs_get_str(const char *ns, const char *key, char *out, size_t cap);
bool kl_nvs_set_str(const char *ns, const char *key, const char *value);

/** Derive a stable non-sentinel node id from the Wi-Fi MAC. */
uint32_t kl_node_id_from_mac();

#endif  // KLINTO_PLATFORM_ESP32_H
