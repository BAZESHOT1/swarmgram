/**
 * Klinto KMesh_v1 — единый частотный план ESP-NOW ↔ LoRa.
 *
 * Каждому Wi-Fi каналу 1..13 соответствует LoRa-подканал с неперекрывающейся
 * полосой и уникальным SyncWord. Это позволяет одной и той же паре
 * (Wi-Fi канал + LoRa-подканал) образовывать независимую радиосоту.
 */
#ifndef KLINTO_CHANNEL_PLAN_H
#define KLINTO_CHANNEL_PLAN_H

#include "klinto_config.h"

#define KL_CHANNEL_COUNT 13
#define KL_FALLBACK_OFFLINE_CHANNEL 1

enum kl_plan_band_t : uint8_t {
  KL_BAND_433 = 0,
  KL_BAND_868 = 1
};

struct kl_channel_plan_entry_t {
  uint8_t wifi_channel;    /* 1..13 */
  uint32_t lora_freq_hz;   /* центр подканала */
  uint16_t lora_bw_khz;    /* 125 */
  uint8_t lora_sync_word;  /* уникален для соты */
  uint8_t lora_sf;         /* 9 */
};

/** Вернуть запись плана для Wi-Fi канала и диапазона. */
const kl_channel_plan_entry_t *kl_channel_plan_entry(uint8_t wifi_channel, uint8_t band);

/** Определить диапазон по текущей частоте конфигурации. */
uint8_t kl_channel_plan_band_for_freq(float freq_mhz);

/**
 * Применить план к конфигурации: wifi_channel, lora.freq_mhz, sync_word.
 * Возвращает false для канала вне 1..13.
 */
bool kl_channel_plan_apply(kl_config_t *cfg, uint8_t wifi_channel);

/** Ближайший Wi-Fi канал для частоты (для миграции старых конфигов). */
uint8_t kl_channel_plan_nearest(float freq_mhz);

#endif  // KLINTO_CHANNEL_PLAN_H
