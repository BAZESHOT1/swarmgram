#include "klinto_crypto.h"
#include "klinto_util.h"

#include <string.h>
#include <stdio.h>

static kl_sign_cb_t g_signer = nullptr;
static kl_verify_cb_t g_verifier = nullptr;
static void *g_signer_ctx = nullptr;

void kl_crypto_set_signers(kl_sign_cb_t signer, kl_verify_cb_t verifier, void *ctx) {
  g_signer = signer;
  g_verifier = verifier;
  g_signer_ctx = ctx;
}

bool kl_crypto_has_signer() { return g_signer != nullptr; }

static void derive_keys(const uint8_t key[32], uint8_t enc[32], uint8_t mac[32]) {
  static const char kEncLabel[] = "KLINTO-KMESH1-ENC";
  static const char kMacLabel[] = "KLINTO-KMESH1-MAC";
  kl_hmac_sha256(key, 32, (const uint8_t *)kEncLabel, sizeof(kEncLabel) - 1, enc);
  kl_hmac_sha256(key, 32, (const uint8_t *)kMacLabel, sizeof(kMacLabel) - 1, mac);
}

static void make_nonce(const kl_crypto_aad_t *aad, uint8_t nonce[12]) {
  kl_write_le32(nonce, aad->packet_id);
  kl_write_le32(nonce + 4, aad->src_id);
  const uint32_t low = (uint32_t)(aad->msg_uuid & 0xFFFFFFFFu);
  kl_write_le32(nonce + 8, low);
}

static size_t aad_serialize(const kl_crypto_aad_t *aad, uint8_t out[24]) {
  out[0] = 0x01;  /* domain: radio envelope */
  kl_write_le32(out + 1, aad->packet_id);
  kl_write_le64(out + 5, aad->msg_uuid);
  kl_write_le32(out + 13, aad->dst_id);
  kl_write_le32(out + 17, aad->src_id);
  out[21] = aad->type;
  out[22] = aad->flags;
  out[23] = aad->payload_len;
  return 24;
}

bool kl_crypto_is_envelope(const uint8_t *payload, size_t len) {
  if (!payload || len < KL_CRYPTO_HDR_LEN) return false;
  if (payload[0] != KL_CRYPTO_ALG_CHACHA20_HMAC_SHA256) return false;
  return payload[1] == KL_TEMP_TAG_LEN || payload[1] == KL_PERM_TAG_LEN;
}

uint8_t kl_crypto_envelope_tag_len(const uint8_t *payload, size_t len) {
  if (!payload || len < KL_CRYPTO_HDR_LEN) return 0;
  if (payload[0] != KL_CRYPTO_ALG_CHACHA20_HMAC_SHA256) return 0;
  if (payload[1] != KL_TEMP_TAG_LEN && payload[1] != KL_PERM_TAG_LEN) return 0;
  return payload[1];
}

bool kl_crypto_seal(const uint8_t key[32], const kl_crypto_aad_t *aad, const uint8_t *plain,
                    size_t len, uint8_t tag_len, uint8_t *out, size_t cap, size_t *out_len) {
  if (!key || !aad || (!plain && len) || !out || !out_len) return false;
  if (tag_len != KL_TEMP_TAG_LEN && tag_len != KL_PERM_TAG_LEN) return false;
  const size_t total = KL_CRYPTO_HDR_LEN + len + tag_len;
  if (cap < total) return false;

  uint8_t enc_key[32], mac_key[32];
  derive_keys(key, enc_key, mac_key);
  uint8_t nonce[12];
  make_nonce(aad, nonce);

  out[0] = KL_CRYPTO_ALG_CHACHA20_HMAC_SHA256;
  out[1] = tag_len;
  if (len) kl_chacha20_xor(enc_key, nonce, 1, plain, out + KL_CRYPTO_HDR_LEN, len);

  uint8_t aad_buf[24];
  const size_t aad_len = aad_serialize(aad, aad_buf);
  KlintoSha256 sha;
  uint8_t inner[32];
  kl_sha256_init(&sha);
  kl_sha256_update(&sha, aad_buf, aad_len);
  kl_sha256_update(&sha, out + KL_CRYPTO_HDR_LEN, len);
  kl_sha256_final(&sha, inner);
  uint8_t tag[32];
  kl_hmac_sha256(mac_key, 32, inner, 32, tag);
  memcpy(out + KL_CRYPTO_HDR_LEN + len, tag, tag_len);
  *out_len = total;
  return true;
}

