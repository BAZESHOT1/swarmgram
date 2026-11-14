/**
 * HTTP/HTTPS-транспорт шлюза KMesh_v1.
 *
 * Зачем: MQTT-брокер не является обязательной частью Hub. Если брокера нет,
 * шлюз обязан доставлять пакеты обычным REST-транспортом и забирать ответы
 * коротким поллингом:
 *
 *   POST /v1/kmesh/v1/relay?kind=archive|presence
 *   GET  /v1/kmesh/v1/downlink?gateway_id=<id>&since=<cursor>
 *
 * Авторизация — общий ключ меша (x-kmesh-key) либо токен модуля.
 */
#ifndef KLINTO_HTTP_GATEWAY_H
#define KLINTO_HTTP_GATEWAY_H

#include "klinto_config.h"
#include "klinto_gateway.h"

#if defined(ESP32)

#include <Arduino.h>
#include <WiFiClient.h>
#include <WiFiClientSecure.h>

class HttpGatewayTransport : public IGatewayTransport {
 public:
  HttpGatewayTransport();
  void init(const kl_config_t *cfg);

  bool connect() override;
  void disconnect() override;
  bool connected() const override;
  bool publish(const char *topic, const uint8_t *data, size_t len) override;
  int read(char *topic, size_t topic_cap, uint8_t *data, size_t data_cap) override;
  void loop() override;

 private:
  bool post(const String &url, const char *body, size_t len);
  bool poll_downlink(uint32_t now_ms);
  int next_downlink(uint8_t *data, size_t data_cap);
  bool build_ack(uint32_t dst_node, uint32_t packet_id, uint8_t *out, size_t cap, size_t *len);

  kl_config_t cfg_;
  bool tls_;
  bool enabled_;
  WiFiClient plain_;
  WiFiClientSecure tls_client_;
  char base_[192];
  char key_hex_[65];
  uint32_t cursor_;
  uint32_t last_poll_ms_;
  char body_[4096];
  size_t body_len_;
  size_t parse_pos_;
};

#endif  // ESP32
#endif  // KLINTO_HTTP_GATEWAY_H
