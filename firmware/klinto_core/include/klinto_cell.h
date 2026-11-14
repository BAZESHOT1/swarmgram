/**
 * Klinto KMesh_v1 — выбор радиосоты и хэндовер.
 *
 * Логика повторяет сотовую сеть:
 *   • шлюз фиксирует канал, который дал Wi-Fi роутер;
 *   • ретранслятор сканирует 1..13 и фиксируется на лучшем шлюзе;
 *   • носимый узел следит за RSSI и при деградации запускает фоновый скан;
 *   • если шлюзов нет после двух циклов — все уходят на FALLBACK_OFFLINE_CHANNEL.
 *
 * Модуль не зависит от Arduino: все переключения выполняет хост через callback,
 * что позволяет прогонять сценарии в host-тестах.
 */
#ifndef KLINTO_CELL_H
#define KLINTO_CELL_H

#include "klinto_config.h"
#include "klinto_channel_plan.h"

enum kl_cell_state_t : uint8_t {
  KL_CELL_LOCKED = 0,
  KL_CELL_SCANNING = 1,
  KL_CELL_OFFLINE = 2
};

enum kl_cell_scan_reason_t : uint8_t {
  KL_SCAN_BOOT = 0,
  KL_SCAN_WEAK_RSSI = 1,
  KL_SCAN_BEACON_LOST = 2,
  KL_SCAN_PERIODIC = 3
};

struct kl_cell_config_t {
  uint8_t role;
  uint8_t fallback_channel;
  uint16_t scan_dwell_ms;
  uint32_t rescan_interval_ms;
  uint32_t offline_rescan_ms;
  int16_t handover_rssi;
  uint8_t beacon_miss_limit;
  uint32_t beacon_timeout_ms;
  uint8_t max_scan_cycles;
};

struct kl_cell_host_t {
  void *ctx;
  /** Применить частотную пару (ESP-NOW + LoRa) к железу. */
  bool (*apply_channel)(void *ctx, uint8_t wifi_channel);
  /** Сота выбрана; можно отправлять NODE_PRESENCE. */
  void (*on_locked)(void *ctx, uint8_t channel, uint32_t gateway_id, int16_t rssi,
                    uint8_t hops, uint8_t reason);
  /** Шлюзов нет, включён аварийный канал. */
  void (*on_offline)(void *ctx, uint8_t channel);
};

class KlintoCellManager {
 public:
  KlintoCellManager();
  void init(const kl_config_t *cfg, const kl_cell_host_t *host);
  /** Шлюз: зафиксировать канал, полученный от Wi-Fi AP. */
  void lock_gateway(uint8_t channel, uint32_t now_ms);
  /** Запустить скан (например, при старте или потере маяков). */
  void start_scan(uint32_t now_ms, uint8_t reason);
  /** Периодический вызов из mesh-задачи. */
  void tick(uint32_t now_ms);
  /** Любой принятый GW_BEACON. advertised_channel = 0, если шлюз его не передал. */
  void on_beacon(uint32_t gateway_id, uint8_t hops, int16_t rssi, uint32_t now_ms,
                 uint8_t advertised_channel = 0);

  uint8_t channel() const { return current_channel_; }
  uint8_t state() const { return state_; }
  uint32_t best_gateway() const { return best_gateway_; }
  int16_t best_rssi() const { return best_rssi_; }
  bool scanning() const { return state_ == KL_CELL_SCANNING; }
  uint8_t missed_beacons() const { return missed_beacons_; }
  /** Для диагностики/тестов: номер сканируемого канала. */
  uint8_t scan_channel() const { return (uint8_t)(scan_index_ + 1); }

 private:
  bool apply(uint8_t channel);
  void finish_scan(uint32_t now_ms);
  void lock_best(uint32_t now_ms, uint8_t reason);
  void enter_offline(uint32_t now_ms);
  void reset_candidate();

  kl_config_t cfg_;
  kl_cell_config_t cell_;
  kl_cell_host_t host_;
  uint8_t state_;
  uint8_t current_channel_;
  uint8_t scan_index_;
  uint8_t scan_cycle_;
  uint32_t scan_deadline_ms_;
  uint32_t last_scan_ms_;
  uint32_t last_beacon_ms_;
  uint8_t missed_beacons_;
  uint8_t weak_beacons_;
  uint8_t scan_reason_;
  bool found_;
  uint8_t best_channel_;
  uint32_t best_gateway_;
  int16_t best_rssi_;
  uint8_t best_hops_;
};

#endif  // KLINTO_CELL_H
