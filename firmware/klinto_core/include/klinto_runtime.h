/**
 * Klinto KMesh_v1 — связка FreeRTOS.
 *
 * Владеет объектами, распределяет задачи по ядрам и соединяет роутер
 * с интерфейсами, клиентским мостом и интернет-шлюзом.
 */
#ifndef KLINTO_RUNTIME_H
#define KLINTO_RUNTIME_H

#include "klinto_config.h"

#if defined(ESP32)

#include <Arduino.h>
#include "klinto_bridge.h"
#include "klinto_ble_link.h"
#include "klinto_cell.h"
#include "klinto_espnow.h"
#include "klinto_flash_queue.h"
#include "klinto_gateway.h"
#include "klinto_http_gateway.h"
#include "klinto_lora.h"
#include "klinto_ota.h"
#include "klinto_router.h"

class KlintoNode {
 public:
  static KlintoNode &instance();

  bool begin();
  void loop();

  KlintoRouter &router() { return router_; }
  KlintoClientBridge &bridge() { return bridge_; }
  KlintoGateway &gateway() { return gateway_; }
  KlintoOta &ota() { return ota_; }
  const kl_config_t &config() const { return cfg_; }

  void setBattery(uint8_t percent, bool charging = false) {
    router_.set_battery(percent, -60);
    router_.set_charging(charging);
    ota_.set_battery(percent, charging);
  }

 private:
  KlintoNode();

  bool loadConfig();
  void startTasks();
  void onConfigJson(const char *json, size_t len);

  static void meshTaskEntry(void *arg);
  static void clientTaskEntry(void *arg);
  static void gatewayTaskEntry(void *arg);
  static void onRadioFrame(void *ctx, const uint8_t *data, size_t len, int16_t rssi,
                           uint8_t iface);
  static bool sinkSend(void *ctx, const kl_packet_t *pkt, uint8_t iface, uint32_t next_hop);
  static void sinkDeliver(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface);
  static void sinkStatus(void *ctx, uint64_t msg_uuid, uint32_t packet_id, uint8_t status);
  static void sinkArchive(void *ctx, const kl_packet_t *pkt);
  static void sinkPresence(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface);
  static bool sinkInjectDownlink(void *ctx, const kl_packet_t *pkt);
  static void sinkGatewayStatus(void *ctx, uint64_t msg_uuid, uint32_t packet_id, uint8_t status);
  static void onClientLink(void *ctx, const uint8_t *data, size_t len, int16_t rssi,
                           uint8_t iface);
  static void onConfig(void *ctx, const char *json, size_t len);
  static void onLog(void *ctx, const char *text);
  static void onInetStatus(void *ctx, bool has_internet, uint16_t rtt_ms, bool allow_relay);
  static bool onVerifyOwnerClaim(void *ctx, const uint8_t digest[32], const uint8_t *sig,
                                 size_t sig_len);
  static void onOwnerChanged(void *ctx, const char *prefix, uint32_t net_id, uint32_t epoch);
  static bool otaSend(void *ctx, uint8_t type, const uint8_t *payload, size_t len, bool broadcast);
  static void otaState(void *ctx, uint8_t state);
  static bool cellApplyChannel(void *ctx, uint8_t wifi_channel);
  static void cellLocked(void *ctx, uint8_t channel, uint32_t gateway_id, int16_t rssi,
                         uint8_t hops, uint8_t reason);
  static void cellOffline(void *ctx, uint8_t channel);
  static void sinkBeacon(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface);

  kl_config_t cfg_;
  KlintoRouter router_;
  EspNowInterface espnow_;
  LoraInterface lora_;
  BleClientLink ble_;
  SerialClientLink serial_;
  IClientLink *client_link_;
  KlintoClientBridge bridge_;
  KlintoFlashQueue up_queue_;
  KlintoFlashQueue down_queue_;
  HttpGatewayTransport http_gateway_;
  KlintoGateway gateway_;
  KlintoOta ota_;
  KlintoCellManager cell_;
  char hardware_id_[24];
  volatile bool started_;
  uint32_t boot_valid_ms_;
};

#endif  // ESP32
#endif  // KLINTO_RUNTIME_H
