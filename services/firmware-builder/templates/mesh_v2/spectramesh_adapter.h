/**
 * spectramesh_adapter.c/h — hue-абстракция SpectraMesh для Kinto.
 *
 * Каждый радиоинтерфейс — hue: Wi-Fi, LoRa, BLE. Маршрут выбирает hue по
 * метрике (потери, задержка, очередь). LoRa не используется для медиа.
 */
#ifndef KINTO_SPECTRAMESH_ADAPTER_H
#define KINTO_SPECTRAMESH_ADAPTER_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  KINTO_HUE_NONE = 0,
  KINTO_HUE_WIFI = 1,
  KINTO_HUE_LORA = 2,
  KINTO_HUE_BLE = 3,
} kinto_hue_t;

typedef struct {
  float delivery_ratio; /* 0..1 */
  float latency_ms;     /* EWMA */
  uint8_t queue_depth;  /* 0..255 */
  bool available;
} kinto_hue_stats_t;

typedef struct {
  kinto_hue_t hue;
  float metric;
} kinto_hue_choice_t;

/** metric = (1-delivery)*w_loss + latency*w_latency + queue*w_queue */
float kinto_hue_metric(const kinto_hue_stats_t *stats);

/** Выбирает лучший hue. Медиа — только Wi-Fi. */
kinto_hue_t kinto_select_hue(const kinto_hue_stats_t stats[4], bool is_media);

/** Все доступные hue по возрастанию метрики (для multipath/handover). */
unsigned kinto_rank_hues(const kinto_hue_stats_t stats[4], kinto_hue_choice_t *out, unsigned cap);

/** TTL: Wi-Fi и LoRa имеют разные бюджеты, конвертация при переходе. */
uint8_t kinto_hue_ttl(kinto_hue_t hue, uint8_t ttl);

#ifdef __cplusplus
}
#endif

#endif /* KINTO_SPECTRAMESH_ADAPTER_H */
