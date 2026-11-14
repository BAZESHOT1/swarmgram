/**
 * Klinto KMesh_v1 — идентичность владельца модуля и BLE-имя.
 *
 * Постоянный идентификатор пользователя — users.id (UUID) на сервере.
 * В радиоэфире используется компактный owner_net_id (uint32), а в BLE-имени
 * первые 4 байта UUID: KL-<USER8>-<MOD6>.
 */
#ifndef KLINTO_OWNER_H
#define KLINTO_OWNER_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define KL_OWNER_PREFIX_LEN 8
#define KL_OWNER_NAME_LEN 19 /* 18 символов + NUL */
#define KL_OWNER_MAX_SIG 72

struct kl_owner_claim_t {
  char prefix[KL_OWNER_PREFIX_LEN + 1];
  uint32_t net_id;
  uint32_t epoch;
  uint8_t sig_len;
  uint8_t sig[KL_OWNER_MAX_SIG];
};

/** Проверка 8 hex-символов (нижний регистр). */
bool kl_owner_prefix_valid(const char *prefix);
/** Привести префикс к нижнему регистру; false при неверном формате. */
bool kl_owner_prefix_normalize(const char *in, char out[KL_OWNER_PREFIX_LEN + 1]);

/**
 * Собрать имя KL-<USER8>-<MOD6> из префикса и MAC (6 байт, порядок eFuse).
 * Возвращает длину строки (18) или 0 при ошибке.
 */
size_t kl_ble_name_build(const char *prefix, const uint8_t mac[6], char *out, size_t cap);

/** mod6 = последние 3 байта MAC в нижнем hex. */
void kl_ble_mod6(const uint8_t mac[6], char out[7]);

/** Разбор BRIDGE_CMD_SET_OWNER: prefix(8) net(4) epoch(4) sig_len(1) sig. */
bool kl_owner_claim_parse(const uint8_t *payload, size_t len, kl_owner_claim_t *out);

/** Канонический digest для подписи Hub (ECDSA P-256). */
bool kl_owner_claim_digest(const char *mod6, const kl_owner_claim_t *claim, uint8_t out[32]);

typedef bool (*kl_owner_verify_fn)(void *ctx, const uint8_t digest[32], const uint8_t *sig,
                                   size_t sig_len);

/** Проверить подпись claim публичным ключом разработчика. */
bool kl_owner_claim_verify(const char *mod6, const kl_owner_claim_t *claim,
                           kl_owner_verify_fn verify, void *ctx);

#endif  // KLINTO_OWNER_H
