#include "klinto_router.h"
#include "klinto_codec.h"
#include "klinto_util.h"

#include <stdio.h>
#include <string.h>

KlintoRouter::KlintoRouter()
    : cfg_(),
      sink_(),
      iface_mask_(KL_IFACE_MASK_ESPNOW),
      gw_(),
      battery_(100),
      last_rssi_(-70),
      capabilities_(0x03),
      charging_(false),
      battery_low_(false),
      relay_allowed_(true),
      inet_has_(false),
      mobile_gateway_(false),
      inet_rtt_ms_(0),
      last_presence_ms_(0),
      last_presence_gw_hop_(0xFF),
      last_beacon_ms_(0),
      last_mobile_beacon_ms_(0),
      boot_ms_(0) {
  memset(&routes_, 0, sizeof(routes_));
  memset(neighbors_, 0, sizeof(neighbors_));
  memset(&gw_, 0, sizeof(gw_));
  memset(pending_, 0, sizeof(pending_));
  memset(acks_, 0, sizeof(acks_));
  memset(bcasts_, 0, sizeof(bcasts_));
  memset(&stats_, 0, sizeof(stats_));
  memset(&cfg_, 0, sizeof(cfg_));
  memset(&sink_, 0, sizeof(sink_));
}

void KlintoRouter::init(const kl_config_t *cfg, const kl_router_sink_t *sink) {
  KlintoGuard guard(lock_);
  if (cfg) cfg_ = *cfg;
  if (sink) sink_ = *sink;
  memset(&gw_, 0, sizeof(gw_));
  memset(routes_, 0, sizeof(routes_));
  memset(neighbors_, 0, sizeof(neighbors_));
  memset(pending_, 0, sizeof(pending_));
  memset(acks_, 0, sizeof(acks_));
  memset(bcasts_, 0, sizeof(bcasts_));
  memset(&stats_, 0, sizeof(stats_));
  iface_mask_ = (cfg_.espnow_enabled ? KL_IFACE_MASK_ESPNOW : 0) |
                (cfg_.lora_present ? KL_IFACE_MASK_LORA : 0);
  if (!iface_mask_) iface_mask_ = KL_IFACE_MASK_ESPNOW;
  battery_ = 100;
  last_rssi_ = -70;
  capabilities_ = 0x03;
  charging_ = false;
  battery_low_ = false;
  relay_allowed_ = cfg_.relay_allowed;
  inet_has_ = false;
  mobile_gateway_ = false;
  inet_rtt_ms_ = 0;
  last_presence_ms_ = 0;
  last_presence_gw_hop_ = 0xFF;
  last_beacon_ms_ = 0;
  last_mobile_beacon_ms_ = 0;
  boot_ms_ = kl_uptime_ms();
  dedup_.reset();
}

/* ------------------------------------------------------------- routes ---- */

const kl_route_entry_t *KlintoRouter::find_route(uint32_t dst_id) const {
  for (uint16_t i = 0; i < KL_ROUTE_TABLE_SIZE; ++i) {
    if (!routes_[i].valid) continue;
    if (routes_[i].dst_id != dst_id) continue;
    return &routes_[i];
  }
  return nullptr;
}

const kl_route_entry_t *KlintoRouter::route(uint32_t dst_id) const {
  const kl_route_entry_t *r = find_route(dst_id);
  if (!r) return nullptr;
  if (r->expires_ms && kl_uptime_ms() > r->expires_ms) return nullptr;
  return r;
}

bool KlintoRouter::upsert_route(uint32_t dst_id, uint32_t next_hop_id, uint8_t iface, uint8_t hops,
                                int16_t rssi, uint32_t now_ms, bool is_gateway) {
  if (dst_id == cfg_.node_id || dst_id == KL_INVALID_ID) return false;
  kl_route_entry_t *slot = nullptr;
  for (uint16_t i = 0; i < KL_ROUTE_TABLE_SIZE; ++i) {
    if (routes_[i].valid && routes_[i].dst_id == dst_id) {
      slot = &routes_[i];
      break;
    }
  }
  if (!slot) {
    for (uint16_t i = 0; i < KL_ROUTE_TABLE_SIZE; ++i) {
      if (!routes_[i].valid) {
        slot = &routes_[i];
        break;
      }
    }
  }
  if (!slot) {
    /* Replace the least recently seen entry. */
    uint32_t oldest = 0xFFFFFFFFu;
    for (uint16_t i = 0; i < KL_ROUTE_TABLE_SIZE; ++i) {
      if (routes_[i].last_seen_ms < oldest) {
        oldest = routes_[i].last_seen_ms;
        slot = &routes_[i];
      }
    }
  }
  if (!slot) return false;
  const bool fresh = !slot->valid || slot->dst_id != dst_id;
  const bool better = fresh || hops < slot->hops || (hops == slot->hops && rssi > slot->rssi + 4);
  if (!better && slot->next_hop_id == next_hop_id) {
    slot->last_seen_ms = now_ms;
    slot->expires_ms = now_ms + cfg_.route_expiry_ms;
    return true;
  }
  if (!better) return true;
  slot->dst_id = dst_id;
  slot->next_hop_id = next_hop_id;
  slot->iface = iface;
  slot->hops = hops;
  slot->rssi = rssi;
  slot->last_seen_ms = now_ms;
  slot->expires_ms = now_ms + cfg_.route_expiry_ms;
  slot->valid = true;
  slot->is_gateway = is_gateway;
  return true;
}

