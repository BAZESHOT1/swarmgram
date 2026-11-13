/**
 * Klinto KMesh_v1 — криптографическая обёртка.
 *
 * Радиотранспорт: ChaCha20 + HMAC-SHA256 (encrypt-then-MAC).
 * 4-байтный MIC — осознанный компромисс для LoRa; постоянную
 * историю защищает подпись ECDSA/Ed25519.
 */
#ifndef KLINTO_CRYPTO_H
#define KLINTO_CRYPTO_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#include "klinto_config.h"

#define KL_CRYPTO_ALG_CHACHA20_HMAC_SHA256 1
#define KL_TEMP_TAG_LEN 4
#define KL_PERM_TAG_LEN 16
#define KL_CRYPTO_HDR_LEN 2

struct kl_crypto_aad_t {
  uint32_t packet_id;
  uint64_t msg_uuid;
  uint32_t src_id;
  uint32_t dst_id;
  uint8_t type;
  uint8_t flags;
  uint8_t payload_len;
};

/** Encrypt + authenticate. Output = [alg][tag_len][ciphertext][tag]. */
bool kl_crypto_seal(const uint8_t key[32], const kl_crypto_aad_t *aad, const uint8_t *plain,
                    size_t len, uint8_t tag_len, uint8_t *out, size_t cap, size_t *out_len);

/** Verify + decrypt. `out_len` receives the plaintext length. */
bool kl_crypto_open(const uint8_t key[32], const uint8_t *in, size_t len,
                    const kl_crypto_aad_t *aad, uint8_t *out, size_t cap, size_t *out_len);

/** True when a payload looks like the v3 crypto envelope. */
bool kl_crypto_is_envelope(const uint8_t *payload, size_t len);
uint8_t kl_crypto_envelope_tag_len(const uint8_t *payload, size_t len);

/* ------------------------------------------------------- permanent sign --- */

typedef bool (*kl_sign_cb_t)(void *ctx, const uint8_t digest[32], uint8_t *sig, size_t *sig_len);
typedef bool (*kl_verify_cb_t)(void *ctx, const uint8_t digest[32], const uint8_t *sig,
                               size_t sig_len);

void kl_crypto_set_signers(kl_sign_cb_t signer, kl_verify_cb_t verifier, void *ctx);
bool kl_crypto_has_signer();

void kl_crypto_perm_digest(uint64_t msg_uuid, uint32_t sender_id, uint32_t receiver_id,
                           uint64_t timestamp_ms, const uint8_t *ciphertext, size_t cipher_len,
                           uint8_t out[32]);

/** Sign the digest with the user's permanent key (platform callback). */
bool kl_crypto_sign_perm(uint64_t msg_uuid, uint32_t sender_id, uint32_t receiver_id,
                         uint64_t timestamp_ms, const uint8_t *ciphertext, size_t cipher_len,
                         uint8_t *sig, size_t *sig_len);

bool kl_crypto_verify_perm(uint64_t msg_uuid, uint32_t sender_id, uint32_t receiver_id,
                           uint64_t timestamp_ms, const uint8_t *ciphertext, size_t cipher_len,
                           const uint8_t *sig, size_t sig_len);

#endif  // KLINTO_CRYPTO_H
