/**
 * Klinto KMesh_v1 — общие утилиты.
 *
 * Портативный C++11 без Arduino/ESP-IDF. Платформенные хуки слабые:
 * один и тот же код работает на ESP32 и в host-тестах.
 */
#ifndef KLINTO_UTIL_H
#define KLINTO_UTIL_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <atomic>

#ifndef KL_PACKED
#define KL_PACKED __attribute__((packed))
#endif

/* ------------------------------------------------------------ platform --- */

/** Monotonic milliseconds. Weak default returns 0 (tests override). */
uint32_t kl_uptime_ms();
/** Unix epoch milliseconds, or 0 when the clock is not synced. */
uint64_t kl_epoch_ms();
/** Cryptographic RNG. Weak default is a test-only xorshift. */
void kl_random_bytes(uint8_t *out, size_t len);
/** 32-bit identity hash (FNV-1a). */
uint32_t kl_fnv1a32(const char *text);

/* --------------------------------------------------------------- locks --- */

/**
 * Короткий spinlock. Критические секции ядра занимают сотни микросекунд;
 * ISR-колбэки его не берут — они только ставят кадры в очередь.
 */
class KlintoLock {
 public:
  KlintoLock() : flag_(false) {}
  void lock() {
    while (flag_.exchange(true, std::memory_order_acquire)) {
    }
  }
  void unlock() { flag_.store(false, std::memory_order_release); }
  bool try_lock() { return !flag_.exchange(true, std::memory_order_acquire); }

 private:
  std::atomic<bool> flag_;
  KlintoLock(const KlintoLock &);
  KlintoLock &operator=(const KlintoLock &);
};

class KlintoGuard {
 public:
  explicit KlintoGuard(KlintoLock &lock) : lock_(lock) { lock_.lock(); }
  ~KlintoGuard() { lock_.unlock(); }

 private:
  KlintoLock &lock_;
  KlintoGuard(const KlintoGuard &);
  KlintoGuard &operator=(const KlintoGuard &);
};

/* ----------------------------------------------------------- checksums --- */

uint16_t kl_crc16(const uint8_t *data, size_t len, uint16_t init = 0xFFFF);
uint32_t kl_crc32(const uint8_t *data, size_t len, uint32_t init = 0xFFFFFFFF);

/* --------------------------------------------------------------- hex/b64 -- */

size_t kl_hex_encode(const uint8_t *in, size_t len, char *out, size_t cap, bool upper = false);
size_t kl_hex_decode(const char *in, size_t len, uint8_t *out, size_t cap);
size_t kl_base64_encode(const uint8_t *in, size_t len, char *out, size_t cap);
size_t kl_base64_decode(const char *in, size_t len, uint8_t *out, size_t cap);

/* ---------------------------------------------------------------- SHA256 -- */

#define KL_SHA256_LEN 32
struct KlintoSha256 {
  uint32_t state[8];
  uint64_t bits;
  uint8_t block[64];
  size_t block_len;
};

void kl_sha256_init(KlintoSha256 *ctx);
void kl_sha256_update(KlintoSha256 *ctx, const void *data, size_t len);
void kl_sha256_final(KlintoSha256 *ctx, uint8_t out[KL_SHA256_LEN]);
void kl_sha256(const void *data, size_t len, uint8_t out[KL_SHA256_LEN]);
void kl_hmac_sha256(const uint8_t *key, size_t key_len, const uint8_t *data, size_t len,
                    uint8_t out[KL_SHA256_LEN]);

/* --------------------------------------------------------------- ChaCha20 - */

/** ChaCha20 stream XOR. key = 32 bytes, nonce = 12 bytes. */
void kl_chacha20_xor(const uint8_t key[32], const uint8_t nonce[12], uint32_t counter,
                     const uint8_t *in, uint8_t *out, size_t len);

/* -------------------------------------------------------------- snowflake - */

/** 64-bit message UUID: 42-bit ms timestamp, 12-bit node, 10-bit sequence. */
uint64_t kl_snowflake_next(uint32_t node_id, uint32_t now_ms);
/** Recover the timestamp encoded in a snowflake (for TTL/ordering checks). */
uint64_t kl_snowflake_timestamp(uint64_t id);

/* ------------------------------------------------------------------- misc -- */

uint32_t kl_read_le32(const uint8_t *p);
uint64_t kl_read_le64(const uint8_t *p);
void kl_write_le32(uint8_t *p, uint32_t v);
void kl_write_le64(uint8_t *p, uint64_t v);
int16_t kl_read_le16(const uint8_t *p);
void kl_write_le16(uint8_t *p, uint16_t v);

/** Map RSSI (dBm) to a 0..100 link quality value. */
uint8_t kl_rssi_to_quality(int16_t rssi);

#endif  // KLINTO_UTIL_H