bool kl_crypto_open(const uint8_t key[32], const uint8_t *in, size_t len,
                    const kl_crypto_aad_t *aad, uint8_t *out, size_t cap, size_t *out_len) {
  if (!key || !in || !aad || !out || !out_len) return false;
  if (len < KL_CRYPTO_HDR_LEN) return false;
  if (in[0] != KL_CRYPTO_ALG_CHACHA20_HMAC_SHA256) return false;
  const uint8_t tag_len = in[1];
  if (tag_len != KL_TEMP_TAG_LEN && tag_len != KL_PERM_TAG_LEN) return false;
  if (len < KL_CRYPTO_HDR_LEN + tag_len) return false;
  const size_t cipher_len = len - KL_CRYPTO_HDR_LEN - tag_len;
  if (cap < cipher_len) return false;

  uint8_t enc_key[32], mac_key[32];
  derive_keys(key, enc_key, mac_key);
  uint8_t nonce[12];
  make_nonce(aad, nonce);

  uint8_t aad_buf[24];
  const size_t aad_len = aad_serialize(aad, aad_buf);
  KlintoSha256 sha;
  uint8_t inner[32];
  kl_sha256_init(&sha);
  kl_sha256_update(&sha, aad_buf, aad_len);
  kl_sha256_update(&sha, in + KL_CRYPTO_HDR_LEN, cipher_len);
  kl_sha256_final(&sha, inner);
  uint8_t tag[32];
  kl_hmac_sha256(mac_key, 32, inner, 32, tag);

  uint8_t diff = 0;
  for (uint8_t i = 0; i < tag_len; ++i) diff |= (uint8_t)(tag[i] ^ in[KL_CRYPTO_HDR_LEN + cipher_len + i]);
  if (diff != 0) return false;

  if (cipher_len) {
    kl_chacha20_xor(enc_key, nonce, 1, in + KL_CRYPTO_HDR_LEN, out, cipher_len);
  }
  *out_len = cipher_len;
  return true;
}

void kl_crypto_perm_digest(uint64_t msg_uuid, uint32_t sender_id, uint32_t receiver_id,
                           uint64_t timestamp_ms, const uint8_t *ciphertext, size_t cipher_len,
                           uint8_t out[32]) {
  /* Каноническая строка, которую подписывает телефон и проверяет бэкенд:
   *   KLINTO-KMESH1-PERM|<uuid hex>|<sender>|<receiver>|<timestamp>|<cipher hex>
   * Клиент хэширует UTF-8 строку один раз перед ECDSA/Ed25519; C-хелпер
   * выдаёт тот же SHA-256 digest для подписи на устройстве. */
  char canonical[640];
  char cipher_hex[(KL_MAX_PAYLOAD * 2) + 1];
  const size_t hex_len = (ciphertext && cipher_len) ? kl_hex_encode(ciphertext, cipher_len,
                                                                    cipher_hex,
                                                                    sizeof(cipher_hex), false)
                                                     : 0;
  if (hex_len == 0 && cipher_len > 0) return;
  if (!cipher_hex[0]) cipher_hex[0] = '\0';
  const int n = snprintf(canonical, sizeof(canonical), "KLINTO-KMESH1-PERM|%016llx|%lu|%lu|%llu|%s",
                         (unsigned long long)msg_uuid, (unsigned long)sender_id,
                         (unsigned long)receiver_id, (unsigned long long)timestamp_ms, cipher_hex);
  if (n <= 0 || (size_t)n >= sizeof(canonical)) {
    memset(out, 0, 32);
    return;
  }
  kl_sha256(canonical, (size_t)n, out);
}

bool kl_crypto_sign_perm(uint64_t msg_uuid, uint32_t sender_id, uint32_t receiver_id,
                         uint64_t timestamp_ms, const uint8_t *ciphertext, size_t cipher_len,
                         uint8_t *sig, size_t *sig_len) {
  if (!g_signer || !sig || !sig_len) return false;
  uint8_t digest[32];
  kl_crypto_perm_digest(msg_uuid, sender_id, receiver_id, timestamp_ms, ciphertext, cipher_len,
                        digest);
  return g_signer(g_signer_ctx, digest, sig, sig_len);
}

bool kl_crypto_verify_perm(uint64_t msg_uuid, uint32_t sender_id, uint32_t receiver_id,
                           uint64_t timestamp_ms, const uint8_t *ciphertext, size_t cipher_len,
                           const uint8_t *sig, size_t sig_len) {
  if (!g_verifier || !sig) return false;
  uint8_t digest[32];
  kl_crypto_perm_digest(msg_uuid, sender_id, receiver_id, timestamp_ms, ciphertext, cipher_len,
                        digest);
  return g_verifier(g_signer_ctx, digest, sig, sig_len);
}
