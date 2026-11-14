/**
 * Klinto KMesh_v1 — потоковый движок бинарных дельта-патчей.
 *
 * Формат KLDP1 (совместим с генератором Hub/builder):
 *   заголовок: "KLDP" | ver u8 | base_size u32 | target_size u32 | target_sha256[32]
 *   операции:  0x01 COPY {offset u32, length u32}
 *              0x02 ADD  {length u16, bytes[length]}
 *              0x00 END
 *
 * Патч применяется потоково: 4 КБ буфер, без загрузки всего образа в RAM.
 */
#ifndef KLINTO_OTA_PATCHER_H
#define KLINTO_OTA_PATCHER_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define KL_PATCH_MAGIC 0x50444C4Bu /* "K L D P" little-endian */
#define KL_PATCH_VERSION 1
#define KL_PATCH_HEADER_SIZE 45
#define KL_PATCH_BUFFER 4096
#define KL_PATCH_MAX_ADD 4096

#define KL_PATCH_OP_END 0x00
#define KL_PATCH_OP_COPY 0x01
#define KL_PATCH_OP_ADD 0x02

struct kl_patch_header_t {
  uint32_t base_size;
  uint32_t target_size;
  uint8_t target_sha256[32];
};

/** Прочитать заголовок; false при неверной магии/версии/длине. */
bool kl_patch_parse_header(const uint8_t *patch, size_t len, kl_patch_header_t *out);

/** Последовательное чтение базы (активный OTA-раздел). */
typedef bool (*kl_patch_read_base_t)(void *ctx, uint32_t offset, uint8_t *out, size_t len);
/** Последовательная запись результата в неактивный OTA-слот. */
typedef bool (*kl_patch_write_target_t)(void *ctx, const uint8_t *data, size_t len);
/** Доступ к файлу патча (LittleFS/буфер). */
typedef bool (*kl_patch_read_patch_t)(void *ctx, uint32_t offset, uint8_t *out, size_t len);

/**
 * Применить патч потоково. В out_sha возвращается SHA-256 результата.
 * Возвращает false при ошибке, переполнении или несовпадении размера/хэша.
 */
bool kl_patch_apply_stream(const uint8_t *patch, size_t patch_len,
                           kl_patch_read_base_t read_base, void *base_ctx,
                           kl_patch_write_target_t write_target, void *target_ctx,
                           kl_patch_read_patch_t read_patch, void *patch_ctx,
                           uint8_t out_sha[32]);

/** Удобная обёртка для тестов и маленьких образов. */
bool kl_patch_apply_memory(const uint8_t *base, size_t base_len, const uint8_t *patch,
                           size_t patch_len, uint8_t *out, size_t out_cap, size_t *out_len,
                           uint8_t out_sha[32]);

#endif  // KLINTO_OTA_PATCHER_H
