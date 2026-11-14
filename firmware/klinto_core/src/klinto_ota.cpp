#include "klinto_ota.h"
#include "klinto_ota_patcher.h"
#include "klinto_util.h"

#include <stdio.h>
#include <string.h>

namespace {

constexpr uint16_t kMaxChunks = KL_OTA_MAX_CHUNKS;

uint16_t value16(const uint8_t *p) { return (uint16_t)(p[0] | ((uint16_t)p[1] << 8)); }
uint32_t value32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
         ((uint32_t)p[3] << 24);
}

}  // namespace

KlintoOta::KlintoOta()
    : platform_(),
      has_platform_(false),
      send_(nullptr),
      send_ctx_(nullptr),
      state_cb_(nullptr),
      state_ctx_(nullptr),
      chip_arch_(0),
      current_build_(0),
      stored_build_(0),
      battery_pct_(255),
      charging_(true),
      state_(KL_OTA_IDLE),
      manifest_(),
      has_manifest_(false),
      deferred_(false),
      received_count_(0),
      window_start_(0),
      last_packet_ms_(0),
      last_nack_ms_(0),
      finish_at_ms_(0),
      reboot_at_ms_(0),
      source_(false),
      source_next_(0),
      source_window_ms_(0),
      last_announce_ms_(0),
      resend_mask_(0),
      resend_window_(0) {
  memset(&platform_, 0, sizeof(platform_));
  memset(&manifest_, 0, sizeof(manifest_));
}

void KlintoOta::init(const kl_ota_platform_t *platform, uint8_t chip_arch, uint16_t current_build,
                     uint16_t stored_build) {
  if (platform) {
    platform_ = *platform;
    has_platform_ = true;
  }
  chip_arch_ = chip_arch;
  current_build_ = current_build;
  stored_build_ = stored_build > current_build ? stored_build : current_build;
  state_ = KL_OTA_IDLE;
  has_manifest_ = false;
  deferred_ = false;
  memset(received_bits_, 0, sizeof(received_bits_));
  received_count_ = 0;
  window_start_ = 0;
  source_ = false;
}

void KlintoOta::set_state(uint8_t s) {
  if (state_ == s) return;
  state_ = s;
  if (state_cb_) state_cb_(state_ctx_, s);
}

void KlintoOta::set_battery(uint8_t percent, bool charging) {
  battery_pct_ = percent > 100 ? 100 : percent;
  charging_ = charging;
}

void KlintoOta::send_packet(uint8_t type, const uint8_t *payload, size_t len, bool broadcast) {
  if (send_) send_(send_ctx_, type, payload, len, broadcast);
}

/* ------------------------------------------------------------- кодек ----- */

size_t kl_ota_encode_announce(const kl_ota_manifest_t *m, uint8_t *out, size_t cap) {
  if (!m || !out) return 0;
  const size_t need = 78u + m->sig_len;
  if (cap < need || m->sig_len > KL_OTA_MAX_SIG) return 0;
  kl_write_le16(out, m->patch_id);
  out[2] = m->chip;
  kl_write_le16(out + 3, m->base_build);
  kl_write_le16(out + 5, m->target_build);
  kl_write_le16(out + 7, m->total_chunks);
  kl_write_le32(out + 9, m->patch_size);
  memcpy(out + 13, m->patch_sha256, 32);
  memcpy(out + 45, m->target_sha256, 32);
  out[77] = m->sig_len;
  memcpy(out + 78, m->sig, m->sig_len);
  return need;
}

bool kl_ota_decode_announce(const uint8_t *payload, size_t len, kl_ota_manifest_t *out) {
  if (!payload || !out || len < 78) return false;
  const uint8_t sig_len = payload[77];
  if (sig_len > KL_OTA_MAX_SIG || len < 78u + sig_len) return false;
  memset(out, 0, sizeof(*out));
  out->patch_id = value16(payload);
  out->chip = payload[2];
  out->base_build = value16(payload + 3);
  out->target_build = value16(payload + 5);
  out->total_chunks = value16(payload + 7);
  out->patch_size = value32(payload + 9);
  memcpy(out->patch_sha256, payload + 13, 32);
  memcpy(out->target_sha256, payload + 45, 32);
  out->sig_len = sig_len;
  memcpy(out->sig, payload + 78, sig_len);
  return true;
}

