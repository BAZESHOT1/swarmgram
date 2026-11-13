/**
 * Klinto KMesh_v1 — интернет-шлюз.
 *
 * Шлюз не пытается расшифровать чужой трафик: он пересылает исходный
 * MeshPacket (base64) и радиометаданные на сервер. Сервер хранит
 * shadow copy до постоянной синхронизации владельцем.
 *
 * MQTT-контракт: klinto/kmesh/v1/gw/<gateway_id>/{up,down,presence}.
 */
#ifndef KLINTO_GATEWAY_H
#define KLINTO_GATEWAY_H

#include "klinto_config.h"
#include "klinto_packet.h"
#include "klinto_flash_queue.h"

class IGatewayTransport {
 public:
  virtual ~IGatewayTransport() {}
  virtual bool connect() = 0;
  virtual void disconnect() = 0;
  virtual bool connected() const = 0;
  virtual bool publish(const char *topic, const uint8_t *data, size_t len) = 0;
  /** @return bytes read, 0 when no message, -1 on transport error. */
  virtual int read(char *topic, size_t topic_cap, uint8_t *data, size_t data_cap) = 0;
  virtual void loop() = 0;
};

struct kl_gateway_sink_t {
  void *ctx;
  /** Hand a server-originated packet back to the router. */
  bool (*inject_downlink)(void *ctx, const kl_packet_t *pkt);
  /** Delivery/sync status for the client bridge (optional). */
  void (*status)(void *ctx, uint64_t msg_uuid, uint32_t packet_id, uint8_t status);
};

struct kl_gateway_stats_t {
  uint32_t uplink_ok;
  uint32_t uplink_fail;
  uint32_t downlink_ok;
  uint32_t queued;
  uint32_t reconnects;
};

class KlintoGateway {
 public:
  KlintoGateway();
  void init(const kl_config_t *cfg, IGatewayTransport *transport, KlintoFlashQueue *queue,
            const kl_gateway_sink_t *sink);

  /** Mirror an overheard or uplink packet to the archive topic. */
  bool publish_archive(const kl_packet_t *pkt, int16_t rssi, uint8_t iface, uint32_t now_ms);
  /** Report node attachment (node_id -> gateway_id) to the backend. */
  bool publish_presence(const kl_packet_t *pkt, int16_t rssi, uint8_t iface, uint32_t now_ms);
  /** Direct server event (MSG_SYNCED) translated to the bridge. */
  void notify_synced(uint64_t msg_uuid, uint32_t server_seq);

  void loop(uint32_t now_ms);
  bool online() const { return transport_ && transport_->connected(); }
  const kl_gateway_stats_t *stats() const { return &stats_; }

 private:
  bool ensure_connected(uint32_t now_ms);
  bool publish_json(const char *suffix, const char *json, size_t len);
  bool send_archive(const kl_packet_t *pkt, int16_t rssi, uint8_t iface);
  bool publish_archive_locked(const kl_packet_t *pkt, int16_t rssi, uint8_t iface,
                              uint32_t now_ms);
  bool publish_presence_locked(const kl_packet_t *pkt, int16_t rssi, uint8_t iface,
                               uint32_t now_ms);
  void drain_queue(uint32_t now_ms);
  void handle_downlink(const uint8_t *data, size_t len);

  kl_config_t cfg_;
  IGatewayTransport *transport_;
  KlintoFlashQueue *queue_;
  kl_gateway_sink_t sink_;
  kl_gateway_stats_t stats_;
  uint32_t backoff_ms_;
  uint32_t next_attempt_ms_;
  uint32_t last_ok_ms_;
  char topic_up_[64];
  char topic_down_[64];
  char topic_presence_[64];
  KlintoLock lock_;
};

#endif  // KLINTO_GATEWAY_H
