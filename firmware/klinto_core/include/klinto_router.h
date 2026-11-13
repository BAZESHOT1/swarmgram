/**
 * Klinto KMesh_v1 — ядро маршрутизации.
 *
 * Гибридная схема: AODV для узел-узел, градиент шлюзов для uplink,
 * RSSI-подавление broadcast, L3 ACK с повторами и NODE_PRESENCE.
 *
 * Важно: в LoRa нет link-layer адреса отправителя, поэтому каждый
 * передатчик заполняет last_hop_id — по нему строится обратный маршрут.
 */
#ifndef KLINTO_ROUTER_H
#define KLINTO_ROUTER_H

#include "klinto_config.h"
#include "klinto_packet.h"
#include "klinto_dedup.h"
#include "klinto_net.h"

#define KL_ROUTE_TABLE_SIZE 256
#define KL_NEIGHBOR_TABLE 64
#define KL_PENDING_QUEUE 12
#define KL_ACK_TABLE 16
#define KL_BCAST_QUEUE 8
#define KL_RREQ_RETRY_MS 2500u
#define KL_RREQ_MAX_TRIES 3

struct kl_route_entry_t {
  uint32_t dst_id;
  uint32_t next_hop_id;
  uint8_t iface;
  uint8_t hops;
  int16_t rssi;
  uint32_t last_seen_ms;
  uint32_t expires_ms;
  bool valid;
  bool is_gateway;
};

struct kl_neighbor_t {
  uint32_t node_id;
  uint8_t iface;
  int16_t rssi;
  uint8_t hops;
  uint32_t last_seen_ms;
  bool is_gateway;
  bool used;
};

struct kl_gw_route_t {
  bool valid;
  uint32_t gateway_id;
  uint32_t next_hop_id;
  uint8_t iface;
  uint8_t hops;
  int16_t rssi;
  uint32_t last_seen_ms;
  uint32_t expires_ms;
};

struct kl_pending_t {
  bool used;
  uint8_t tries;
  uint8_t iface_hint;
  uint32_t queued_ms;
  uint32_t next_try_ms;
  kl_packet_t pkt;
};

struct kl_ack_slot_t {
  bool used;
  bool via_gateway;
  uint8_t attempts;
  uint32_t deadline_ms;
  kl_packet_t pkt;
};

struct kl_bcast_slot_t {
  bool used;
  uint32_t packet_id;
  uint32_t due_ms;
  kl_packet_t pkt;
};

struct kl_router_stats_t {
  uint32_t rx_packets;
  uint32_t tx_packets;
  uint32_t dropped_dedup;
  uint32_t dropped_ttl;
  uint32_t dropped_policy;
  uint32_t relayed;
  uint32_t delivered;
  uint32_t acks_sent;
  uint32_t acks_received;
  uint32_t retries;
  uint32_t failures;
  uint32_t rreq_sent;
  uint32_t rrep_sent;
  uint32_t beacons_sent;
  uint32_t presence_sent;
};

struct kl_router_sink_t {
  void *ctx;
  /** Transmit on one interface. Return false on queue overflow. */
  bool (*send)(void *ctx, const kl_packet_t *pkt, uint8_t iface, uint32_t next_hop);
  /** Packet addressed to this node (or a broadcast we care about). */
  void (*deliver)(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface);
  /** Delivery state for the app. */
  void (*status)(void *ctx, uint64_t msg_uuid, uint32_t packet_id, uint8_t status);
  /** Gateway overheard a message that must be mirrored to the cloud. */
  void (*archive)(void *ctx, const kl_packet_t *pkt);
  /** Gateway learned a node's current attachment point. */
  void (*presence)(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface);
  /** Принят GW_BEACON: менеджер соты обновляет RSSI и запускает хэндовер. */
  void (*beacon)(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface);
};

class KlintoRouter {
 public:
  KlintoRouter();
  void init(const kl_config_t *cfg, const kl_router_sink_t *sink);
  void set_interface_mask(uint8_t mask) { iface_mask_ = mask ? mask : KL_IFACE_MASK_ESPNOW; }
  uint8_t interface_mask() const { return iface_mask_; }

  /** Application-originated packet. Fills src/ttl/packet_id/next_hop. */
  bool send(kl_packet_t *pkt, uint32_t now_ms, uint8_t iface_hint = 0xFF, bool need_ack = true);

  /**
   * Пакет из интернета: маршрутизировать без перезаписи src_id и принудительно
   * выставить FROM_INTERNET. Используется NODE_GATEWAY для downlink.
   */
  bool forward_downlink(kl_packet_t *pkt, uint32_t now_ms);

  /** Entry point for every received frame. */
  void on_packet(const kl_packet_t *pkt, uint8_t iface, int16_t rssi, uint32_t now_ms);

