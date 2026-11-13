#include "klinto_dedup.h"

#include <string.h>

KlintoDedup::KlintoDedup() : cursor_(0) { memset(entries_, 0, sizeof(entries_)); }

bool KlintoDedup::seen(uint32_t src_id, uint32_t packet_id, uint32_t now_ms) {
  KlintoGuard guard(lock_);
  for (uint16_t i = 0; i < KL_DEDUP_SIZE; ++i) {
    const kl_dedup_entry_t &e = entries_[i];
    if (!e.used) continue;
    if (now_ms - e.seen_ms > KL_DEDUP_TTL_MS) continue;
    if (e.src_id == src_id && e.packet_id == packet_id) return true;
  }
  return false;
}

bool KlintoDedup::seen_or_add(uint32_t src_id, uint32_t packet_id, uint32_t now_ms) {
  KlintoGuard guard(lock_);
  for (uint16_t i = 0; i < KL_DEDUP_SIZE; ++i) {
    kl_dedup_entry_t &e = entries_[i];
    if (!e.used) continue;
    if (now_ms - e.seen_ms > KL_DEDUP_TTL_MS) {
      e.used = false;
      continue;
    }
    if (e.src_id == src_id && e.packet_id == packet_id) return true;
  }
  kl_dedup_entry_t &slot = entries_[cursor_];
  slot.src_id = src_id;
  slot.packet_id = packet_id;
  slot.seen_ms = now_ms;
  slot.used = true;
  cursor_ = (uint16_t)((cursor_ + 1) % KL_DEDUP_SIZE);
  return false;
}

void KlintoDedup::reset() {
  KlintoGuard guard(lock_);
  memset(entries_, 0, sizeof(entries_));
  cursor_ = 0;
}

uint16_t KlintoDedup::used() const {
  KlintoGuard guard(lock_);
  uint16_t n = 0;
  for (uint16_t i = 0; i < KL_DEDUP_SIZE; ++i) n += entries_[i].used ? 1 : 0;
  return n;
}