void KlintoRouter::learn_neighbor(uint32_t node_id, uint8_t iface, int16_t rssi, uint32_t now_ms,
                                  uint8_t hops, bool is_gateway) {
  if (node_id == cfg_.node_id || node_id == KL_INVALID_ID) return;
  kl_neighbor_t *slot = nullptr;
  kl_neighbor_t *oldest = &neighbors_[0];
  for (uint16_t i = 0; i < KL_NEIGHBOR_TABLE; ++i) {
    if (neighbors_[i].used && neighbors_[i].node_id == node_id) {
      slot = &neighbors_[i];
      break;
    }
    if (!neighbors_[i].used && !slot) slot = &neighbors_[i];
    if (neighbors_[i].last_seen_ms < oldest->last_seen_ms) oldest = &neighbors_[i];
  }
  if (!slot) slot = oldest;
  slot->node_id = node_id;
  slot->iface = iface;
  slot->rssi = rssi;
  slot->hops = hops;
  slot->last_seen_ms = now_ms;
  slot->is_gateway = is_gateway;
  slot->used = true;
}

uint16_t KlintoRouter::neighbor_count() const {
  uint16_t n = 0;
  for (uint16_t i = 0; i < KL_NEIGHBOR_TABLE; ++i) n += neighbors_[i].used ? 1 : 0;
  return n;
}

void KlintoRouter::expire(uint32_t now_ms) {
  for (uint16_t i = 0; i < KL_ROUTE_TABLE_SIZE; ++i) {
    if (routes_[i].valid && routes_[i].expires_ms && now_ms > routes_[i].expires_ms) {
      routes_[i].valid = false;
    }
  }
  for (uint16_t i = 0; i < KL_NEIGHBOR_TABLE; ++i) {
    if (neighbors_[i].used && now_ms - neighbors_[i].last_seen_ms > cfg_.route_expiry_ms * 3) {
      neighbors_[i].used = false;
    }
  }
  if (gw_.valid && gw_.expires_ms && now_ms > gw_.expires_ms) {
    gw_.valid = false;
  }
}

/* ------------------------------------------------------------- sending --- */

bool KlintoRouter::transmit(const kl_packet_t *pkt, uint8_t iface, uint32_t next_hop,
                            uint32_t now_ms) {
  (void)now_ms;
  if (!sink_.send) return false;
  if (!(iface_mask_ & (1u << iface))) return false;
  kl_packet_t copy = *pkt;
  copy.next_hop_id = next_hop;
  copy.last_hop_id = cfg_.node_id;
  if (!sink_.send(sink_.ctx, &copy, iface, next_hop)) return false;
  stats_.tx_packets++;
  return true;
}

bool KlintoRouter::transmit_on_all(const kl_packet_t *pkt, uint32_t now_ms) {
  bool any = false;
  for (uint8_t i = 0; i < KL_IFACE_COUNT; ++i) {
    if (!(iface_mask_ & (1u << i))) continue;
    any |= transmit(pkt, i, KL_BROADCAST_ID, now_ms);
  }
  return any;
}

void KlintoRouter::queue_pending(const kl_packet_t *pkt, uint8_t iface_hint, uint32_t now_ms) {
  kl_pending_t *slot = nullptr;
  for (uint16_t i = 0; i < KL_PENDING_QUEUE; ++i) {
    if (!pending_[i].used) {
      slot = &pending_[i];
      break;
    }
  }
  if (!slot) {
    /* Drop the oldest pending entry; a newer message is more useful. */
    uint32_t oldest = 0xFFFFFFFFu;
    for (uint16_t i = 0; i < KL_PENDING_QUEUE; ++i) {
      if (pending_[i].queued_ms < oldest) {
        oldest = pending_[i].queued_ms;
        slot = &pending_[i];
      }
    }
  }
  if (!slot) return;
  slot->used = true;
  slot->tries = 0;
  slot->iface_hint = iface_hint;
  slot->queued_ms = now_ms;
  slot->next_try_ms = now_ms + KL_RREQ_RETRY_MS;
  slot->pkt = *pkt;
}

void KlintoRouter::flush_pending(uint32_t dst_id, uint32_t now_ms) {
  if (dst_id == KL_ANY_GATEWAY_ID) {
    if (!gw_.valid) return;
    for (uint16_t i = 0; i < KL_PENDING_QUEUE; ++i) {
      if (!pending_[i].used || pending_[i].pkt.dst_id != KL_ANY_GATEWAY_ID) continue;
      kl_packet_t pkt = pending_[i].pkt;
      if (transmit(&pkt, gw_.iface, gw_.next_hop_id, now_ms)) {
        stats_.relayed++;
        if (pkt.flags & KL_FLAG_NEED_ACK) register_ack(&pkt, true, now_ms);
        if (sink_.status) sink_.status(sink_.ctx, pkt.msg_uuid, pkt.packet_id, KL_STATUS_SENT_TO_MESH);
      }
      pending_[i].used = false;
    }
    return;
  }
  const kl_route_entry_t *r = find_route(dst_id);
  if (!r) return;
  for (uint16_t i = 0; i < KL_PENDING_QUEUE; ++i) {
    if (!pending_[i].used) continue;
    if (pending_[i].pkt.dst_id != dst_id) continue;
    kl_packet_t pkt = pending_[i].pkt;
    if (transmit(&pkt, r->iface, r->next_hop_id, now_ms)) {
      stats_.relayed++;
      if (pkt.flags & KL_FLAG_NEED_ACK) register_ack(&pkt, false, now_ms);
      if (sink_.status) sink_.status(sink_.ctx, pkt.msg_uuid, pkt.packet_id, KL_STATUS_SENT_TO_MESH);
    }
    pending_[i].used = false;
  }
}

