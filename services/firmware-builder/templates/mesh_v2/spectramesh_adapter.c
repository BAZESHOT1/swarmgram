#include "spectramesh_adapter.h"

#define KINTO_W_LOSS 1.0f
#define KINTO_W_LATENCY 0.02f
#define KINTO_W_QUEUE 0.6f

float kinto_hue_metric(const kinto_hue_stats_t *stats) {
  if (!stats || !stats->available) return 1.0e9f;
  float delivery = stats->delivery_ratio;
  if (delivery < 0.0f) delivery = 0.0f;
  if (delivery > 1.0f) delivery = 1.0f;
  float latency = stats->latency_ms < 0.0f ? 0.0f : stats->latency_ms;
  return (1.0f - delivery) * KINTO_W_LOSS +
         latency * KINTO_W_LATENCY +
         ((float)stats->queue_depth / 255.0f) * KINTO_W_QUEUE;
}

kinto_hue_t kinto_select_hue(const kinto_hue_stats_t stats[4], bool is_media) {
  kinto_hue_t best = KINTO_HUE_NONE;
  float best_metric = 1.0e9f;
  for (unsigned i = 1; i < 4; i++) {
    if (!stats[i].available) continue;
    if (is_media && i != KINTO_HUE_WIFI) continue;
    const float metric = kinto_hue_metric(&stats[i]);
    if (metric < best_metric) {
      best_metric = metric;
      best = (kinto_hue_t)i;
    }
  }
  return best;
}

unsigned kinto_rank_hues(const kinto_hue_stats_t stats[4], kinto_hue_choice_t *out, unsigned cap) {
  if (!out || !cap) return 0;
  unsigned count = 0;
  for (unsigned i = 1; i < 4 && count < cap; i++) {
    if (!stats[i].available) continue;
    kinto_hue_choice_t item = {(kinto_hue_t)i, kinto_hue_metric(&stats[i])};
    unsigned pos = count;
    while (pos > 0 && out[pos - 1].metric > item.metric) {
      out[pos] = out[pos - 1];
      pos--;
    }
    out[pos] = item;
    count++;
  }
  return count;
}

uint8_t kinto_hue_ttl(kinto_hue_t hue, uint8_t ttl) {
  if (!ttl) return 0;
  if (hue == KINTO_HUE_LORA) {
    /* LoRa: меньше хопов, но больший радиус; TTL ограничиваем. */
    return ttl > 8 ? 8 : ttl;
  }
  if (hue == KINTO_HUE_WIFI) return ttl > 16 ? 16 : ttl;
  return ttl;
}
