/**
 * Klinto KMesh_v1 — минимальный MQTT 3.1.1 поверх TLS.
 *
 * Шлюзу нужны только CONNECT, SUBSCRIBE (QoS0), PUBLISH (QoS0)
 * и PINGREQ. Свой клиент убирает тяжёлую зависимость из прошивки
 * и делает политику TLS/CA явной.
 */
#ifndef KLINTO_MQTT_H
#define KLINTO_MQTT_H

#include "klinto_gateway.h"

#if defined(ESP32)
#include <WiFiClientSecure.h>
#include <WiFiClient.h>
#endif

class MqttTlsTransport : public IGatewayTransport {
 public:
  MqttTlsTransport();
  bool begin(const char *host, uint16_t port, bool tls, const char *user, const char *pass,
             const char *ca_pem, const char *client_id, const char *down_topic);
  bool connect() override;
  void disconnect() override;
  bool connected() const override { return connected_; }
  bool publish(const char *topic, const uint8_t *data, size_t len) override;
  int read(char *topic, size_t topic_cap, uint8_t *data, size_t data_cap) override;
  void loop() override;
  const char *lastError() const { return last_error_; }

 private:
  bool sendConnect();
  bool sendSubscribe();
  bool writeAll(const uint8_t *data, size_t len);
  bool readPacket(uint8_t *header, uint8_t *payload, size_t cap, size_t *payload_len,
                  uint32_t timeout_ms);
  static size_t encodeRemaining(uint8_t *out, size_t value);
  static bool decodeRemaining(const uint8_t *in, size_t len, size_t *value, size_t *used);

  char host_[96];
  uint16_t port_;
  bool tls_;
  char user_[48];
  char pass_[48];
  char ca_[1600];
  char client_id_[48];
  char down_topic_[80];
  const char *last_error_;
  bool connected_;
  uint16_t packet_id_;
  uint32_t last_ping_ms_;
  uint32_t last_rx_ms_;
  uint8_t rx_[512];
  size_t rx_len_;

#if defined(ESP32)
  WiFiClientSecure secure_;
  WiFiClient plain_;
  Client *sock() { return tls_ ? (Client *)&secure_ : (Client *)&plain_; }
#endif
};

#endif  // KLINTO_MQTT_H