void KlintoRouter::register_ack(const kl_packet_t *pkt, bool via_gateway, uint32_t now_ms) {
  kl_ack_slot_t *slot = nullptr;
  for (uint16_t i = 0; i < KL_ACK_TABLE; ++i) {
    if (!acks_[i].used) {
      slot = &acks_[i];
      break;
    }
  }
  if (!slot) {
    uint32_t oldest = 0xFFFFFFFFu;
    for (uint16_t i = 0; i < KL_ACK_TABLE; ++i) {
      if (acks_[i].deadline_ms < oldest) {
        oldest = acks_[i].deadline_ms;
        slot = &acks_[i];
      }
    }
  }
  if (!slot) return;
  slot->used = true;
  slot->via_gateway = via_gateway;
  slot->attempts = 0;
  slot->deadline_ms = now_ms + cfg_.ack_timeout_ms;
  slot->pkt = *pkt;
}

bool KlintoRouter::send(kl_packet_t *pkt, uint32_t now_ms, uint8_t iface_hint, bool need_ack) {
  if (!pkt) return false;
  KlintoGuard guard(lock_);
  if (pkt->payload_len > KL_MAX_PAYLOAD) return false;
  pkt->src_id = cfg_.node_id;
  if (pkt->packet_id == 0) pkt->packet_id = kl_packet_next_id();
  pkt->magic = KL_PACKET_MAGIC;
  pkt->version = KL_PACKET_VERSION;
  pkt->ttl = cfg_.ttl;
  pkt->hop_count = 0;
  if (need_ack) pkt->flags |= KL_FLAG_NEED_ACK;

  if (pkt->dst_id == KL_BROADCAST_ID) {
    return transmit_on_all(pkt, now_ms);
  }

  if (pkt->dst_id == KL_ANY_GATEWAY_ID) {
    if (gw_.valid) {
      pkt->next_hop_id = gw_.next_hop_id;
      if (transmit(pkt, gw_.iface, gw_.next_hop_id, now_ms)) {
        if (pkt->flags & KL_FLAG_NEED_ACK) register_ack(pkt, true, now_ms);
        if (sink_.status) sink_.status(sink_.ctx, pkt->msg_uuid, pkt->packet_id, KL_STATUS_SENT_TO_MESH);
        return true;
      }
    }
    if (gateway_like()) {
      /* A gateway is itself the destination. */
      if (sink_.deliver) sink_.deliver(sink_.ctx, pkt, 0, iface_hint);
      return true;
    }
    queue_pending(pkt, iface_hint, now_ms);
    send_rreq(KL_ANY_GATEWAY_ID, iface_hint, now_ms);
    return true;
  }

  const kl_route_entry_t *r = find_route(pkt->dst_id);
  if (r) {
    pkt->next_hop_id = r->next_hop_id;
    if (transmit(pkt, r->iface, r->next_hop_id, now_ms)) {
      if (pkt->flags & KL_FLAG_NEED_ACK) register_ack(pkt, false, now_ms);
      if (sink_.status) sink_.status(sink_.ctx, pkt->msg_uuid, pkt->packet_id, KL_STATUS_SENT_TO_MESH);
      return true;
    }
  }
  queue_pending(pkt, iface_hint, now_ms);
  send_rreq(pkt->dst_id, iface_hint, now_ms);
  return true;
}

bool KlintoRouter::forward_downlink(kl_packet_t *pkt, uint32_t now_ms) {
  if (!pkt) return false;
  KlintoGuard guard(lock_);
  pkt->flags |= KL_FLAG_FROM_INTERNET;
  pkt->flags &= (uint8_t)~KL_FLAG_TO_INTERNET;
  pkt->magic = KL_PACKET_MAGIC;
  pkt->version = KL_PACKET_VERSION;
  if (pkt->packet_id == 0) pkt->packet_id = kl_packet_next_id();
  pkt->ttl = cfg_.ttl;
  pkt->hop_count = 0;
  if (pkt->dst_id == cfg_.node_id) {
    if (sink_.deliver) sink_.deliver(sink_.ctx, pkt, 0, 0xFF);
    return true;
  }
  if (pkt->dst_id == KL_BROADCAST_ID) {
    return transmit_on_all(pkt, now_ms);
  }
  const kl_route_entry_t *r = find_route(pkt->dst_id);
  if (r) {
    if (transmit(pkt, r->iface, r->next_hop_id, now_ms)) return true;
  }
  queue_pending(pkt, 0xFF, now_ms);
  send_rreq(pkt->dst_id, 0xFF, now_ms);
  return true;
}

