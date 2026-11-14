/**
 * Klinto KMesh_v1 — ESP32-адаптер OTA: LittleFS, esp_ota_* и mbedTLS.
 */
#ifndef KLINTO_OTA_ESP32_H
#define KLINTO_OTA_ESP32_H

#include "klinto_ota.h"

#if defined(ESP32)
/** Смонтировать LittleFS и подготовить каталог /ota. */
bool kl_ota_esp32_begin();
/** Платформенные колбэки для KlintoOta. */
const kl_ota_platform_t *kl_ota_esp32_platform();
/** Анти-откат: сохранённый максимальный build_number в NVS. */
uint16_t kl_ota_esp32_stored_build();
void kl_ota_esp32_store_build(uint16_t build);
/** Отметить текущее приложение рабочим (после 30 с стабильной работы). */
void kl_ota_esp32_mark_valid();
/** Шлюз: скачать манифест и дельта-патч с Hub в /ota/patch.bin. */
bool kl_ota_esp32_sync(const char *hub_url, const char *module_token, uint8_t chip_arch,
                       uint16_t current_build, kl_ota_manifest_t *out);
/** Проверка подписи публичным ключом разработчика (ECDSA P-256). */
bool kl_ota_esp32_verify_pubkey(const uint8_t digest[32], const uint8_t *sig, size_t sig_len);
#endif

#endif  // KLINTO_OTA_ESP32_H
