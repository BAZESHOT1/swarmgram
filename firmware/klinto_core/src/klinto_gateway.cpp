#include "klinto_gateway.h"
#include "klinto_codec.h"
#include "klinto_util.h"

#include <stdio.h>
#include <string.h>

KlintoGateway::KlintoGateway()
    : transport_(nullptr),
      queue_(nullptr),
      backoff_ms_(1000),
      next_attempt_ms_(0),
      last_ok_ms_(0) {
  memset(&cfg_, 0, sizeof(cfg_));
  memset(&sink_, 0, sizeof(sink_));
  memset(&stats_, 0, sizeof(stats_));
  memset(topic_up_, 0, sizeof(topic_up_));
  memset(topic_down_, 0, sizeof(topic_down_));
  memset(topic_presence_, 0, sizeof(topic_presence_));
}

void KlintoGateway::init(const kl_config_t *cfg, IGatewayTransport *transport, KlintoFlashQueue *queue,
                     const kl_gateway_sink_t *sink) {
  if (cfg) cfg_ = *cfg;
  transport_ = transport;
  queue_ = queue;
  if (sink) sink_ = *sink;
  backoff_ms_ = 1000;
  next_attempt_ms_ = 0;
  last_ok_ms_ = 0;
  memset(&stats_, 0, sizeof(stats_));
  snprintf(topic_up_, sizeof(topic_up_), "klinto/kmesh/v1/gw/%lu/up", (unsigned long)cfg_.gateway_id);
  snprintf(topic_down_, sizeof(topic_down_), "klinto/kmesh/v1/gw/%lu/down", (unsigned long)cfg_.gateway_id);
  snprintf(topic_presence_, sizeof(topic_presence_), "klinto/kmesh/v1/gw/%lu/presence",
           (unsigned long)cfg_.gateway_id);
}

bool KlintoGateway::ensure_connected(uint32_t now_ms) {
  if (!transport_) return false;
  if (transport_->connected()) return true;
  if (now_ms < next_attempt_ms_) return false;
  stats_.reconnects++;
  if (transport_->connect()) {
    backoff_ms_ = 1000;
    return true;
  }
  backoff_ms_ = backoff_ms_ * 2;
  if (backoff_ms_ > 60000) backoff_ms_ = 60000;
  next_attempt_ms_ = now_ms + backoff_ms_;
  return false;
}

bool KlintoGateway::publish_json(const char *suffix, const char *json, size_t len) {
  if (!transport_ || !transport_->connected()) return false;
  const char *topic = suffix && !strcmp(suffix, "presence") ? topic_presence_ : topic_up_;
  if (!transport_->publish(topic, (const uint8_t *)json, len)) {
    stats_.uplink_fail++;
    return false;
  }
  stats_.uplink_ok++;
  last_ok_ms_ = kl_uptime_ms();
  return true;
}

bool KlintoGateway::send_archive(const kl_packet_t *pkt, int16_t rssi, uint8_t iface) {
  if (!pkt) return false;
  uint8_t wire[KL_MAX_PACKET_SIZE];
  const size_t wire_len = kl_packet_serialize(pkt, wire, sizeof(wire));
  if (!wire_len) return false;
  char b64[((KL_MAX_PACKET_SIZE + 2) / 3) * 4 + 1];
  if (!kl_base64_encode(wire, wire_len, b64, sizeof(b64))) return false;
  char uuid_hex[17];
  for (int i = 0; i < 8; ++i) {
    const uint8_t byte = (uint8_t)(pkt->msg_uuid >> (56 - i * 8));
    kl_hex_encode(&byte, 1, uuid_hex + i * 2, 3, false);
    uuid_hex[i * 2 + 2] = '\0';
  }
  char json[768];
  const int n = snprintf(
      json, sizeof(json),
      "{\"v\":3,\"kind\":\"mesh_archive\",\"gateway_id\":%lu,\"msg_uuid\":\"%s\","
      "\"packet_id\":%lu,\"src_id\":%lu,\"dst_id\":%lu,\"type\":%u,\"flags\":%u,"
      "\"ttl\":%u,\"hop_count\":%u,\"rssi\":%d,\"iface\":%u,\"ts\":%llu,"
      "\"need_cloud_archive\":%s,\"packet_b64\":\"%s\"}",
      (unsigned long)cfg_.gateway_id, uuid_hex, (unsigned long)pkt->packet_id,
      (unsigned long)pkt->src_id, (unsigned long)pkt->dst_id, (unsigned)pkt->type,
      (unsigned)pkt->flags, (unsigned)pkt->ttl, (unsigned)pkt->hop_count, (int)rssi,
      (unsigned)iface, (unsigned long long)kl_epoch_ms(),
      (pkt->flags & KL_FLAG_NEED_CLOUD_ARCHIVE) ? "true" : "false", b64);
  if (n <= 0 || (size_t)n >= sizeof(json)) return false;
  return publish_json("archive", json, (size_t)n);
}

bool KlintoGateway::publish_archive(const kl_packet_t *pkt, int16_t rssi, uint8_t iface,
                                uint32_t now_ms) {
  KlintoGuard guard(lock_);
  return publish_archive_locked(pkt, rssi, iface, now_ms);
}

