/**
 * Klinto KMesh_v1 — BLE GATT транспорт клиента.
 *
 * Сервис a5c0, TX a5c1 (notify), RX a5c2 (write), STATUS a5c3.
 * Транспорт двигает только байты; кадрирование и фрагментация —
 * в KlintoClientBridge.
 */
#ifndef KLINTO_BLE_LINK_H
#define KLINTO_BLE_LINK_H

#include "klinto_bridge.h"

#if defined(ESP32)
class BLEServer;
class BLECharacteristic;
#endif

class BleClientLink : public IClientLink {
 public:
  BleClientLink();
  bool begin(const char *deviceName);
  void end();
  bool send(const uint8_t *data, size_t len) override;
  bool connected() const override { return connected_; }
  uint16_t mtu() const override;
  void poll(uint32_t now_ms) override;
  void setReceiveCallback(kl_rx_callback_t cb, void *ctx) override { cb_ = cb; cb_ctx_ = ctx; }
  const char *name() const override { return "BLE"; }

  void notifyStatus(const char *text);
  void setConnectedHook(void (*hook)(void *ctx, bool connected), void *ctx) {
    hook_ = hook;
    hook_ctx_ = ctx;
  }
  /** Called by the GATT callbacks. */
  void onConnected(uint16_t conn_id, uint16_t mtu);
  void onDisconnected();
  void onWrite(const uint8_t *data, size_t len);
  void onMtu(uint16_t mtu) { mtu_ = mtu; }

 private:
  kl_rx_callback_t cb_;
  void *cb_ctx_;
  bool connected_;
  uint16_t mtu_;
  uint16_t conn_id_;
  void (*hook_)(void *ctx, bool connected);
  void *hook_ctx_;

#if defined(ESP32)
  BLEServer *server_;
  BLECharacteristic *tx_;
  BLECharacteristic *rx_;
  BLECharacteristic *status_;
#endif
};

class SerialClientLink : public IClientLink {
 public:
  SerialClientLink();
  void begin(unsigned long baud);
  bool send(const uint8_t *data, size_t len) override;
  bool connected() const override { return true; }
  uint16_t mtu() const override { return 512; }
  void poll(uint32_t now_ms) override;
  void setReceiveCallback(kl_rx_callback_t cb, void *ctx) override { cb_ = cb; cb_ctx_ = ctx; }
  const char *name() const override { return "USB"; }

 private:
  kl_rx_callback_t cb_;
  void *cb_ctx_;
  uint32_t last_rx_ms_;
};

#endif  // KLINTO_BLE_LINK_H