size_t kl_ota_encode_chunk(uint16_t patch_id, uint16_t index, const uint8_t *data, uint8_t len,
                           uint8_t *out, size_t cap) {
  if (!out || (!data && len) || len > KL_OTA_CHUNK_DATA || cap < 5u + len) return 0;
  kl_write_le16(out, patch_id);
  kl_write_le16(out + 2, index);
  out[4] = len;
  if (len) memcpy(out + 5, data, len);
  return 5u + len;
}

bool kl_ota_decode_chunk(const uint8_t *payload, size_t len, uint16_t *patch_id, uint16_t *index,
                         const uint8_t **data, uint8_t *data_len) {
  if (!payload || len < 5) return false;
  const uint8_t n = payload[4];
  if (n > KL_OTA_CHUNK_DATA || len < 5u + n) return false;
  if (patch_id) *patch_id = value16(payload);
  if (index) *index = value16(payload + 2);
  if (data) *data = payload + 5;
  if (data_len) *data_len = n;
  return true;
}

size_t kl_ota_encode_nack(uint16_t patch_id, uint16_t window_start, uint32_t bitmask,
                          uint8_t *out, size_t cap) {
  if (!out || cap < 8) return 0;
  kl_write_le16(out, patch_id);
  kl_write_le16(out + 2, window_start);
  kl_write_le32(out + 4, bitmask);
  return 8;
}

bool kl_ota_decode_nack(const uint8_t *payload, size_t len, uint16_t *patch_id,
                        uint16_t *window_start, uint32_t *bitmask) {
  if (!payload || len < 8) return false;
  if (patch_id) *patch_id = value16(payload);
  if (window_start) *window_start = value16(payload + 2);
  if (bitmask) *bitmask = value32(payload + 4);
  return true;
}

void kl_ota_manifest_digest(const kl_ota_manifest_t *m, uint8_t out[32]) {
  if (!m || !out) return;
  char patch_hex[65];
  char target_hex[65];
  kl_hex_encode(m->patch_sha256, 32, patch_hex, sizeof(patch_hex), false);
  kl_hex_encode(m->target_sha256, 32, target_hex, sizeof(target_hex), false);
  char canonical[256];
  const int n = snprintf(canonical, sizeof(canonical),
                         "KLINTO-OTA1|%u|%u|%u|%s|%s|%u|%lu", (unsigned)m->chip,
                         (unsigned)m->base_build, (unsigned)m->target_build, patch_hex, target_hex,
                         (unsigned)m->total_chunks, (unsigned long)m->patch_size);
  if (n <= 0 || (size_t)n >= sizeof(canonical)) {
    memset(out, 0, 32);
    return;
  }
  kl_sha256(canonical, (size_t)n, out);
}

/* ----------------------------------------------------------- приём ------- */

bool KlintoOta::handle_packet(const kl_packet_t *pkt, uint32_t now_ms) {
  if (!pkt) return false;
  if (pkt->type == KL_TYPE_OTA_ANNOUNCE) {
    kl_ota_manifest_t m;
    if (!kl_ota_decode_announce(pkt->payload, pkt->payload_len, &m)) return true;
    if (source_) return true; /* источник уже раздаёт свой патч */
    handle_announce(m, now_ms);
    return true;
  }
  if (pkt->type == KL_TYPE_OTA_CHUNK) {
    uint16_t patch_id = 0;
    uint16_t index = 0;
    const uint8_t *data = nullptr;
    uint8_t len = 0;
    if (!kl_ota_decode_chunk(pkt->payload, pkt->payload_len, &patch_id, &index, &data, &len)) {
      return true;
    }
    if (!source_) handle_chunk(patch_id, index, data, len, now_ms);
    return true;
  }
  if (pkt->type == KL_TYPE_OTA_NACK) {
    uint16_t patch_id = 0;
    uint16_t window = 0;
    uint32_t mask = 0;
    if (!kl_ota_decode_nack(pkt->payload, pkt->payload_len, &patch_id, &window, &mask)) return true;
    if (source_) handle_nack(patch_id, window, mask, now_ms);
    return true;
  }
  return false;
}