bool KlintoRouter::send_rreq(uint32_t target, uint8_t iface_hint, uint32_t now_ms) {
  (void)iface_hint;
  kl_packet_t req;
  kl_packet_init(&req, KL_TYPE_RREQ, cfg_.node_id, target, KL_BROADCAST_ID, 0);
  req.ttl = cfg_.ttl;
  uint8_t payload[4];
  kl_write_le32(payload, cfg_.node_id);
  kl_packet_set_payload(&req, payload, sizeof(payload));
  stats_.rreq_sent++;
  return transmit_on_all(&req, now_ms);
}

/* ------------------------------------------------------------ receiving -- */

void KlintoRouter::handle_beacon(const kl_packet_t *pkt, uint8_t iface, int16_t rssi,
                                 uint32_t now_ms) {
  if (pkt->payload_len < 10) return;
  const uint32_t relay_id = kl_read_le32(pkt->payload);
  const uint32_t gateway_id = kl_read_le32(pkt->payload + 4);
  const uint8_t load = pkt->payload[8];
  const uint8_t caps = pkt->payload[9];
  (void)load;
  const bool mobile = (caps & KL_CAP_MOBILE_GW) != 0;
  if (pkt->hop_count > cfg_.gw_max_hops) return;

  learn_neighbor(relay_id, iface, rssi, now_ms, pkt->hop_count, true);
  if (relay_id != gateway_id) learn_neighbor(gateway_id, iface, rssi, now_ms, pkt->hop_count, true);

  const uint8_t hops = pkt->hop_count;
  const bool better = !gw_.valid || hops < gw_.hops || (hops == gw_.hops && rssi > gw_.rssi + 6);
  if (better) {
    gw_.valid = true;
    gw_.gateway_id = gateway_id;
    gw_.next_hop_id = relay_id;
    gw_.iface = iface;
    gw_.hops = hops;
    gw_.rssi = rssi;
    gw_.last_seen_ms = now_ms;
    gw_.mobile = mobile;
    gw_.expires_ms = now_ms + (mobile ? cfg_.mobile_gw_ttl_ms
                                      : (uint32_t)cfg_.gw_beacon_interval_ms * 3);
    upsert_route(gateway_id, relay_id, iface, hops + 1, rssi, now_ms, true);
    flush_pending(KL_ANY_GATEWAY_ID, now_ms);
  }
}

/** Learn the reverse path carried by RREQ/RREP (relay_id = prior transmitter). */

void KlintoRouter::learn_reverse_route(const kl_packet_t *pkt, uint8_t iface, int16_t rssi,
                                       uint32_t now_ms) {
  uint32_t relay_id = pkt->last_hop_id;
  if (relay_id == KL_INVALID_ID || relay_id == cfg_.node_id) {
    relay_id = pkt->payload_len >= 4 ? kl_read_le32(pkt->payload) : pkt->src_id;
  }
  learn_neighbor(relay_id, iface, rssi, now_ms, pkt->hop_count, false);
  upsert_route(pkt->src_id, relay_id, iface, (uint8_t)(pkt->hop_count + 1), rssi, now_ms,
               pkt->src_id == gw_.gateway_id);
}

void KlintoRouter::handle_rreq(kl_packet_t *pkt, uint8_t iface, int16_t rssi, uint32_t now_ms) {
  learn_reverse_route(pkt, iface, rssi, now_ms);

  /* We are the target (unicast id, or any gateway). Reply along reverse path. */
  kl_packet_t rep;
  kl_packet_init(&rep, KL_TYPE_RREP, cfg_.node_id, pkt->src_id, KL_BROADCAST_ID, 0);
  rep.msg_uuid = pkt->msg_uuid;
  rep.ttl = cfg_.ttl;
  uint8_t payload[4];
  kl_write_le32(payload, cfg_.node_id);
  kl_packet_set_payload(&rep, payload, sizeof(payload));

  const kl_route_entry_t *back = find_route(pkt->src_id);
  if (back) {
    rep.next_hop_id = back->next_hop_id;
    if (transmit(&rep, back->iface, back->next_hop_id, now_ms)) {
      stats_.rrep_sent++;
    }
  } else if (transmit(&rep, iface, pkt->src_id, now_ms)) {
    stats_.rrep_sent++;
  }
}

void KlintoRouter::handle_rrep(kl_packet_t *pkt, uint8_t iface, int16_t rssi, uint32_t now_ms) {
  learn_reverse_route(pkt, iface, rssi, now_ms);
  flush_pending(pkt->src_id, now_ms);
}

void KlintoRouter::send_ack(const kl_packet_t *original, uint8_t iface, uint32_t now_ms) {
  if (!original || original->src_id == cfg_.node_id) return;
  uint16_t chat_ref = KL_CODEC_NO_CHAT;
  uint8_t op = 0, rflags = 0;
  kl_codec_peek(original->payload, original->payload_len, &op, &rflags, &chat_ref);
  (void)op;
  (void)rflags;

  uint8_t payload[16];
  const size_t plen = kl_codec_encode_ack(payload, sizeof(payload), chat_ref, original->packet_id,
                                          KL_STATUS_RECEIVED);
  if (!plen) return;
  kl_packet_t ack;
  kl_packet_init(&ack, KL_TYPE_ACK, cfg_.node_id, original->src_id, KL_BROADCAST_ID, 0);
  ack.msg_uuid = original->msg_uuid;
  kl_packet_set_payload(&ack, payload, plen);
  const kl_route_entry_t *r = find_route(original->src_id);
  if (r) {
    transmit(&ack, r->iface, r->next_hop_id, now_ms);
  } else {
    transmit(&ack, iface, original->src_id, now_ms);
  }
  stats_.acks_sent++;
}