bool KlintoGateway::publish_archive_locked(const kl_packet_t *pkt, int16_t rssi, uint8_t iface,
                                       uint32_t now_ms) {
  if (!pkt) return false;
  if (!ensure_connected(now_ms) || !send_archive(pkt, rssi, iface)) {
    if (queue_) queue_->push(pkt);
    stats_.queued++;
    return false;
  }
  return true;
}

bool KlintoGateway::publish_presence(const kl_packet_t *pkt, int16_t rssi, uint8_t iface,
                                 uint32_t now_ms) {
  KlintoGuard guard(lock_);
  return publish_presence_locked(pkt, rssi, iface, now_ms);
}

bool KlintoGateway::publish_presence_locked(const kl_packet_t *pkt, int16_t rssi, uint8_t iface,
                                        uint32_t now_ms) {
  if (!pkt) return false;
  uint8_t op = 0, rflags = 0;
  uint16_t chat = 0;
  uint8_t battery = 0, role = 0;
  uint16_t fw_build = 0;
  uint8_t chip_arch = 0, node_role = 0, radio_caps = 0, ota_state = 0, battery_pct = 0;
  if (pkt->payload_len >= 8) {
    battery = pkt->payload[4];
    role = pkt->payload[6];
  }
  if (pkt->payload_len >= 15) {
    fw_build = (uint16_t)(pkt->payload[8] | ((uint16_t)pkt->payload[9] << 8));
    chip_arch = pkt->payload[10];
    node_role = pkt->payload[11];
    radio_caps = pkt->payload[12];
    ota_state = pkt->payload[13];
    battery_pct = pkt->payload[14];
  }
  (void)rflags;
  (void)chat;
  if (!ensure_connected(now_ms)) return false;
  char json[512];
  const int n = snprintf(
      json, sizeof(json),
      "{\"v\":3,\"kind\":\"presence\",\"gateway_id\":%lu,\"node_id\":%lu,"
      "\"rssi\":%d,\"hops\":%u,\"iface\":%u,\"battery\":%u,\"role\":%u,\"ts\":%llu,"
      "\"routing_op\":%u,\"fw_build\":%u,\"chip_arch\":%u,\"node_role\":%u,"
      "\"radio_caps\":%u,\"ota_state\":%u,\"battery_pct\":%u}",
      (unsigned long)cfg_.gateway_id, (unsigned long)pkt->src_id, (int)rssi,
      (unsigned)pkt->hop_count, (unsigned)iface, (unsigned)battery, (unsigned)role,
      (unsigned long long)kl_epoch_ms(), (unsigned)op, (unsigned)fw_build, (unsigned)chip_arch,
      (unsigned)node_role, (unsigned)radio_caps, (unsigned)ota_state, (unsigned)battery_pct);
  if (n <= 0 || (size_t)n >= sizeof(json)) return false;
  return publish_json("presence", json, (size_t)n);
}

void KlintoGateway::notify_synced(uint64_t msg_uuid, uint32_t server_seq) {
  if (sink_.status) sink_.status(sink_.ctx, msg_uuid, server_seq, KL_STATUS_SYNCED_PERMANENT);
}

void KlintoGateway::drain_queue(uint32_t now_ms) {
  if (!queue_ || queue_->empty()) return;
  kl_packet_t pkt;
  if (!queue_->peek(&pkt)) {
    queue_->pop(nullptr);
    return;
  }
  const bool ok = pkt.type == KL_TYPE_NODE_PRESENCE
                      ? publish_presence_locked(&pkt, 0, 0xFF, now_ms)
                      : send_archive(&pkt, 0, 0xFF);
  if (ok) {
    queue_->pop(nullptr);
  }
}

void KlintoGateway::handle_downlink(const uint8_t *data, size_t len) {
  if (!data || len < KL_PACKET_HEADER_SIZE + 2) return;
  kl_packet_t pkt;
  if (!kl_packet_parse(data, len, &pkt)) return;
  /* Сервер может прислать пакет с уже выставленными флагами; принудительно
   * ставим FROM_INTERNET и проверяем, что пакет маршрутизируем. */
  pkt.flags |= KL_FLAG_FROM_INTERNET;
  pkt.flags &= (uint8_t)~KL_FLAG_TO_INTERNET;
  if (pkt.next_hop_id == 0) pkt.next_hop_id = KL_BROADCAST_ID;
  pkt.hop_count = 0;
  if (sink_.inject_downlink) {
    if (sink_.inject_downlink(sink_.ctx, &pkt)) stats_.downlink_ok++;
  }
}

void KlintoGateway::loop(uint32_t now_ms) {
  if (!transport_) return;
  KlintoGuard guard(lock_);
  transport_->loop();
  if (!ensure_connected(now_ms)) return;
  drain_queue(now_ms);
  char topic[64];
  uint8_t buf[KL_MAX_PACKET_SIZE];
  for (int i = 0; i < 8; ++i) {
    const int n = transport_->read(topic, sizeof(topic), buf, sizeof(buf));
    if (n <= 0) break;
    handle_downlink(buf, (size_t)n);
  }
}