void KlintoOta::handle_announce(const kl_ota_manifest_t &m, uint32_t now_ms) {
  if (!has_platform_) return;
  if (m.chip != chip_arch_) return;
  /* Анти-откат: только монотонно растущий build_number. */
  if (m.target_build <= current_build_ || m.target_build <= stored_build_) return;
  if (m.total_chunks == 0 || m.total_chunks > kMaxChunks || m.patch_size == 0) return;
  const uint32_t expected = ((m.patch_size + KL_OTA_CHUNK_DATA - 1) / KL_OTA_CHUNK_DATA);
  if (expected != m.total_chunks) return;

  uint8_t digest[32];
  kl_ota_manifest_digest(&m, digest);
  if (!platform_.verify_signature ||
      !platform_.verify_signature(platform_.ctx, digest, m.sig, m.sig_len)) {
    return; /* без валидной подписи образ не принимается */
  }

  manifest_ = m;
  has_manifest_ = true;

  if (battery_pct_ < KL_OTA_BATTERY_MIN && !charging_) {
    deferred_ = true;
    set_state(KL_OTA_IDLE);
    return;
  }
  deferred_ = false;
  if (platform_.patch_erase) platform_.patch_erase(platform_.ctx);
  memset(received_bits_, 0, sizeof(received_bits_));
  received_count_ = 0;
  window_start_ = 0;
  last_packet_ms_ = now_ms;
  last_nack_ms_ = 0;
  set_state(KL_OTA_DOWNLOADING);
  send_nack(now_ms);
}

void KlintoOta::handle_chunk(uint16_t patch_id, uint16_t index, const uint8_t *data, uint8_t len,
                             uint32_t now_ms) {
  if (state_ != KL_OTA_DOWNLOADING || !has_manifest_) return;
  if (patch_id != manifest_.patch_id || index >= manifest_.total_chunks || !data) return;
  if (!platform_.patch_write) return;
  const uint32_t offset = (uint32_t)index * KL_OTA_CHUNK_DATA;
  if (offset + len > manifest_.patch_size) return;
  if (chunk_received(index)) return;
  if (!platform_.patch_write(platform_.ctx, offset, data, len)) return;
  set_chunk(index);
  received_count_++;
  last_packet_ms_ = now_ms;

  if (received_count_ >= manifest_.total_chunks) {
    set_state(KL_OTA_VERIFYING);
    finish_at_ms_ = now_ms + 50;
  }
}

bool KlintoOta::chunk_received(uint16_t index) const {
  if (index >= KL_OTA_MAX_CHUNKS) return true;
  return (received_bits_[index >> 5] & (1u << (index & 31))) != 0;
}

void KlintoOta::set_chunk(uint16_t index) {
  if (index >= KL_OTA_MAX_CHUNKS) return;
  received_bits_[index >> 5] |= (1u << (index & 31));
}

void KlintoOta::send_nack(uint32_t now_ms) {
  if (!has_manifest_ || state_ != KL_OTA_DOWNLOADING) return;
  uint16_t start = window_start_;
  uint32_t mask = 0;
  for (uint16_t i = 0; i < KL_OTA_WINDOW; ++i) {
    const uint16_t idx = (uint16_t)(start + i);
    if (idx >= manifest_.total_chunks) break;
    if (!chunk_received(idx)) mask |= (1u << i);
  }
  uint8_t payload[8];
  const size_t len = kl_ota_encode_nack(manifest_.patch_id, start, mask, payload, sizeof(payload));
  if (len) send_packet(KL_TYPE_OTA_NACK, payload, len, true);
  last_nack_ms_ = now_ms;
}

