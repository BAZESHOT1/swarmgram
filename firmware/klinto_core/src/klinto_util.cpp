#include "klinto_util.h"

#include <string.h>

/* ------------------------------------------------------------ platform --- */

__attribute__((weak)) uint32_t kl_uptime_ms() { return 0; }

__attribute__((weak)) uint64_t kl_epoch_ms() { return 0; }

__attribute__((weak)) void kl_random_bytes(uint8_t *out, size_t len) {
  /* Детерминированный fallback только для host-тестов. На ESP32 он
   * перекрывается esp_fill_random(); production не должен на него полагаться. */
  static uint64_t state = 0x9e3779b97f4a7c15ULL;
  for (size_t i = 0; i < len; ++i) {
    state ^= state << 13;
    state ^= state >> 7;
    state ^= state << 17;
    out[i] = (uint8_t)(state >> 24);
  }
}

uint32_t kl_fnv1a32(const char *text) {
  uint32_t h = 2166136261u;
  if (!text) return h;
  while (*text) {
    h ^= (uint8_t)*text++;
    h *= 16777619u;
  }
  return h;
}

/* ----------------------------------------------------------- checksums --- */

uint16_t kl_crc16(const uint8_t *data, size_t len, uint16_t init) {
  uint16_t crc = init;
  for (size_t i = 0; i < len; ++i) {
    crc ^= (uint16_t)data[i] << 8;
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

uint32_t kl_crc32(const uint8_t *data, size_t len, uint32_t init) {
  uint32_t crc = init;
  for (size_t i = 0; i < len; ++i) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc & 1u) ? (crc >> 1) ^ 0xEDB88320u : (crc >> 1);
    }
  }
  return crc ^ 0xFFFFFFFFu;
}

/* --------------------------------------------------------------- hex/b64 -- */

static char hex_digit(uint8_t v, bool upper) {
  if (v < 10) return (char)('0' + v);
  return (char)((upper ? 'A' : 'a') + (v - 10));
}

static int8_t hex_value(char c) {
  if (c >= '0' && c <= '9') return (int8_t)(c - '0');
  if (c >= 'a' && c <= 'f') return (int8_t)(c - 'a' + 10);
  if (c >= 'A' && c <= 'F') return (int8_t)(c - 'A' + 10);
  return -1;
}

size_t kl_hex_encode(const uint8_t *in, size_t len, char *out, size_t cap, bool upper) {
  if (!out || cap < len * 2 + 1) return 0;
  for (size_t i = 0; i < len; ++i) {
    out[i * 2] = hex_digit(in[i] >> 4, upper);
    out[i * 2 + 1] = hex_digit(in[i] & 0x0F, upper);
  }
  out[len * 2] = '\0';
  return len * 2;
}

size_t kl_hex_decode(const char *in, size_t len, uint8_t *out, size_t cap) {
  if (!in || (len & 1u) || cap < len / 2) return 0;
  for (size_t i = 0; i < len / 2; ++i) {
    int8_t hi = hex_value(in[i * 2]);
    int8_t lo = hex_value(in[i * 2 + 1]);
    if (hi < 0 || lo < 0) return 0;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return len / 2;
}

static const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

size_t kl_base64_encode(const uint8_t *in, size_t len, char *out, size_t cap) {
  const size_t needed = ((len + 2) / 3) * 4 + 1;
  if (!out || cap < needed) return 0;
  size_t o = 0;
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16;
    if (i + 1 < len) v |= (uint32_t)in[i + 1] << 8;
    if (i + 2 < len) v |= in[i + 2];
    out[o++] = kB64[(v >> 18) & 0x3F];
    out[o++] = kB64[(v >> 12) & 0x3F];
    out[o++] = (i + 1 < len) ? kB64[(v >> 6) & 0x3F] : '=';
    out[o++] = (i + 2 < len) ? kB64[v & 0x3F] : '=';
  }
  out[o] = '\0';
  return o;
}

