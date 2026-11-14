#include "klinto_owner.h"
#include "klinto_util.h"

#include <stdio.h>
#include <string.h>

bool kl_owner_prefix_valid(const char *prefix) {
  if (!prefix || strlen(prefix) != KL_OWNER_PREFIX_LEN) return false;
  for (size_t i = 0; i < KL_OWNER_PREFIX_LEN; ++i) {
    const char c = prefix[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

bool kl_owner_prefix_normalize(const char *in, char out[KL_OWNER_PREFIX_LEN + 1]) {
  if (!in || !out || strlen(in) != KL_OWNER_PREFIX_LEN) return false;
  for (size_t i = 0; i < KL_OWNER_PREFIX_LEN; ++i) {
    char c = in[i];
    if (c >= 'A' && c <= 'F') c = (char)(c - 'A' + 'a');
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    out[i] = c;
  }
  out[KL_OWNER_PREFIX_LEN] = '\0';
  return true;
}

void kl_ble_mod6(const uint8_t mac[6], char out[7]) {
  if (!out) return;
  if (!mac) {
    memcpy(out, "000000", 7);
    return;
  }
  snprintf(out, 7, "%02x%02x%02x", mac[3], mac[4], mac[5]);
}

size_t kl_ble_name_build(const char *prefix, const uint8_t mac[6], char *out, size_t cap) {
  char norm[KL_OWNER_PREFIX_LEN + 1];
  if (!kl_owner_prefix_normalize(prefix, norm) || !out || cap < KL_OWNER_NAME_LEN) return 0;
  char mod6[7];
  kl_ble_mod6(mac, mod6);
  const int n = snprintf(out, cap, "KL-%s-%s", norm, mod6);
  if (n <= 0 || (size_t)n >= cap) return 0;
  return (size_t)n;
}

bool kl_owner_claim_parse(const uint8_t *payload, size_t len, kl_owner_claim_t *out) {
  if (!payload || !out || len < 8 + 4 + 4 + 1) return false;
  const uint8_t sig_len = payload[16];
  if (sig_len == 0 || sig_len > KL_OWNER_MAX_SIG || len < 17u + sig_len) return false;
  memset(out, 0, sizeof(*out));
  char prefix[KL_OWNER_PREFIX_LEN + 1];
  memcpy(prefix, payload, KL_OWNER_PREFIX_LEN);
  prefix[KL_OWNER_PREFIX_LEN] = '\0';
  if (!kl_owner_prefix_normalize(prefix, out->prefix)) return false;
  out->net_id = kl_read_le32(payload + 8);
  out->epoch = kl_read_le32(payload + 12);
  out->sig_len = sig_len;
  memcpy(out->sig, payload + 17, sig_len);
  return true;
}

bool kl_owner_claim_digest(const char *mod6, const kl_owner_claim_t *claim, uint8_t out[32]) {
  if (!mod6 || !claim || !out) return false;
  char canonical[128];
  const int n = snprintf(canonical, sizeof(canonical), "KLINTO-OWNER1|%s|%s|%lu|%lu", mod6,
                         claim->prefix, (unsigned long)claim->net_id,
                         (unsigned long)claim->epoch);
  if (n <= 0 || (size_t)n >= sizeof(canonical)) return false;
  kl_sha256(canonical, (size_t)n, out);
  return true;
}

bool kl_owner_claim_verify(const char *mod6, const kl_owner_claim_t *claim,
                           kl_owner_verify_fn verify, void *ctx) {
  if (!verify || !claim || claim->sig_len == 0) return false;
  uint8_t digest[32];
  if (!kl_owner_claim_digest(mod6, claim, digest)) return false;
  return verify(ctx, digest, claim->sig, claim->sig_len);
}
