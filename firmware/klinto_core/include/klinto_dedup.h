/**
 * Klinto KMesh_v1 — кольцевой буфер дедупликации маршрутизации.
 *
 * 512 записей (около 9 КБ) покрывают несколько минут трафика
 * плотной соты на 1000+ узлов.
 */
#ifndef KLINTO_DEDUP_H
#define KLINTO_DEDUP_H

#include "klinto_util.h"

#define KL_DEDUP_SIZE 512
#define KL_DEDUP_TTL_MS 60000u

struct kl_dedup_entry_t {
  uint32_t src_id;
  uint32_t packet_id;
  uint32_t seen_ms;
  bool used;
};

class KlintoDedup {
 public:
  KlintoDedup();
  /** Returns true if the pair was already seen; otherwise records it. */
  bool seen_or_add(uint32_t src_id, uint32_t packet_id, uint32_t now_ms);
  bool seen(uint32_t src_id, uint32_t packet_id, uint32_t now_ms);
  void reset();
  uint16_t used() const;

 private:
  kl_dedup_entry_t entries_[KL_DEDUP_SIZE];
  uint16_t cursor_;
  mutable KlintoLock lock_;
};

#endif  // KLINTO_DEDUP_H
