/**
 * Klinto KMesh_v1 — драйвер ESP-NOW.
 *
 * Ровно один peer — широковещательный MAC. Никаких таблиц соседей
 * и лимита 20 пиров: фильтрация идёт по next_hop_id в RX-коллбэке.
 */
#ifndef KLINTO_ESPNOW_H
#define KLINTO_ESPNOW_H

#include "klinto_net.h"

#if defined(ESP32)
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_arduino_version.h>
#endif

/** Минимальный интервал между кадрами ESP-NOW: защита от «эфирного шторма». */
#define KL_ESPNOW_MIN_TX_GAP_MS 6u
/** Сколько раз повторяем кадр, прежде чем выбросить его из очереди. */
#define KL_ESPNOW_MAX_RETRIES 3u
/** Очередь ожидания: 16 кадров достаточно для двух модулей на столе. */
#define KL_ESPNOW_TX_QUEUE 16u

class EspNowInterface : public INetInterface {
 public:
  EspNowInterface();
  bool init(const kl_config_t &cfg) override;
  void shutdown() override;
  bool sendPacket(const uint8_t *data, size_t len, uint32_t next_hop_id,
                  uint8_t priority) override;
  void poll(uint32_t now_ms) override;
  bool isBusy() const override;
  /** Диагностика радио: сколько кадров принято/отброшено/отправлено/не отправлено. */
  uint32_t rxRaw() const { return rx_raw_; }
  uint32_t rxMagicBad() const { return rx_bad_; }
  uint32_t rxNotForUs() const { return rx_not_us_; }
  uint32_t txOk() const { return tx_ok_; }
  uint32_t txErr() const { return tx_err_; }
  int lastTxErr() const { return last_tx_err_; }
  uint16_t getMTU() const override { return 240; }
  int8_t getLinkQuality() const override;
  uint8_t id() const override { return KL_IFACE_ESPNOW; }
  void setReceiveCallback(kl_rx_callback_t cb, void *ctx) override;
  bool setChannel(uint8_t wifi_channel) override;

 private:
  struct TxSlot {
    uint16_t len;
    uint32_t next_hop;
    uint8_t tries;
    uint8_t data[KL_MAX_PACKET_SIZE];
  };

  bool enqueue_tx(const uint8_t *data, size_t len, uint32_t next_hop);
  bool transmit(const uint8_t *data, size_t len);
  void pump_tx(uint32_t now_ms);

  kl_rx_callback_t cb_;
  void *cb_ctx_;
  KlintoRxRing rx_;
  TxSlot tx_[KL_ESPNOW_TX_QUEUE];
  volatile uint8_t tx_head_;
  volatile uint8_t tx_tail_;
  volatile bool inited_;
  uint32_t self_id_;
  bool self_gateway_;
  volatile int16_t last_rssi_;
  uint32_t last_tx_ms_;
  volatile uint32_t rx_raw_ = 0;
  volatile uint32_t rx_bad_ = 0;
  volatile uint32_t rx_not_us_ = 0;
  uint32_t tx_ok_ = 0;
  uint32_t tx_err_ = 0;
  int last_tx_err_ = 0;

  static EspNowInterface *s_instance;
  static void on_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len);
  static void on_sent(const wifi_tx_info_t *info, esp_now_send_status_t status);
};

#endif  // KLINTO_ESPNOW_H
