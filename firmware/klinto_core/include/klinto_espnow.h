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

class EspNowInterface : public INetInterface {
 public:
  EspNowInterface();
  bool init(const kl_config_t &cfg) override;
  void shutdown() override;
  bool sendPacket(const uint8_t *data, size_t len, uint32_t next_hop_id,
                  uint8_t priority) override;
  void poll(uint32_t now_ms) override;
  bool isBusy() const override;
  uint16_t getMTU() const override { return 240; }
  int8_t getLinkQuality() const override;
  uint8_t id() const override { return KL_IFACE_ESPNOW; }
  void setReceiveCallback(kl_rx_callback_t cb, void *ctx) override;
  bool setChannel(uint8_t wifi_channel) override;

 private:
  struct TxSlot {
    uint16_t len;
    uint32_t next_hop;
    uint8_t data[KL_MAX_PACKET_SIZE];
  };

  void enqueue_tx(const uint8_t *data, size_t len, uint32_t next_hop);
  void pump_tx();

  kl_rx_callback_t cb_;
  void *cb_ctx_;
  KlintoRxRing rx_;
  TxSlot tx_[8];
  volatile uint8_t tx_head_;
  volatile uint8_t tx_tail_;
  volatile bool inited_;
  uint32_t self_id_;
  bool self_gateway_;
  volatile int16_t last_rssi_;
  uint32_t last_tx_ms_;

  static EspNowInterface *s_instance;
  static void on_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len);
  static void on_sent(const wifi_tx_info_t *info, esp_now_send_status_t status);
};

#endif  // KLINTO_ESPNOW_H