size_t kl_base64_decode(const char *in, size_t len, uint8_t *out, size_t cap) {
  if (!in || !out) return 0;
  auto value = [](char c) -> int8_t {
    if (c >= 'A' && c <= 'Z') return (int8_t)(c - 'A');
    if (c >= 'a' && c <= 'z') return (int8_t)(c - 'a' + 26);
    if (c >= '0' && c <= '9') return (int8_t)(c - '0' + 52);
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  size_t o = 0;
  uint32_t acc = 0;
  uint8_t bits = 0;
  for (size_t i = 0; i < len; ++i) {
    char c = in[i];
    if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
    int8_t v = value(c);
    if (v < 0) return 0;
    acc = (acc << 6) | (uint32_t)v;
    bits = (uint8_t)(bits + 6);
    if (bits >= 8) {
      bits = (uint8_t)(bits - 8);
      if (o >= cap) return 0;
      out[o++] = (uint8_t)((acc >> bits) & 0xFF);
    }
  }
  return o;
}

/* ---------------------------------------------------------------- SHA256 -- */

static const uint32_t K256[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u,
    0x923f82a4u, 0xab1c5ed5u, 0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u, 0xe49b69c1u, 0xefbe4786u,
    0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u,
    0x06ca6351u, 0x14292967u, 0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u, 0xa2bfe8a1u, 0xa81a664bu,
    0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au,
    0x5b9cca4fu, 0x682e6ff3u, 0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

static inline uint32_t rotr32(uint32_t x, uint8_t n) { return (x >> n) | (x << (32 - n)); }

static void sha256_compress(KlintoSha256 *ctx, const uint8_t block[64]) {
  uint32_t w[64];
  for (int i = 0; i < 16; ++i) {
    w[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) |
           ((uint32_t)block[i * 4 + 2] << 8) | block[i * 4 + 3];
  }
  for (int i = 16; i < 64; ++i) {
    uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3];
  uint32_t e = ctx->state[4], f = ctx->state[5], g = ctx->state[6], h = ctx->state[7];
  for (int i = 0; i < 64; ++i) {
    uint32_t s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
    uint32_t ch = (e & f) ^ ((~e) & g);
    uint32_t t1 = h + s1 + ch + K256[i] + w[i];
    uint32_t s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
    uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = s0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  ctx->state[0] += a;
  ctx->state[1] += b;
  ctx->state[2] += c;
  ctx->state[3] += d;
  ctx->state[4] += e;
  ctx->state[5] += f;
  ctx->state[6] += g;
  ctx->state[7] += h;
}

void kl_sha256_init(KlintoSha256 *ctx) {
  ctx->state[0] = 0x6a09e667u;
  ctx->state[1] = 0xbb67ae85u;
  ctx->state[2] = 0x3c6ef372u;
  ctx->state[3] = 0xa54ff53au;
  ctx->state[4] = 0x510e527fu;
  ctx->state[5] = 0x9b05688cu;
  ctx->state[6] = 0x1f83d9abu;
  ctx->state[7] = 0x5be0cd19u;
  ctx->bits = 0;
  ctx->block_len = 0;
}

void kl_sha256_update(KlintoSha256 *ctx, const void *data, size_t len) {
  const uint8_t *p = (const uint8_t *)data;
  ctx->bits += (uint64_t)len * 8;
  while (len > 0) {
    size_t take = 64 - ctx->block_len;
    if (take > len) take = len;
    memcpy(ctx->block + ctx->block_len, p, take);
    ctx->block_len += take;
    p += take;
    len -= take;
    if (ctx->block_len == 64) {
      sha256_compress(ctx, ctx->block);
      ctx->block_len = 0;
    }
  }
}

void kl_sha256_final(KlintoSha256 *ctx, uint8_t out[KL_SHA256_LEN]) {
  uint64_t bits = ctx->bits;
  uint8_t pad = 0x80;
  kl_sha256_update(ctx, &pad, 1);
  uint8_t zero = 0;
  while (ctx->block_len != 56) kl_sha256_update(ctx, &zero, 1);
  uint8_t len_be[8];
  for (int i = 0; i < 8; ++i) len_be[i] = (uint8_t)(bits >> (56 - i * 8));
  kl_sha256_update(ctx, len_be, 8);
  for (int i = 0; i < 8; ++i) {
    out[i * 4] = (uint8_t)(ctx->state[i] >> 24);
    out[i * 4 + 1] = (uint8_t)(ctx->state[i] >> 16);
    out[i * 4 + 2] = (uint8_t)(ctx->state[i] >> 8);
    out[i * 4 + 3] = (uint8_t)(ctx->state[i]);
  }
}

void kl_sha256(const void *data, size_t len, uint8_t out[KL_SHA256_LEN]) {
  KlintoSha256 ctx;
  kl_sha256_init(&ctx);
  kl_sha256_update(&ctx, data, len);
  kl_sha256_final(&ctx, out);
}

void kl_hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *data, size_t len,
                    uint8_t out[KL_SHA256_LEN]) {
  uint8_t k[64];
  memset(k, 0, sizeof(k));
  if (key_len > 64) {
    kl_sha256(key, key_len, k);
  } else if (key_len) {
    memcpy(k, key, key_len);
  }
  uint8_t ipad[64];
  uint8_t opad[64];
  for (int i = 0; i < 64; ++i) {
    ipad[i] = (uint8_t)(k[i] ^ 0x36);
    opad[i] = (uint8_t)(k[i] ^ 0x5C);
  }
  KlintoSha256 ctx;
  uint8_t inner[32];
  kl_sha256_init(&ctx);
  kl_sha256_update(&ctx, ipad, 64);
  kl_sha256_update(&ctx, data, len);
  kl_sha256_final(&ctx, inner);
  kl_sha256_init(&ctx);
  kl_sha256_update(&ctx, opad, 64);
  kl_sha256_update(&ctx, inner, 32);
  kl_sha256_final(&ctx, out);
}

/* --------------------------------------------------------------- ChaCha20 - */

static inline uint32_t rotl32(uint32_t x, int n) { return (x << n) | (x >> (32 - n)); }

static void chacha20_block(const uint32_t in[16], uint32_t out[16]) {
  uint32_t x[16];
  memcpy(x, in, sizeof(x));
  for (int i = 0; i < 10; ++i) {
    x[0] += x[4]; x[12] = rotl32(x[12] ^ x[0], 16);
    x[8] += x[12]; x[4] = rotl32(x[4] ^ x[8], 12);
    x[0] += x[4]; x[12] = rotl32(x[12] ^ x[0], 8);
    x[8] += x[12]; x[4] = rotl32(x[4] ^ x[8], 7);

    x[1] += x[5]; x[13] = rotl32(x[13] ^ x[1], 16);
    x[9] += x[13]; x[5] = rotl32(x[5] ^ x[9], 12);
    x[1] += x[5]; x[13] = rotl32(x[13] ^ x[1], 8);
    x[9] += x[13]; x[5] = rotl32(x[5] ^ x[9], 7);

    x[2] += x[6]; x[14] = rotl32(x[14] ^ x[2], 16);
    x[10] += x[14]; x[6] = rotl32(x[6] ^ x[10], 12);
    x[2] += x[6]; x[14] = rotl32(x[14] ^ x[2], 8);
    x[10] += x[14]; x[6] = rotl32(x[6] ^ x[10], 7);

    x[3] += x[7]; x[15] = rotl32(x[15] ^ x[3], 16);
    x[11] += x[15]; x[7] = rotl32(x[7] ^ x[11], 12);
    x[3] += x[7]; x[15] = rotl32(x[15] ^ x[3], 8);
    x[11] += x[15]; x[7] = rotl32(x[7] ^ x[11], 7);

    x[0] += x[5]; x[15] = rotl32(x[15] ^ x[0], 16);
    x[10] += x[15]; x[5] = rotl32(x[5] ^ x[10], 12);
    x[0] += x[5]; x[15] = rotl32(x[15] ^ x[0], 8);
    x[10] += x[15]; x[5] = rotl32(x[5] ^ x[10], 7);

    x[1] += x[6]; x[12] = rotl32(x[12] ^ x[1], 16);
    x[11] += x[12]; x[6] = rotl32(x[6] ^ x[11], 12);
    x[1] += x[6]; x[12] = rotl32(x[12] ^ x[1], 8);
    x[11] += x[12]; x[6] = rotl32(x[6] ^ x[11], 7);

    x[2] += x[7]; x[13] = rotl32(x[13] ^ x[2], 16);
    x[8] += x[13]; x[7] = rotl32(x[7] ^ x[8], 12);
    x[2] += x[7]; x[13] = rotl32(x[13] ^ x[2], 8);
    x[8] += x[13]; x[7] = rotl32(x[7] ^ x[8], 7);

    x[3] += x[4]; x[14] = rotl32(x[14] ^ x[3], 16);
    x[9] += x[14]; x[4] = rotl32(x[4] ^ x[9], 12);
    x[3] += x[4]; x[14] = rotl32(x[14] ^ x[3], 8);
    x[9] += x[14]; x[4] = rotl32(x[4] ^ x[9], 7);
  }
  for (int i = 0; i < 16; ++i) out[i] = x[i] + in[i];
}

void kl_chacha20_xor(const uint8_t key[32], const uint8_t nonce[12], uint32_t counter,
                     const uint8_t *in, uint8_t *out, size_t len) {
  uint32_t state[16];
  state[0] = 0x61707865u;
  state[1] = 0x3320646eu;
  state[2] = 0x79622d32u;
  state[3] = 0x6b206574u;
  for (int i = 0; i < 8; ++i) {
    state[4 + i] = (uint32_t)key[i * 4] | ((uint32_t)key[i * 4 + 1] << 8) |
                   ((uint32_t)key[i * 4 + 2] << 16) | ((uint32_t)key[i * 4 + 3] << 24);
  }
  state[12] = counter;
  for (int i = 0; i < 3; ++i) {
    state[13 + i] = (uint32_t)nonce[i * 4] | ((uint32_t)nonce[i * 4 + 1] << 8) |
                    ((uint32_t)nonce[i * 4 + 2] << 16) | ((uint32_t)nonce[i * 4 + 3] << 24);
  }
  uint8_t stream[64];
  size_t offset = 0;
  while (offset < len) {
    uint32_t block[16];
    chacha20_block(state, block);
    for (int i = 0; i < 16; ++i) {
      stream[i * 4] = (uint8_t)block[i];
      stream[i * 4 + 1] = (uint8_t)(block[i] >> 8);
      stream[i * 4 + 2] = (uint8_t)(block[i] >> 16);
      stream[i * 4 + 3] = (uint8_t)(block[i] >> 24);
    }
    size_t take = len - offset;
    if (take > 64) take = 64;
    for (size_t i = 0; i < take; ++i) out[offset + i] = in[offset + i] ^ stream[i];
    offset += take;
    state[12] += 1;
  }
}

/* -------------------------------------------------------------- snowflake - */

static std::atomic<uint16_t> g_snowflake_seq(0);

uint64_t kl_snowflake_next(uint32_t node_id, uint32_t now_ms) {
  uint64_t ts = kl_epoch_ms();
  if (ts == 0) {
    /* Fallback: 32-bit uptime. Still unique per boot and node. */
    ts = 1700000000000ULL + (uint64_t)now_ms;
  }
  uint16_t seq = g_snowflake_seq.fetch_add(1, std::memory_order_relaxed) & 0x3FF;
  return ((ts & 0x3FFFFFFFFFFULL) << 22) | ((uint64_t)(node_id & 0xFFF) << 10) | seq;
}

uint64_t kl_snowflake_timestamp(uint64_t id) { return (id >> 22) & 0x3FFFFFFFFFFULL; }

/* ------------------------------------------------------------------- misc -- */

uint32_t kl_read_le32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

uint64_t kl_read_le64(const uint8_t *p) {
  return (uint64_t)kl_read_le32(p) | ((uint64_t)kl_read_le32(p + 4) << 32);
}

void kl_write_le32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}

void kl_write_le64(uint8_t *p, uint64_t v) {
  kl_write_le32(p, (uint32_t)v);
  kl_write_le32(p + 4, (uint32_t)(v >> 32));
}

int16_t kl_read_le16(const uint8_t *p) { return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8)); }

void kl_write_le16(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
}

uint8_t kl_rssi_to_quality(int16_t rssi) {
  if (rssi <= -120) return 0;
  if (rssi >= -30) return 100;
  return (uint8_t)(((rssi + 120) * 100) / 90);
}
