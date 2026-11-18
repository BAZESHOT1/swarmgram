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

#include <atomic>

#if defined(ESP32)
class NimBLEServer;
class NimBLECharacteristic;
#endif

class BleClientLink : public IClientLink {
 public:
  BleClientLink();
  bool begin(const char *deviceName);
  void end();
  /** Перезапустить advertising с новым именем KL-<USER8>-<MOD6>. */
  void rename(const char *deviceName);
  /** Отложенное переименование: применяем, когда нет активного подключения. */
  bool renamePending() const { return pending_rename_; }
  void applyPendingRename();
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
  /** Подписка клиента на notify (CCCD) a5c1/a5c2. */
  void onSubscribe(bool is_tx, uint16_t sub_value);
#if defined(ESP32)
  NimBLECharacteristic *txCharacteristic() const { return tx_; }
#endif

 private:
  kl_rx_callback_t cb_;
  void *cb_ctx_;
  bool connected_;
  uint16_t mtu_;
  uint16_t conn_id_;
  void (*hook_)(void *ctx, bool connected);
  void *hook_ctx_;
  /** Отложенное переименование (нельзя делать deinit при активном клиенте). */
  bool pending_rename_ = false;
  char pending_name_[32] = {0};
  bool tx_subscribed_ = false;
  bool rx_subscribed_ = false;
  /* Кольцо приёма (один писатель — NimBLE host, один читатель — задача клиента):
   * разбор кадров в колбэке GATT брал замки роутера и вешал host-задачу. */
  static const size_t kRxRing = 4096;
  uint8_t rx_ring_[kRxRing];
  std::atomic<size_t> rx_head_{0};
  std::atomic<size_t> rx_tail_{0};
  uint32_t rx_dropped_ = 0;

#if defined(ESP32)
  NimBLEServer *server_;
  NimBLECharacteristic *tx_;
  NimBLECharacteristic *rx_;
  NimBLECharacteristic *status_;
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
