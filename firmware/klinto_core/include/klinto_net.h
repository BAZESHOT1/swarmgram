/**
 * Klinto KMesh_v1 — абстракция физических интерфейсов.
 *
 * Каждый драйвер (ESP-NOW, LoRa, тестовый loopback) реализует один
 * и тот же набор операций; роутер не знает, через какую среду ушёл кадр.
 */
#ifndef KLINTO_NET_H
#define KLINTO_NET_H

#include "klinto_config.h"
#include "klinto_packet.h"
#include "klinto_util.h"

#define KL_IFACE_ESPNOW 0
#define KL_IFACE_LORA 1
#define KL_IFACE_COUNT 2
#define KL_IFACE_MASK_ESPNOW (1u << KL_IFACE_ESPNOW)
#define KL_IFACE_MASK_LORA (1u << KL_IFACE_LORA)

enum kl_tx_priority_t : uint8_t {
  KL_PRIO_HIGH = 0,   /* L3 ACK, RREP */
  KL_PRIO_MEDIUM = 1, /* direct messages */
  KL_PRIO_LOW = 2,    /* beacons, telemetry, background sync */
  KL_PRIO_OTA_IDLE = 3 /* OTA-чанки: только когда эфир свободен */
};

typedef void (*kl_rx_callback_t)(void *ctx, const uint8_t *data, size_t len, int16_t rssi,
                                 uint8_t iface);

class INetInterface {
 public:
  virtual ~INetInterface() {}
  virtual bool init(const kl_config_t &cfg) = 0;
  virtual void shutdown() = 0;
  virtual bool sendPacket(const uint8_t *data, size_t len, uint32_t next_hop_id,
                          uint8_t priority) = 0;
  virtual void poll(uint32_t now_ms) = 0;
  virtual bool isBusy() const = 0;
  virtual uint16_t getMTU() const = 0;
  virtual int8_t getLinkQuality() const = 0;
  virtual uint8_t id() const = 0;
  virtual void setReceiveCallback(kl_rx_callback_t cb, void *ctx) = 0;
  /** Переключить физический канал (ESP-NOW Wi-Fi / LoRa-подканал). */
  virtual bool setChannel(uint8_t wifi_channel) {
    (void)wifi_channel;
    return false;
  }
};

/**
 * Кольцевой буфер фиксированного размера, общий для радиодрайверов
 * и задачи роутера. Радиоколлбэк только копирует байты; весь разбор
 * выполняется в задаче, никогда в ISR.
 */
#define KL_RX_RING_SLOTS 8
struct kl_rx_frame_t {
  uint16_t len;
  int16_t rssi;
  uint8_t iface;
  uint8_t data[KL_MAX_PACKET_SIZE];
};

class KlintoRxRing {
 public:
  KlintoRxRing();
  bool push(const uint8_t *data, size_t len, int16_t rssi, uint8_t iface);
  bool pop(kl_rx_frame_t *out);
  bool empty() const;
  uint16_t peak();

 private:
  kl_rx_frame_t frames_[KL_RX_RING_SLOTS];
  std::atomic<uint8_t> head_;
  std::atomic<uint8_t> tail_;
};

#endif  // KLINTO_NET_H
