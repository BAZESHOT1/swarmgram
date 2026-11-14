/**
 * Klinto KMesh_v1 — каскадная радио-OTA на бинарных дельта-патчах.
 *
 * Узел получает OTA_ANNOUNCE, собирает чанки патча в LittleFS, проверяет
 * SHA-256 и подпись манифеста ключом разработчика (KL_OTA_PUBKEY), затем
 * потоково накатывает патч в неактивный OTA-слот. Источник (шлюз/роутер)
 * раздаёт чанки окнами по 32 и досылает потерянные по OTA_NACK.
 */
#ifndef KLINTO_OTA_H
#define KLINTO_OTA_H

#include "klinto_config.h"
#include "klinto_packet.h"

#define KL_OTA_CHUNK_DATA 180
#define KL_OTA_WINDOW 32
#define KL_OTA_MAX_SIG 72
#define KL_OTA_MAX_CHUNKS 4096
#define KL_OTA_BATTERY_MIN 40
#define KL_OTA_NACK_INTERVAL_MS 2000u
#define KL_OTA_ANNOUNCE_INTERVAL_MS 60000u
#define KL_OTA_SOURCE_WINDOW_DELAY_MS 1500u

struct kl_ota_manifest_t {
  uint16_t patch_id;
  uint8_t chip;
  uint16_t base_build;
  uint16_t target_build;
  uint16_t total_chunks;
  uint32_t patch_size;
  uint8_t patch_sha256[32];
  uint8_t target_sha256[32];
  uint8_t sig_len;
  uint8_t sig[KL_OTA_MAX_SIG];
};

size_t kl_ota_encode_announce(const kl_ota_manifest_t *m, uint8_t *out, size_t cap);
bool kl_ota_decode_announce(const uint8_t *payload, size_t len, kl_ota_manifest_t *out);
size_t kl_ota_encode_chunk(uint16_t patch_id, uint16_t index, const uint8_t *data, uint8_t len,
                           uint8_t *out, size_t cap);
bool kl_ota_decode_chunk(const uint8_t *payload, size_t len, uint16_t *patch_id, uint16_t *index,
                         const uint8_t **data, uint8_t *data_len);
size_t kl_ota_encode_nack(uint16_t patch_id, uint16_t window_start, uint32_t bitmask,
                          uint8_t *out, size_t cap);
bool kl_ota_decode_nack(const uint8_t *payload, size_t len, uint16_t *patch_id,
                        uint16_t *window_start, uint32_t *bitmask);

/** Канонический digest манифеста для подписи ECDSA P-256. */
void kl_ota_manifest_digest(const kl_ota_manifest_t *m, uint8_t out[32]);

struct kl_ota_platform_t {
  void *ctx;
  /** Файл патча в LittleFS (/ota/patch.bin): запись/чтение/очистка. */
  bool (*patch_write)(void *ctx, uint32_t offset, const uint8_t *data, size_t len);
  bool (*patch_read)(void *ctx, uint32_t offset, uint8_t *out, size_t len);
  bool (*patch_erase)(void *ctx);
  /** Чтение текущего (running) раздела. */
  bool (*read_running)(void *ctx, uint32_t offset, uint8_t *out, size_t len);
  /** Неактивный OTA-слот. */
  bool (*begin_target)(void *ctx, uint32_t target_size);
  bool (*write_target)(void *ctx, const uint8_t *data, size_t len);
  bool (*commit_target)(void *ctx, const uint8_t sha[32], const kl_ota_manifest_t *m);
  void (*abort_target)(void *ctx);
  void (*reboot)(void *ctx);
  /** Проверка подписи манифеста публичным ключом разработчика. */
  bool (*verify_signature)(void *ctx, const uint8_t digest[32], const uint8_t *sig, size_t sig_len);
  void (*mark_valid)(void *ctx);
};

typedef bool (*kl_ota_send_t)(void *ctx, uint8_t type, const uint8_t *payload, size_t len,
                              bool broadcast);

class KlintoOta {
 public:
  KlintoOta();

  void init(const kl_ota_platform_t *platform, uint8_t chip_arch, uint16_t current_build,
            uint16_t stored_build);
  void set_send(kl_ota_send_t send, void *ctx) {
    send_ = send;
    send_ctx_ = ctx;
  }
  void set_state_cb(void (*cb)(void *, uint8_t), void *ctx) {
    state_cb_ = cb;
    state_ctx_ = ctx;
  }
  void set_battery(uint8_t percent, bool charging);
  void set_current_build(uint16_t build) { current_build_ = build; }
  uint16_t current_build() const { return current_build_; }
  uint16_t target_build() const { return manifest_.target_build; }
  uint8_t state() const { return state_; }
  bool busy() const { return state_ != KL_OTA_IDLE; }
  bool source_active() const { return source_; }

  /** Обработать OTA_ANNOUNCE / OTA_CHUNK / OTA_NACK. true = пакет потреблён. */
  bool handle_packet(const kl_packet_t *pkt, uint32_t now_ms);
  /** Таймеры: NACK, приём/применение, раздача чанков, перезагрузка. */
  void tick(uint32_t now_ms);
  /** Пометить текущую прошивку рабочей после 30 секунд стабильной работы. */
  void mark_boot_valid();
  /** Источник: начать раздачу (патч уже записан в /ota/patch.bin). */
  bool start_source(const kl_ota_manifest_t &m);
  void stop_source() { source_ = false; }

 private:
  void set_state(uint8_t s);
  void send_packet(uint8_t type, const uint8_t *payload, size_t len, bool broadcast);
  void send_nack(uint32_t now_ms);
  void maybe_finish_download(uint32_t now_ms);
  bool apply_patch();
  void gossip_tick(uint32_t now_ms);
  void handle_announce(const kl_ota_manifest_t &m, uint32_t now_ms);
  void handle_chunk(uint16_t patch_id, uint16_t index, const uint8_t *data, uint8_t len,
                    uint32_t now_ms);
  void handle_nack(uint16_t patch_id, uint16_t window_start, uint32_t mask, uint32_t now_ms);
  bool chunk_received(uint16_t index) const;
  void set_chunk(uint16_t index);

  kl_ota_platform_t platform_;
  bool has_platform_;
  kl_ota_send_t send_;
  void *send_ctx_;
  void (*state_cb_)(void *, uint8_t);
  void *state_ctx_;

  uint8_t chip_arch_;
  uint16_t current_build_;
  uint16_t stored_build_;
  uint8_t battery_pct_;
  bool charging_;
  uint8_t state_;

  kl_ota_manifest_t manifest_;
  bool has_manifest_;
  bool deferred_;
  uint32_t received_bits_[KL_OTA_MAX_CHUNKS / 32];
  uint16_t received_count_;
  uint16_t window_start_;
  uint32_t last_packet_ms_;
  uint32_t last_nack_ms_;
  uint32_t finish_at_ms_;
  uint32_t reboot_at_ms_;

  bool source_;
  uint16_t source_next_;
  uint32_t source_window_ms_;
  uint32_t last_announce_ms_;
  uint32_t resend_mask_;
  uint16_t resend_window_;
};

#endif  // KLINTO_OTA_H
