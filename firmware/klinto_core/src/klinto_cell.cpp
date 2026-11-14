#include "klinto_cell.h"

#include <string.h>

KlintoCellManager::KlintoCellManager()
    : state_(KL_CELL_LOCKED),
      current_channel_(KL_FALLBACK_OFFLINE_CHANNEL),
      scan_index_(0),
      scan_cycle_(0),
      scan_deadline_ms_(0),
      last_scan_ms_(0),
      last_beacon_ms_(0),
      missed_beacons_(0),
      weak_beacons_(0),
      scan_reason_(KL_SCAN_BOOT),
      found_(false),
      best_channel_(KL_FALLBACK_OFFLINE_CHANNEL),
      best_gateway_(0),
      best_rssi_(-127),
      best_hops_(0xFF) {
  memset(&cfg_, 0, sizeof(cfg_));
  memset(&cell_, 0, sizeof(cell_));
  memset(&host_, 0, sizeof(host_));
}

void KlintoCellManager::init(const kl_config_t *cfg, const kl_cell_host_t *host) {
  if (cfg) cfg_ = *cfg;
  if (host) host_ = *host;

  cell_.role = cfg_.role;
  cell_.fallback_channel = KL_FALLBACK_OFFLINE_CHANNEL;
  cell_.scan_dwell_ms = 120;
  cell_.rescan_interval_ms = 0;      /* здоровую соту не трогаем */
  cell_.offline_rescan_ms = 15000;   /* быстрый возврат к поиску шлюза */
  cell_.handover_rssi = -85;
  cell_.beacon_miss_limit = 3;
  cell_.beacon_timeout_ms = 20000;   /* четыре пропущенных маяка по 5 с */
  cell_.max_scan_cycles = 2;

  state_ = cfg_.role == KL_ROLE_GATEWAY ? KL_CELL_LOCKED : KL_CELL_SCANNING;
  current_channel_ = cfg_.wifi_channel >= 1 && cfg_.wifi_channel <= KL_CHANNEL_COUNT
                         ? cfg_.wifi_channel
                         : cell_.fallback_channel;
  scan_index_ = 0;
  scan_cycle_ = 0;
  found_ = false;
  missed_beacons_ = 0;
  weak_beacons_ = 0;
  best_gateway_ = 0;
  best_rssi_ = -127;
  best_hops_ = 0xFF;
}

bool KlintoCellManager::apply(uint8_t channel) {
  const uint8_t band = kl_channel_plan_band_for_freq(cfg_.lora.freq_mhz);
  const kl_channel_plan_entry_t *entry = kl_channel_plan_entry(channel, band);
  if (!entry) return false;
  kl_channel_plan_apply(&cfg_, channel);
  current_channel_ = channel;
  if (host_.apply_channel) return host_.apply_channel(host_.ctx, channel);
  return true;
}

void KlintoCellManager::reset_candidate() {
  found_ = false;
  best_channel_ = cell_.fallback_channel;
  best_gateway_ = 0;
  best_rssi_ = -127;
  best_hops_ = 0xFF;
}

void KlintoCellManager::lock_gateway(uint8_t channel, uint32_t now_ms) {
  if (channel < 1 || channel > KL_CHANNEL_COUNT) channel = cell_.fallback_channel;
  state_ = KL_CELL_LOCKED;
  apply(channel);
  last_beacon_ms_ = now_ms;
  last_scan_ms_ = now_ms;
  missed_beacons_ = 0;
  weak_beacons_ = 0;
}

void KlintoCellManager::start_scan(uint32_t now_ms, uint8_t reason) {
  if (cell_.role == KL_ROLE_GATEWAY) return;
  state_ = KL_CELL_SCANNING;
  scan_index_ = 0;
  scan_cycle_ = 0;
  scan_reason_ = reason;
  scan_deadline_ms_ = now_ms;
  last_scan_ms_ = now_ms;
  reset_candidate();
  /* Первый канал применяем сразу; tick() удержит его dwell_ms. */
  apply(1);
  scan_deadline_ms_ = now_ms + cell_.scan_dwell_ms;
}

