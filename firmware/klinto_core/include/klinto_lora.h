/**
 * Klinto KMesh_v1 — драйвер LoRa (RadioLib).
 *
 * Чип и пины выбираются в рантайме; реализованы CAD + CSMA/CA,
 * очередь с тремя приоритетами и бюджет airtime. sendPacket() только
 * ставит кадр в очередь; SPI принадлежит отдельной задаче.
 */
#ifndef KLINTO_LORA_H
#define KLINTO_LORA_H

#include "klinto_net.h"

#if defined(ESP32)
class Module;
class PhysicalLayer;
#endif

class LoraInterface : public INetInterface {
 public:
  LoraInterface();
  bool init(const kl_config_t &cfg) override;
  void shutdown() override;
  bool sendPacket(const uint8_t *data, size_t len, uint32_t next_hop_id,
                  uint8_t priority) override;
  void poll(uint32_t now_ms) override;
  bool isBusy() const override;
  uint16_t getMTU() const override { return 240; }
  int8_t getLinkQuality() const override;
  uint8_t id() const override { return KL_IFACE_LORA; }
  void setReceiveCallback(kl_rx_callback_t cb, void *ctx) override;
  bool setChannel(uint8_t wifi_channel) override;

  uint8_t queueDepth() const { return count_; }
  uint32_t rxPackets() const { return rx_packets_; }
  uint32_t txPackets() const { return tx_packets_; }
  int16_t initState() const { return init_state_; }
  uint32_t cadBusy() const { return cad_busy_; }
  uint32_t cadTotal() const { return cad_total_; }

 private:
  struct TxItem {
    uint8_t priority;
    uint8_t pad;
    uint16_t len;
    uint32_t next_hop;
    uint32_t seq;
    uint8_t data[KL_MAX_PACKET_SIZE];
  };

  void taskLoop();
  bool trySendNow(const TxItem &item, uint32_t air_ms);
  void remove_item(uint32_t seq);
  bool cadClear();
  bool applyRadioConfig();
  void applyPendingChannel();
  void pushRx(const uint8_t *data, size_t len, int16_t rssi);

  kl_rx_callback_t cb_;
  void *cb_ctx_;
  kl_config_t cfg_;
  KlintoRxRing rx_;
  TxItem queue_[12];
  uint8_t count_;
  uint32_t seq_;
  volatile bool inited_;
  volatile bool transmitting_;
  uint32_t self_id_;
  bool self_gateway_;
  volatile int8_t last_quality_;
  uint32_t cad_busy_;
  uint32_t cad_total_;
  uint32_t airtime_window_ms_;
  uint32_t airtime_used_ms_;
  KlintoLock queue_lock_;
  volatile bool channel_pending_;
  volatile uint8_t pending_channel_;
  int irq_pin_ = -1;
  uint16_t irq_noise_ = 0;
  uint32_t irq_noise_log_ms_ = 0;
  uint8_t chip_ = 0;
  void *radio_ = nullptr;
  int16_t init_state_ = 0;
  volatile uint32_t rx_packets_ = 0;
  volatile uint32_t tx_packets_ = 0;
  bool setSync(uint8_t sync_word);

#if defined(ESP32)
  Module *module_;
  PhysicalLayer *phys_;
  static void taskEntry(void *arg);
#endif
};

#endif  // KLINTO_LORA_H