void KlintoRouter::on_packet(const kl_packet_t *pkt, uint8_t iface, int16_t rssi,
                             uint32_t now_ms) {
  if (!pkt) return;
  KlintoGuard guard(lock_);
  if (pkt->src_id == cfg_.node_id) return;
  stats_.rx_packets++;
  last_rssi_ = (int8_t)(rssi < -128 ? -128 : rssi > 127 ? 127 : rssi);

  /* Дешёвый фильтр next_hop. Радиодрайверы делают это до копирования
   * кадра; здесь — дополнительная защита от USB/loopback-инъекций. */
  if (pkt->next_hop_id != KL_BROADCAST_ID && pkt->next_hop_id != cfg_.node_id &&
      !(gateway_like() && pkt->next_hop_id == KL_ANY_GATEWAY_ID)) {
    stats_.dropped_policy++;
    return;
  }

  learn_neighbor(pkt->src_id, iface, rssi, now_ms, pkt->hop_count, false);
  if (pkt->last_hop_id != KL_INVALID_ID && pkt->last_hop_id != cfg_.node_id) {
    /* Каждый передатчик указывает себя, поэтому обратный маршрут корректен
     * даже для ретранслированного DATA в среде без link-layer адресов. */
    upsert_route(pkt->src_id, pkt->last_hop_id, iface, (uint8_t)(pkt->hop_count + 1), rssi,
                 now_ms, false);
    learn_neighbor(pkt->last_hop_id, iface, rssi, now_ms, pkt->hop_count, false);
  }
  if (pkt->type == KL_TYPE_GW_BEACON) handle_beacon(pkt, iface, rssi, now_ms);
  if (pkt->type == KL_TYPE_GW_BEACON && sink_.beacon) {
    sink_.beacon(sink_.ctx, pkt, rssi, iface);
  }

  const bool dup = dedup_.seen_or_add(pkt->src_id, pkt->packet_id, now_ms);
  if (dup) {
    stats_.dropped_dedup++;
    cancel_broadcast(pkt->packet_id);
    return;
  }

  /* Шлюз копирует любой услышанный DATA с NEED_CLOUD_ARCHIVE, даже если
   * кадр адресован другому узлу. Кадры самому шлюзу архивирует uplink-путь,
   * поэтому дубликата публикации нет. */
  const bool for_me = kl_packet_is_for(pkt, cfg_.node_id, gateway_like());
  if (!for_me && gateway_like() && pkt->msg_uuid != 0 &&
      (pkt->flags & KL_FLAG_NEED_CLOUD_ARCHIVE) &&
      (pkt->type == KL_TYPE_DATA || pkt->type == KL_TYPE_SYNC_ARCHIVE)) {
    if (sink_.archive) sink_.archive(sink_.ctx, pkt);
  }
  if (for_me) {
    switch (pkt->type) {
      case KL_TYPE_ACK: {
        if (pkt->payload_len >= 9) {
          const uint32_t acked = kl_read_le32(pkt->payload + 4);
          for (uint16_t i = 0; i < KL_ACK_TABLE; ++i) {
            if (!acks_[i].used || acks_[i].pkt.packet_id != acked) continue;
            const bool via_gw = acks_[i].via_gateway;
            const uint64_t uuid = acks_[i].pkt.msg_uuid;
            const uint32_t pid = acks_[i].pkt.packet_id;
            acks_[i].used = false;
            stats_.acks_received++;
            if (sink_.status) {
              sink_.status(sink_.ctx, uuid, pid,
                           via_gw ? KL_STATUS_ACKED_BY_GATEWAY : KL_STATUS_DELIVERED_TO_PEER);
            }
            break;
          }
        }
        return;
      }
      case KL_TYPE_RREQ:
        handle_rreq(const_cast<kl_packet_t *>(pkt), iface, rssi, now_ms);
        return;
      case KL_TYPE_RREP:
        handle_rrep(const_cast<kl_packet_t *>(pkt), iface, rssi, now_ms);
        return;
      case KL_TYPE_NODE_PRESENCE:
        if (gateway_like() && sink_.presence) sink_.presence(sink_.ctx, pkt, rssi, iface);
        if (pkt->flags & KL_FLAG_NEED_ACK) send_ack(pkt, iface, now_ms);
        if (sink_.deliver) sink_.deliver(sink_.ctx, pkt, rssi, iface);
        return;
      case KL_TYPE_GW_BEACON:
        break;
      case KL_TYPE_DATA:
      case KL_TYPE_SYNC_ARCHIVE:
        stats_.delivered++;
        if (pkt->flags & KL_FLAG_NEED_ACK) send_ack(pkt, iface, now_ms);
        if (sink_.deliver) sink_.deliver(sink_.ctx, pkt, rssi, iface);
        return;
      default:
        if (sink_.deliver) sink_.deliver(sink_.ctx, pkt, rssi, iface);
        return;
    }
  }

  /* Транзит. Носимые узлы экономят батарею: ретранслируют uplink только
   * когда фактически находятся рядом со шлюзом. */
  if (!relay_enabled() && pkt->type != KL_TYPE_GW_BEACON &&
      pkt->type != KL_TYPE_RREQ) {
    stats_.dropped_policy++;
    return;
  }
  if ((uint8_t)(pkt->hop_count + 1) >= pkt->ttl) {
    stats_.dropped_ttl++;
    return;
  }

  if (pkt->type == KL_TYPE_RREQ || pkt->type == KL_TYPE_GW_BEACON) {
    if (pkt->type == KL_TYPE_RREQ) learn_reverse_route(pkt, iface, rssi, now_ms);
    if (pkt->type == KL_TYPE_GW_BEACON && pkt->hop_count + 1 >= cfg_.gw_max_hops) return;
    schedule_broadcast(pkt, rssi, now_ms, iface);
    return;
  }
  if (pkt->type == KL_TYPE_RREP) {
    learn_reverse_route(pkt, iface, rssi, now_ms);
  }
  if (pkt->dst_id == KL_BROADCAST_ID) {
    schedule_broadcast(pkt, rssi, now_ms, iface);
    return;
  }
  if (pkt->dst_id == KL_ANY_GATEWAY_ID) {
    if (gw_.valid) {
      kl_packet_t fwd = *pkt;
      fwd.hop_count++;
      if (pkt->type == KL_TYPE_RREP && fwd.payload_len >= 4) {
        kl_write_le32(fwd.payload, cfg_.node_id);
      }
      if (transmit(&fwd, gw_.iface, gw_.next_hop_id, now_ms)) stats_.relayed++;
    }
    return;
  }
  const kl_route_entry_t *r = find_route(pkt->dst_id);
  if (r) {
    kl_packet_t fwd = *pkt;
    fwd.hop_count++;
    if (pkt->type == KL_TYPE_RREP && fwd.payload_len >= 4) {
      kl_write_le32(fwd.payload, cfg_.node_id);
    }
    if (transmit(&fwd, r->iface, r->next_hop_id, now_ms)) stats_.relayed++;
    return;
  }
  if ((pkt->flags & KL_FLAG_TO_INTERNET) && gw_.valid) {
    kl_packet_t fwd = *pkt;
    fwd.hop_count++;
    if (transmit(&fwd, gw_.iface, gw_.next_hop_id, now_ms)) stats_.relayed++;
  }
}