  /** Timers: retries, suppression, beacons, presence, route expiry. */
  void tick(uint32_t now_ms);

  /** Periodically called by the runtime while the client bridge is connected. */
  void set_battery(uint8_t percent, int8_t rssi);
  void set_capabilities(uint8_t caps) { capabilities_ = caps; }

  const kl_route_entry_t *route(uint32_t dst_id) const;
  const kl_gw_route_t *gateway_route() const { return &gw_; }
  const kl_neighbor_t *neighbors() const { return neighbors_; }
  uint16_t neighbor_count() const;

  /** Pre-seed a static route (provisioning, tests, fixed backbones). */
  void seed_route(uint32_t dst_id, uint32_t next_hop_id, uint8_t iface, uint8_t hops,
                  int16_t rssi, uint32_t now_ms) {
    KlintoGuard guard(lock_);
    upsert_route(dst_id, next_hop_id, iface, hops, rssi, now_ms, false);
  }

  /** Gateway only: broadcast a fresh gradient beacon now. */
  void emit_gateway_beacon(uint32_t now_ms);

  /** Сменить радиосоту: сбросить маршруты/маяки, привязанные к старому каналу. */
  void on_channel_changed(uint8_t wifi_channel);

  /** Немедленно отправить NODE_PRESENCE (после выбора новой соты). */
  void request_presence() {
    KlintoGuard guard(lock_);
    last_presence_ms_ = 0;
  }

  /** Called by the gateway when the server acknowledges a downlink/uplink. */
  void notify_status(uint64_t msg_uuid, uint32_t packet_id, uint8_t status);

  /** Delay in ms for RSSI-based broadcast suppression (weak = fast). */
  static uint32_t backoff_delay_ms(int16_t rssi, uint32_t salt = 0);

  const kl_router_stats_t *stats() const { return &stats_; }
  uint16_t pending_count() const;
  uint16_t ack_count() const;

 private:
  void learn_neighbor(uint32_t node_id, uint8_t iface, int16_t rssi, uint32_t now_ms,
                      uint8_t hops, bool is_gateway);
  bool upsert_route(uint32_t dst_id, uint32_t next_hop_id, uint8_t iface, uint8_t hops,
                    int16_t rssi, uint32_t now_ms, bool is_gateway);
  const kl_route_entry_t *find_route(uint32_t dst_id) const;
  void expire(uint32_t now_ms);
  void handle_beacon(const kl_packet_t *pkt, uint8_t iface, int16_t rssi, uint32_t now_ms);
  void learn_reverse_route(const kl_packet_t *pkt, uint8_t iface, int16_t rssi, uint32_t now_ms);
  void handle_rreq(kl_packet_t *pkt, uint8_t iface, int16_t rssi, uint32_t now_ms);
  void handle_rrep(kl_packet_t *pkt, uint8_t iface, int16_t rssi, uint32_t now_ms);
  void send_ack(const kl_packet_t *original, uint8_t iface, uint32_t now_ms);
  bool send_rreq(uint32_t target, uint8_t iface_hint, uint32_t now_ms);
  void schedule_broadcast(const kl_packet_t *pkt, int16_t rssi, uint32_t now_ms);
  void cancel_broadcast(uint32_t packet_id);
  bool transmit(const kl_packet_t *pkt, uint8_t iface, uint32_t next_hop, uint32_t now_ms);
  bool transmit_on_all(const kl_packet_t *pkt, uint32_t now_ms);
  void queue_pending(const kl_packet_t *pkt, uint8_t iface_hint, uint32_t now_ms);
  void flush_pending(uint32_t dst_id, uint32_t now_ms);
  void register_ack(const kl_packet_t *pkt, bool via_gateway, uint32_t now_ms);
  bool is_gateway() const { return cfg_.role == KL_ROLE_GATEWAY; }
  void maybe_presence(uint32_t now_ms);

  kl_config_t cfg_;
  kl_router_sink_t sink_;
  uint8_t iface_mask_;
  KlintoDedup dedup_;

  kl_route_entry_t routes_[KL_ROUTE_TABLE_SIZE];
  kl_neighbor_t neighbors_[KL_NEIGHBOR_TABLE];
  kl_gw_route_t gw_;
  kl_pending_t pending_[KL_PENDING_QUEUE];
  kl_ack_slot_t acks_[KL_ACK_TABLE];
  kl_bcast_slot_t bcasts_[KL_BCAST_QUEUE];

  uint8_t battery_;
  int8_t last_rssi_;
  uint8_t capabilities_;
  uint32_t last_presence_ms_;
  uint32_t last_presence_gw_hop_;
  uint32_t last_beacon_ms_;
  uint32_t boot_ms_;
  kl_router_stats_t stats_;
  KlintoLock lock_;
};

#endif  // KLINTO_ROUTER_H