void KlintoOta::maybe_finish_download(uint32_t now_ms) {
  if (state_ != KL_OTA_VERIFYING || now_ms < finish_at_ms_) return;
  if (!has_platform_ || !platform_.patch_read) {
    set_state(KL_OTA_FAILED_ROLLBACK);
    return;
  }
  /* Проверяем SHA-256 всего файла патча до применения. */
  KlintoSha256 sha;
  kl_sha256_init(&sha);
  uint8_t buf[512];
  uint32_t offset = 0;
  bool ok = true;
  while (offset < manifest_.patch_size && ok) {
    const uint32_t take = (manifest_.patch_size - offset) > sizeof(buf)
                              ? (uint32_t)sizeof(buf)
                              : (manifest_.patch_size - offset);
    if (!platform_.patch_read(platform_.ctx, offset, buf, take)) {
      ok = false;
      break;
    }
    kl_sha256_update(&sha, buf, take);
    offset += take;
  }
  uint8_t digest[32];
  kl_sha256_final(&sha, digest);
  uint8_t diff = 0;
  for (uint8_t i = 0; i < 32; ++i) diff |= (uint8_t)(digest[i] ^ manifest_.patch_sha256[i]);
  if (!ok || diff != 0) {
    if (platform_.patch_erase) platform_.patch_erase(platform_.ctx);
    set_state(KL_OTA_FAILED_ROLLBACK);
    return;
  }
  if (!apply_patch()) {
    if (platform_.patch_erase) platform_.patch_erase(platform_.ctx);
    set_state(KL_OTA_FAILED_ROLLBACK);
    return;
  }
  if (platform_.patch_erase) platform_.patch_erase(platform_.ctx);
  stored_build_ = manifest_.target_build;
  set_state(KL_OTA_PENDING_REBOOT);
  reboot_at_ms_ = now_ms + 3000;
}

bool KlintoOta::apply_patch() {
  if (!has_platform_ || !platform_.begin_target || !platform_.write_target ||
      !platform_.commit_target || !platform_.read_running) {
    return false;
  }
  uint8_t header[KL_PATCH_HEADER_SIZE];
  if (!platform_.patch_read(platform_.ctx, 0, header, sizeof(header))) return false;
  kl_patch_header_t ph;
  if (!kl_patch_parse_header(header, sizeof(header), &ph)) return false;
  if (!platform_.begin_target(platform_.ctx, ph.target_size)) return false;
  uint8_t sha[32];
  const bool ok = kl_patch_apply_stream(nullptr, 0, platform_.read_running, platform_.ctx,
                                        platform_.write_target, platform_.ctx,
                                        platform_.patch_read, platform_.ctx, sha);
  if (!ok) {
    if (platform_.abort_target) platform_.abort_target(platform_.ctx);
    return false;
  }
  uint8_t diff = 0;
  for (uint8_t i = 0; i < 32; ++i) diff |= (uint8_t)(sha[i] ^ manifest_.target_sha256[i]);
  if (diff != 0 || !platform_.commit_target(platform_.ctx, sha, &manifest_)) {
    if (platform_.abort_target) platform_.abort_target(platform_.ctx);
    return false;
  }
  return true;
}

void KlintoOta::tick(uint32_t now_ms) {
  if (deferred_ && has_manifest_ &&
      (charging_ || battery_pct_ >= KL_OTA_BATTERY_MIN) && state_ == KL_OTA_IDLE) {
    kl_ota_manifest_t m = manifest_;
    deferred_ = false;
    handle_announce(m, now_ms);
  }

  if (state_ == KL_OTA_DOWNLOADING) {
    /* Переход к следующему окну после заполнения текущего. */
    if (now_ms - last_nack_ms_ >= KL_OTA_NACK_INTERVAL_MS) {
      bool window_complete = true;
      for (uint16_t i = 0; i < KL_OTA_WINDOW; ++i) {
        const uint16_t idx = (uint16_t)(window_start_ + i);
        if (idx >= manifest_.total_chunks) break;
        if (!chunk_received(idx)) {
          window_complete = false;
          break;
        }
      }
      if (window_complete && window_start_ + KL_OTA_WINDOW < manifest_.total_chunks) {
        window_start_ = (uint16_t)(window_start_ + KL_OTA_WINDOW);
      }
      send_nack(now_ms);
    }
    /* Защита от зависшей раздачи: повторный анонс не нужен, NACK уже идёт. */
    if (now_ms - last_packet_ms_ > 180000u) set_state(KL_OTA_FAILED_ROLLBACK);
  }

  maybe_finish_download(now_ms);

  if (state_ == KL_OTA_PENDING_REBOOT && reboot_at_ms_ && now_ms >= reboot_at_ms_) {
    reboot_at_ms_ = 0;
    if (has_platform_ && platform_.reboot) platform_.reboot(platform_.ctx);
  }

  gossip_tick(now_ms);
}

