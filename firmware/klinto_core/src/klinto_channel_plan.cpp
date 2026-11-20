#include "klinto_channel_plan.h"

#include <stddef.h>

/*
 * 433 МГц: 433.0625 + (N-1)*0.125 МГц.
 * 13 каналов занимают 433.0625..434.5625 МГц, полосы 125 кГц стыкуются
 * без перекрытия. Это основной план для 13 радиосот.
 *
 * 868 МГц: 868.100 + (N-1)*0.200 МГц, полоса 125 кГц, защитный интервал
 * 75 кГц. Итоговый диапазон 868.100..870.500 МГц; конкретная страна может
 * ограничивать его — тогда используйте 433-й план или укоротите таблицу.
 */
static const kl_channel_plan_entry_t kPlan433[KL_CHANNEL_COUNT] = {
    {1, 433062500u, 125, 0x11, 7}, {2, 433187500u, 125, 0x12, 7},
    {3, 433312500u, 125, 0x13, 7}, {4, 433437500u, 125, 0x14, 7},
    {5, 433562500u, 125, 0x15, 7}, {6, 433687500u, 125, 0x16, 7},
    {7, 433812500u, 125, 0x17, 7}, {8, 433937500u, 125, 0x18, 7},
    {9, 434062500u, 125, 0x19, 7}, {10, 434187500u, 125, 0x1A, 7},
    {11, 434312500u, 125, 0x1B, 7}, {12, 434437500u, 125, 0x1C, 7},
    {13, 434562500u, 125, 0x1D, 7},
};

static const kl_channel_plan_entry_t kPlan868[KL_CHANNEL_COUNT] = {
    {1, 868100000u, 125, 0x11, 7}, {2, 868300000u, 125, 0x12, 7},
    {3, 868500000u, 125, 0x13, 7}, {4, 868700000u, 125, 0x14, 7},
    {5, 868900000u, 125, 0x15, 7}, {6, 869100000u, 125, 0x16, 7},
    {7, 869300000u, 125, 0x17, 7}, {8, 869500000u, 125, 0x18, 7},
    {9, 869700000u, 125, 0x19, 7}, {10, 869900000u, 125, 0x1A, 7},
    {11, 870100000u, 125, 0x1B, 7}, {12, 870300000u, 125, 0x1C, 7},
    {13, 870500000u, 125, 0x1D, 7},
};

const kl_channel_plan_entry_t *kl_channel_plan_entry(uint8_t wifi_channel, uint8_t band) {
  if (wifi_channel < 1 || wifi_channel > KL_CHANNEL_COUNT) return NULL;
  const kl_channel_plan_entry_t *plan = band == KL_BAND_433 ? kPlan433 : kPlan868;
  return &plan[wifi_channel - 1];
}

uint8_t kl_channel_plan_band_for_freq(float freq_mhz) {
  return freq_mhz > 0.0f && freq_mhz < 500.0f ? KL_BAND_433 : KL_BAND_868;
}

bool kl_channel_plan_apply(kl_config_t *cfg, uint8_t wifi_channel) {
  if (!cfg || wifi_channel < 1 || wifi_channel > KL_CHANNEL_COUNT) return false;
  const uint8_t band = kl_channel_plan_band_for_freq(cfg->lora.freq_mhz);
  const kl_channel_plan_entry_t *entry = kl_channel_plan_entry(wifi_channel, band);
  if (!entry) return false;
  cfg->wifi_channel = wifi_channel;
  cfg->lora.freq_mhz = (float)entry->lora_freq_hz / 1000000.0f;
  cfg->lora.sync_word = entry->lora_sync_word;
  cfg->lora.bw_khz = (float)entry->lora_bw_khz;
  cfg->lora.sf = entry->lora_sf;
  cfg->lora_present = cfg->lora_present;
  return true;
}

uint8_t kl_channel_plan_nearest(float freq_mhz) {
  if (freq_mhz <= 0.0f) return KL_FALLBACK_OFFLINE_CHANNEL;
  const uint8_t band = kl_channel_plan_band_for_freq(freq_mhz);
  const uint32_t hz = (uint32_t)(freq_mhz * 1000000.0f);
  uint8_t best = 1;
  uint32_t best_delta = 0xFFFFFFFFu;
  for (uint8_t ch = 1; ch <= KL_CHANNEL_COUNT; ++ch) {
    const kl_channel_plan_entry_t *entry = kl_channel_plan_entry(ch, band);
    const uint32_t delta = entry->lora_freq_hz > hz ? entry->lora_freq_hz - hz : hz - entry->lora_freq_hz;
    if (delta < best_delta) {
      best_delta = delta;
      best = ch;
    }
  }
  return best;
}
