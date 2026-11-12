/**
 * mesh_identity.c/h — единая идентичность модуля по заводскому MAC.
 *
 * Основной адрес: MAC Wi-Fi STA (ESP_MAC_WIFI_STA). BLE MAC — только алиас.
 * MAC не меняется при перезагрузке/перепрошивке и используется как основа
 * mesh-адреса на всех интерфейсах.
 */
#ifndef KINTO_MESH_IDENTITY_H
#define KINTO_MESH_IDENTITY_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define KINTO_HW_ID_LEN 19   /* "esp32-" + 12 hex + NUL */
#define KINTO_MAC_TEXT_LEN 18 /* aa:bb:cc:dd:ee:ff + NUL */

typedef struct {
  uint8_t mac[6];       /* Wi-Fi STA / Ethernet MAC — основной */
  uint8_t alias_ble[6]; /* BLE MAC — только для сопоставления */
  bool ble_valid;
} kinto_mesh_identity_t;

/** Читает MAC из eFuse. Возвращает false, если платформа не дала MAC. */
bool kinto_identity_read(kinto_mesh_identity_t *out);

/** "esp32-xxxxxxxxxxxx" (lowercase). Буфер >= KINTO_HW_ID_LEN. */
void kinto_mac_to_hardware_id(const uint8_t mac[6], char *out, unsigned cap);

/** "aa:bb:cc:dd:ee:ff". Буфер >= KINTO_MAC_TEXT_LEN. */
void kinto_mac_to_text(const uint8_t mac[6], char *out, unsigned cap);

/** FNV-1a 32 от hardware id — стабильный public id. */
uint32_t kinto_identity_node_id(const char *hardware_id);

#ifdef __cplusplus
}
#endif

#endif /* KINTO_MESH_IDENTITY_H */
