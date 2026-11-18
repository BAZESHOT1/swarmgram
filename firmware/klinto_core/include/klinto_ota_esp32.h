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
/** То же для конкретной платформы (массовый OTA: патчи для C3/S3/C6). */
bool kl_ota_esp32_sync_chip(const char *hub_url, const char *module_token, const char *chip_name,
                            uint8_t chip_arch, uint16_t base_build, kl_ota_manifest_t *out);
/** План OTA для кластера: строки "chip:base_build\n". */
int kl_ota_esp32_plan(const char *hub_url, const char *module_token, uint32_t gw_id, char *out, size_t cap);
/** Ручной откат: если новая прошивка не подтвердилась за один цикл — вернуть прошлый слот. */
bool kl_ota_esp32_check_rollback();
/** Текущая загрузка — новая прошивка, ожидающая подтверждения (связь с кластером). */
bool kl_ota_esp32_pending();
/** Откатиться на прошлый слот, пометить сборку как сломанную и перезагрузиться. */
void kl_ota_esp32_rollback_now(const char *reason);
/** Сборка, которая уже откатывалась (повторно не ставится). */
uint16_t kl_ota_esp32_bad_build();
/** Какие транспорты были живы до обновления: их и проверяем после перезагрузки. */
void kl_ota_esp32_set_need_ifc(uint8_t mask);
uint8_t kl_ota_esp32_need_ifc();
/** Применённый манифест полного образа (для каскадной раздачи после подтверждения). */
bool kl_ota_esp32_load_manifest(kl_ota_manifest_t *out);
/**
 * Запрос к Hub: что ставить для (chip, variant, base). self=true — образ для самого шлюза.
 * Возвращает манифест и путь к полному образу или патчу.
 */
bool kl_ota_esp32_query(const char *hub_url, const char *token, const char *chip_name, uint8_t chip_arch,
                        uint8_t variant, uint16_t base_build, uint32_t gw_id, bool self_update,
                        kl_ota_manifest_t *out, char *path, size_t path_cap, bool *is_full);
/** Шлюз: полный образ по Wi-Fi прямо в свой слот и перезагрузка. */
bool kl_ota_esp32_install_full(const char *hub_url, const char *token, const char *path,
                               const kl_ota_manifest_t *m);
/** Шлюз: дельта-патч в LittleFS (для раздачи). */
bool kl_ota_esp32_fetch_patch(const char *hub_url, const char *token, const char *path, uint32_t size);
/** Шлюз: раздавать чужой полный образ окнами с Hub (HTTP Range). */
void kl_ota_esp32_remote_set(const char *hub_url, const char *token, const char *path, uint32_t size);
void kl_ota_esp32_remote_clear();
/** Вызывать из задачи шлюза: подкачивает запрошенное окно образа. */
void kl_ota_esp32_remote_service();
/** Проверка подписи публичным ключом разработчика (ECDSA P-256). */
bool kl_ota_esp32_verify_pubkey(const uint8_t digest[32], const uint8_t *sig, size_t sig_len);
#endif

#endif  // KLINTO_OTA_ESP32_H