/* -------------------------------------------------------------- timers --- */

uint16_t KlintoRouter::relay_penalty_ms(uint8_t iface) const {
  if (cfg_.role != KL_ROLE_CLIENT || !cfg_.hybrid_portable) return 0;
  return iface == KL_IFACE_LORA ? cfg_.relay_penalty_lora_ms : cfg_.relay_penalty_espnow_ms;
}

uint32_t KlintoRouter::backoff_delay_ms(int16_t rssi, uint32_t salt) {  int32_t d;
  if (rssi >= -30) {
    d = 150;
  } else if (rssi <= -115) {
    d = 10;
  } else {
    d = 10 + ((int32_t)(rssi + 115) * 140) / 85;
  }
  d += (int32_t)(salt % 21);
  if (d < 10) d = 10;
  if (d > 180) d = 180;
  return (uint32_t)d;
}

void KlintoRouter::schedule_broadcast(const kl_packet_t *pkt, int16_t rssi, uint32_t now_ms,
                                      uint8_t iface) {
  kl_bcast_slot_t *slot = nullptr;
  for (uint16_t i = 0; i < KL_BCAST_QUEUE; ++i) {
    if (!bcasts_[i].used) {
      slot = &bcasts_[i];
      break;
    }
  }
  if (!slot) {
    /* Full: drop the oldest scheduled relay. */
    uint32_t oldest = 0xFFFFFFFFu;
    for (uint16_t i = 0; i < KL_BCAST_QUEUE; ++i) {
      if (bcasts_[i].due_ms < oldest) {
        oldest = bcasts_[i].due_ms;
        slot = &bcasts_[i];
      }
    }
  }
  if (!slot) return;
  slot->used = true;
  slot->packet_id = pkt->packet_id;
  uint32_t penalty = relay_penalty_ms(iface);
  slot->due_ms = now_ms + backoff_delay_ms(rssi, pkt->packet_id) + penalty;
  slot->pkt = *pkt;
}

void KlintoRouter::cancel_broadcast(uint32_t packet_id) {
  for (uint16_t i = 0; i < KL_BCAST_QUEUE; ++i) {
    if (bcasts_[i].used && bcasts_[i].packet_id == packet_id) bcasts_[i].used = false;
  }
}