void KlintoOta::mark_boot_valid() {
  if (has_platform_ && platform_.mark_valid) platform_.mark_valid(platform_.ctx);
}

/* ---------------------------------------------------------- источник ----- */

bool KlintoOta::start_source(const kl_ota_manifest_t &m) {
  if (!has_platform_ || !platform_.patch_read) return false;
  manifest_ = m;
  has_manifest_ = true;
  source_ = true;
  source_next_ = 0;
  source_window_ms_ = 0;
  last_announce_ms_ = 0;
  resend_mask_ = 0;
  resend_window_ = 0;
  set_state(KL_OTA_IDLE);
  uint8_t payload[200];
  const size_t len = kl_ota_encode_announce(&manifest_, payload, sizeof(payload));
  if (len) send_packet(KL_TYPE_OTA_ANNOUNCE, payload, len, true);
  last_announce_ms_ = kl_uptime_ms();
  return true;
}

void KlintoOta::handle_nack(uint16_t patch_id, uint16_t window_start, uint32_t mask,
                            uint32_t now_ms) {
  (void)now_ms;
  if (!source_ || patch_id != manifest_.patch_id || mask == 0) return;
  resend_window_ = window_start;
  resend_mask_ = mask;
}

void KlintoOta::gossip_tick(uint32_t now_ms) {
  if (!source_) return;
  if (now_ms - last_announce_ms_ >= KL_OTA_ANNOUNCE_INTERVAL_MS) {
    uint8_t payload[200];
    const size_t len = kl_ota_encode_announce(&manifest_, payload, sizeof(payload));
    if (len) send_packet(KL_TYPE_OTA_ANNOUNCE, payload, len, true);
    last_announce_ms_ = now_ms;
  }
  if (now_ms < source_window_ms_) {
    /* окно ещё не истекло */
  } else if (source_next_ < manifest_.total_chunks) {
    const uint16_t end = (uint16_t)(source_next_ + KL_OTA_WINDOW);
    uint8_t data[KL_OTA_CHUNK_DATA];
    uint8_t payload[200];
    for (uint16_t idx = source_next_; idx < end && idx < manifest_.total_chunks; ++idx) {
      const uint32_t offset = (uint32_t)idx * KL_OTA_CHUNK_DATA;
      const uint32_t left = manifest_.patch_size - offset;
      const uint8_t take = (uint8_t)(left > KL_OTA_CHUNK_DATA ? KL_OTA_CHUNK_DATA : left);
      if (!platform_.patch_read(platform_.ctx, offset, data, take)) break;
      const size_t len = kl_ota_encode_chunk(manifest_.patch_id, idx, data, take, payload,
                                             sizeof(payload));
      if (len) send_packet(KL_TYPE_OTA_CHUNK, payload, len, true);
    }
    source_next_ = end;
    source_window_ms_ = now_ms + KL_OTA_SOURCE_WINDOW_DELAY_MS;
  }

  /* Досылка потерянных чанков по NACK (только запрошенное окно). */
  if (resend_mask_ && platform_.patch_read) {
    uint8_t data[KL_OTA_CHUNK_DATA];
    uint8_t payload[200];
    for (uint16_t i = 0; i < KL_OTA_WINDOW; ++i) {
      if (!(resend_mask_ & (1u << i))) continue;
      const uint16_t idx = (uint16_t)(resend_window_ + i);
      if (idx >= manifest_.total_chunks) continue;
      const uint32_t offset = (uint32_t)idx * KL_OTA_CHUNK_DATA;
      const uint32_t left = manifest_.patch_size - offset;
      const uint8_t take = (uint8_t)(left > KL_OTA_CHUNK_DATA ? KL_OTA_CHUNK_DATA : left);
      if (!platform_.patch_read(platform_.ctx, offset, data, take)) break;
      const size_t len = kl_ota_encode_chunk(manifest_.patch_id, idx, data, take, payload,
                                             sizeof(payload));
      if (len) send_packet(KL_TYPE_OTA_CHUNK, payload, len, true);
    }
    resend_mask_ = 0;
  }
}