void KlintoCellManager::on_beacon(uint32_t gateway_id, uint8_t hops, int16_t rssi,
                                  uint32_t now_ms, uint8_t advertised_channel) {
  const bool channel_valid = advertised_channel >= 1 && advertised_channel <= KL_CHANNEL_COUNT;
  if (state_ == KL_CELL_SCANNING) {
    if (!found_ || rssi > best_rssi_ + 3 || (rssi >= best_rssi_ - 3 && hops < best_hops_)) {
      found_ = true;
      best_channel_ = channel_valid ? advertised_channel : current_channel_;
      best_gateway_ = gateway_id;
      best_rssi_ = rssi;
      best_hops_ = hops;
    }
    return;
  }

  if (state_ == KL_CELL_LOCKED) {
    last_beacon_ms_ = now_ms;
    missed_beacons_ = 0;
    /* Шлюз сменил канал AP — переезжаем сразу, не дожидаясь таймаута. */
    if (channel_valid && advertised_channel != current_channel_) {
      apply(advertised_channel);
    }
    if (rssi < cell_.handover_rssi) {
      if (weak_beacons_ < 0xFF) weak_beacons_++;
      if (weak_beacons_ >= 2) {
        start_scan(now_ms, KL_SCAN_WEAK_RSSI);
      }
    } else {
      weak_beacons_ = 0;
    }
  }
}

void KlintoCellManager::finish_scan(uint32_t now_ms) {
  if (found_) {
    lock_best(now_ms, scan_reason_);
    return;
  }
  scan_cycle_++;
  if (scan_cycle_ >= cell_.max_scan_cycles) {
    enter_offline(now_ms);
    return;
  }
  scan_index_ = 0;
  apply(1);
  scan_deadline_ms_ = now_ms + cell_.scan_dwell_ms;
}

void KlintoCellManager::lock_best(uint32_t now_ms, uint8_t reason) {
  state_ = KL_CELL_LOCKED;
  apply(best_channel_);
  last_beacon_ms_ = now_ms;
  last_scan_ms_ = now_ms;
  missed_beacons_ = 0;
  weak_beacons_ = 0;
  if (host_.on_locked) {
    host_.on_locked(host_.ctx, best_channel_, best_gateway_, best_rssi_, best_hops_, reason);
  }
}

void KlintoCellManager::enter_offline(uint32_t now_ms) {
  state_ = KL_CELL_OFFLINE;
  apply(cell_.fallback_channel);
  last_scan_ms_ = now_ms;
  missed_beacons_ = 0;
  weak_beacons_ = 0;
  if (host_.on_offline) host_.on_offline(host_.ctx, current_channel_);
}

void KlintoCellManager::tick(uint32_t now_ms) {
  if (cell_.role == KL_ROLE_GATEWAY) {
    state_ = KL_CELL_LOCKED;
    return;
  }

  if (state_ == KL_CELL_SCANNING) {
    if (now_ms < scan_deadline_ms_) return;
    if (scan_index_ + 1 >= KL_CHANNEL_COUNT) {
      finish_scan(now_ms);
      return;
    }
    scan_index_++;
    apply((uint8_t)(scan_index_ + 1));
    scan_deadline_ms_ = now_ms + cell_.scan_dwell_ms;
    return;
  }

  if (state_ == KL_CELL_LOCKED) {
    if (now_ms - last_beacon_ms_ > cell_.beacon_timeout_ms) {
      start_scan(now_ms, KL_SCAN_BEACON_LOST);
      return;
    }
    if (cell_.rescan_interval_ms > 0 && now_ms - last_scan_ms_ > cell_.rescan_interval_ms) {
      start_scan(now_ms, KL_SCAN_PERIODIC);
    }
    return;
  }

  if (state_ == KL_CELL_OFFLINE) {
    if (now_ms - last_scan_ms_ > cell_.offline_rescan_ms) {
      start_scan(now_ms, KL_SCAN_PERIODIC);
    }
  }
}