void KlintoRouter::tick(uint32_t now_ms) {
  KlintoGuard guard(lock_);
  expire(now_ms);

  /* Broadcast suppression queue. */
  for (uint16_t i = 0; i < KL_BCAST_QUEUE; ++i) {
    if (!bcasts_[i].used || now_ms < bcasts_[i].due_ms) continue;
    kl_packet_t pkt = bcasts_[i].pkt;
    bcasts_[i].used = false;
    if ((uint8_t)(pkt.hop_count + 1) >= pkt.ttl) continue;
    pkt.hop_count++;
    if (pkt.type == KL_TYPE_GW_BEACON) {
      uint8_t payload[10];
      const uint32_t gateway_id = pkt.payload_len >= 8 ? kl_read_le32(pkt.payload + 4) : pkt.src_id;
      kl_write_le32(payload, cfg_.node_id);
      kl_write_le32(payload + 4, gateway_id);
      payload[8] = 0;
      payload[9] = capabilities_;
      kl_packet_set_payload(&pkt, payload, sizeof(payload));
    } else if (pkt.type == KL_TYPE_RREQ && pkt.payload_len >= 4) {
      kl_write_le32(pkt.payload, cfg_.node_id);
    }
    if (transmit_on_all(&pkt, now_ms)) stats_.relayed++;
  }

  /* ACK retries. */
  for (uint16_t i = 0; i < KL_ACK_TABLE; ++i) {
    if (!acks_[i].used || now_ms < acks_[i].deadline_ms) continue;
    kl_ack_slot_t &slot = acks_[i];
    if (slot.attempts >= cfg_.ack_retries) {
      stats_.failures++;
      slot.used = false;
      if (sink_.status) {
        sink_.status(sink_.ctx, slot.pkt.msg_uuid, slot.pkt.packet_id, KL_STATUS_FAILED);
      }
      if (slot.pkt.dst_id != KL_ANY_GATEWAY_ID) {
        for (uint16_t r = 0; r < KL_ROUTE_TABLE_SIZE; ++r) {
          if (routes_[r].valid && routes_[r].dst_id == slot.pkt.dst_id) routes_[r].valid = false;
        }
        send_rreq(slot.pkt.dst_id, 0xFF, now_ms);
      }
      continue;
    }
    slot.attempts++;
    stats_.retries++;
    if (slot.attempts >= 2 && slot.pkt.dst_id != KL_ANY_GATEWAY_ID) {
      for (uint16_t r = 0; r < KL_ROUTE_TABLE_SIZE; ++r) {
        if (routes_[r].valid && routes_[r].dst_id == slot.pkt.dst_id) routes_[r].valid = false;
      }
      send_rreq(slot.pkt.dst_id, 0xFF, now_ms);
      slot.deadline_ms = now_ms + cfg_.ack_timeout_ms;
      continue;
    }
    const kl_route_entry_t *r = find_route(slot.pkt.dst_id);
    if (r) {
      transmit(&slot.pkt, r->iface, r->next_hop_id, now_ms);
    } else if (gw_.valid) {
      transmit(&slot.pkt, gw_.iface, gw_.next_hop_id, now_ms);
    }
    const uint32_t backoff = cfg_.ack_timeout_ms * slot.attempts;
    slot.deadline_ms = now_ms + backoff;
  }

  /* Pending queue: retry route discovery. */
  for (uint16_t i = 0; i < KL_PENDING_QUEUE; ++i) {
    if (!pending_[i].used || now_ms < pending_[i].next_try_ms) continue;
    if (pending_[i].tries >= KL_RREQ_MAX_TRIES) {
      pending_[i].used = false;
      stats_.failures++;
      if (sink_.status) {
        sink_.status(sink_.ctx, pending_[i].pkt.msg_uuid, pending_[i].pkt.packet_id,
                     KL_STATUS_FAILED);
      }
      continue;
    }
    pending_[i].tries++;
    pending_[i].next_try_ms = now_ms + KL_RREQ_RETRY_MS;
    send_rreq(pending_[i].pkt.dst_id, pending_[i].iface_hint, now_ms);
  }

  maybe_presence(now_ms);

  if (is_gateway() && (last_beacon_ms_ == 0 || now_ms - last_beacon_ms_ >= cfg_.gw_beacon_interval_ms)) {
    last_beacon_ms_ = now_ms;
    kl_packet_t beacon;
    kl_packet_init(&beacon, KL_TYPE_GW_BEACON, cfg_.node_id, KL_BROADCAST_ID, KL_BROADCAST_ID, 0);
    beacon.ttl = cfg_.gw_max_hops;
    uint8_t payload[10];
    kl_write_le32(payload, cfg_.node_id);
    kl_write_le32(payload + 4, cfg_.node_id);
    payload[8] = 0;
    payload[9] = capabilities_;
    kl_packet_set_payload(&beacon, payload, sizeof(payload));
    if (transmit_on_all(&beacon, now_ms)) stats_.beacons_sent++;
  }

  if (mobile_gateway_active() &&
      (last_mobile_beacon_ms_ == 0 ||
       now_ms - last_mobile_beacon_ms_ >= cfg_.mobile_gw_beacon_ms)) {
    emit_mobile_beacon(now_ms);
  }
}

void KlintoRouter::on_channel_changed(uint8_t wifi_channel) {
  KlintoGuard guard(lock_);
  cfg_.wifi_channel = wifi_channel;
  memset(routes_, 0, sizeof(routes_));
  memset(neighbors_, 0, sizeof(neighbors_));
  memset(&gw_, 0, sizeof(gw_));
  memset(pending_, 0, sizeof(pending_));
  memset(acks_, 0, sizeof(acks_));
  memset(bcasts_, 0, sizeof(bcasts_));
  dedup_.reset();
  last_presence_ms_ = 0;
  last_presence_gw_hop_ = 0xFF;
  stats_.dropped_policy++;
}

void KlintoRouter::emit_gateway_beacon(uint32_t now_ms) {
  KlintoGuard guard(lock_);
  if (!is_gateway()) return;
  last_beacon_ms_ = now_ms;
  kl_packet_t beacon;
  kl_packet_init(&beacon, KL_TYPE_GW_BEACON, cfg_.node_id, KL_BROADCAST_ID, KL_BROADCAST_ID, 0);
  beacon.ttl = cfg_.gw_max_hops;
  uint8_t payload[10];
  kl_write_le32(payload, cfg_.node_id);
  kl_write_le32(payload + 4, cfg_.node_id);
  payload[8] = 0;
  payload[9] = capabilities_;
  kl_packet_set_payload(&beacon, payload, sizeof(payload));
  if (transmit_on_all(&beacon, now_ms)) stats_.beacons_sent++;
}

void KlintoRouter::emit_mobile_beacon(uint32_t now_ms) {
  last_mobile_beacon_ms_ = now_ms;
  kl_packet_t beacon;
  kl_packet_init(&beacon, KL_TYPE_GW_BEACON, cfg_.node_id, KL_BROADCAST_ID, KL_BROADCAST_ID, 0);
  beacon.ttl = cfg_.gw_max_hops;
  beacon.hop_count = cfg_.mobile_gw_hops;
  uint8_t payload[10];
  kl_write_le32(payload, cfg_.node_id);
  kl_write_le32(payload + 4, cfg_.node_id);
  payload[8] = 0;
  payload[9] = (uint8_t)(capabilities_ | KL_CAP_MOBILE_GW | KL_CAP_HYBRID_PORTABLE);
  kl_packet_set_payload(&beacon, payload, sizeof(payload));
  if (transmit_on_all(&beacon, now_ms)) stats_.beacons_sent++;
}

void KlintoRouter::maybe_presence(uint32_t now_ms) {
  if (gateway_like()) return;
  const bool gw_changed = gw_.valid && gw_.hops != last_presence_gw_hop_;
  const bool due = last_presence_ms_ == 0 || now_ms - last_presence_ms_ >= cfg_.presence_interval_ms;
  if (!due && !gw_changed) return;

  uint8_t payload[16];
  const size_t plen = kl_codec_encode_presence(payload, sizeof(payload), battery_, last_rssi_,
                                               (uint8_t)cfg_.role, capabilities_);
  if (!plen) return;
  kl_packet_t pkt;
  kl_packet_init(&pkt, KL_TYPE_NODE_PRESENCE, cfg_.node_id, KL_ANY_GATEWAY_ID, KL_BROADCAST_ID,
                 KL_FLAG_TO_INTERNET);
  kl_packet_set_payload(&pkt, payload, plen);
  if (gw_.valid) {
    if (transmit(&pkt, gw_.iface, gw_.next_hop_id, now_ms)) {
      stats_.presence_sent++;
    }
  } else {
    if (transmit_on_all(&pkt, now_ms)) stats_.presence_sent++;
  }
  last_presence_ms_ = now_ms;
  last_presence_gw_hop_ = gw_.valid ? gw_.hops : 0xFF;
}

void KlintoRouter::set_battery(uint8_t percent, int8_t rssi) {
  KlintoGuard guard(lock_);
  battery_ = percent > 100 ? 100 : percent;
  last_rssi_ = rssi;
  if (cfg_.role != KL_ROLE_CLIENT || charging_) {
    battery_low_ = false;
  } else if (battery_ < cfg_.relay_battery_min) {
    battery_low_ = true;
  } else if (battery_ > cfg_.relay_battery_resume) {
    battery_low_ = false;
  }
}

void KlintoRouter::set_charging(bool charging) {
  KlintoGuard guard(lock_);
  charging_ = charging;
  if (charging) battery_low_ = false;
}

void KlintoRouter::set_relay_allowed(bool allowed) {
  KlintoGuard guard(lock_);
  relay_allowed_ = allowed;
}

void KlintoRouter::set_internet_status(bool has_internet, uint16_t rtt_ms, bool allow_relay) {
  KlintoGuard guard(lock_);
  inet_has_ = has_internet;
  inet_rtt_ms_ = rtt_ms;
  relay_allowed_ = allow_relay;
  const bool active = has_internet && allow_relay && cfg_.role == KL_ROLE_CLIENT &&
                      cfg_.hybrid_portable && !battery_low_;
  if (active != mobile_gateway_) {
    mobile_gateway_ = active;
    last_mobile_beacon_ms_ = 0;
  }
}

bool KlintoRouter::relay_enabled() const {
  if (cfg_.role != KL_ROLE_CLIENT) return true;
  return cfg_.hybrid_portable && relay_allowed_ && !battery_low_;
}

bool KlintoRouter::mobile_gateway_active() const {
  return cfg_.role == KL_ROLE_CLIENT && cfg_.hybrid_portable && mobile_gateway_ &&
         inet_has_ && relay_allowed_ && !battery_low_;
}

bool KlintoRouter::gateway_like() const {
  return cfg_.role == KL_ROLE_GATEWAY || mobile_gateway_active();
}

void KlintoRouter::notify_status(uint64_t msg_uuid, uint32_t packet_id, uint8_t status) {
  if (sink_.status) sink_.status(sink_.ctx, msg_uuid, packet_id, status);
}

uint16_t KlintoRouter::pending_count() const {
  uint16_t n = 0;
  for (uint16_t i = 0; i < KL_PENDING_QUEUE; ++i) n += pending_[i].used ? 1 : 0;
  return n;
}

uint16_t KlintoRouter::ack_count() const {
  uint16_t n = 0;
  for (uint16_t i = 0; i < KL_ACK_TABLE; ++i) n += acks_[i].used ? 1 : 0;
  return n;
}
