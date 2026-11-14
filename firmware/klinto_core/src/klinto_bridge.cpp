#include "klinto_bridge.h"
#include "klinto_codec.h"
#include "klinto_crypto.h"
#include "klinto_owner.h"
#include "klinto_util.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#ifndef KL_FIRMWARE_BUILD
#define KL_FIRMWARE_BUILD 0
#endif

KlintoClientBridge::KlintoClientBridge()
    : router_(nullptr),
      link_(nullptr),
      outbox_(nullptr),
      seq_(0),
      rx_len_(0),
      last_flush_ms_(0),
      status_head_(0),
      status_tail_(0) {
  memset(&cfg_, 0, sizeof(cfg_));
  memset(&sink_, 0, sizeof(sink_));
  memset(frags_, 0, sizeof(frags_));
  memset(rx_buf_, 0, sizeof(rx_buf_));
  memset(statuses_, 0, sizeof(statuses_));
}

void KlintoClientBridge::init(KlintoRouter *router, const kl_config_t *cfg, IClientLink *link,
                          KlintoFlashQueue *outbox, const kl_bridge_sink_t *sink) {
  router_ = router;
  if (cfg) cfg_ = *cfg;
  link_ = link;
  outbox_ = outbox;
  if (sink) sink_ = *sink;
  memset(frags_, 0, sizeof(frags_));
  memset(rx_buf_, 0, sizeof(rx_buf_));
  memset(statuses_, 0, sizeof(statuses_));
  status_head_ = 0;
  status_tail_ = 0;
  rx_len_ = 0;
  seq_ = 0;
}

uint16_t KlintoClientBridge::crc16(const uint8_t *data, size_t len) {
  return kl_crc16(data, len, 0xFFFF);
}

void KlintoClientBridge::log_line(const char *fmt, ...) {
  if (!sink_.log) return;
  char line[160];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(line, sizeof(line), fmt, ap);
  va_end(ap);
  sink_.log(sink_.ctx, line);
}

bool KlintoClientBridge::send_frame(uint8_t type, const uint8_t *payload, size_t len, uint8_t flags) {
  if (!link_ || !link_->connected()) return false;
  KlintoGuard guard(tx_lock_);
  const uint16_t mtu = link_->mtu();
  if (mtu <= 10) return false;
  const size_t frame_room = (size_t)mtu - 3;      /* ATT payload */
  const size_t chunk_room = frame_room - KL_CLIENT_HEADER_SIZE - 2; /* frame overhead */
  if (chunk_room < 12) return false;

  if (len <= chunk_room) {
    uint8_t frame[KL_CLIENT_MAX_FRAME + 16];
    if (len + KL_CLIENT_HEADER_SIZE + 2 > sizeof(frame)) return false;
    frame[0] = KL_CLIENT_MAGIC0;
    frame[1] = KL_CLIENT_MAGIC1;
    frame[2] = KL_CLIENT_VERSION;
    frame[3] = type;
    frame[4] = flags;
    kl_write_le16(frame + 5, seq_++);
    kl_write_le16(frame + 7, (uint16_t)len);
    if (len) memcpy(frame + KL_CLIENT_HEADER_SIZE, payload, len);
    const uint16_t crc = crc16(frame + 2, KL_CLIENT_HEADER_SIZE - 2 + len);
    kl_write_le16(frame + KL_CLIENT_HEADER_SIZE + len, crc);
    return link_->send(frame, KL_CLIENT_HEADER_SIZE + len + 2);
  }

  const uint16_t msg_id = seq_;
  const size_t frag_header = 6;
  const size_t chunk = chunk_room - frag_header;
  if (chunk < 8) return false;
  for (size_t offset = 0; offset < len; offset += chunk) {
    const size_t take = (len - offset) > chunk ? chunk : (len - offset);
    uint8_t frame[KL_CLIENT_MAX_FRAME + 16];
    frame[0] = KL_CLIENT_MAGIC0;
    frame[1] = KL_CLIENT_MAGIC1;
    frame[2] = KL_CLIENT_VERSION;
    frame[3] = type;
    frame[4] = (uint8_t)(flags | KL_CF_FLAG_FRAGMENT);
    kl_write_le16(frame + 5, seq_++);
    kl_write_le16(frame + 7, (uint16_t)(frag_header + take));
    kl_write_le16(frame + KL_CLIENT_HEADER_SIZE, msg_id);
    kl_write_le16(frame + KL_CLIENT_HEADER_SIZE + 2, (uint16_t)offset);
    kl_write_le16(frame + KL_CLIENT_HEADER_SIZE + 4, (uint16_t)len);
    memcpy(frame + KL_CLIENT_HEADER_SIZE + frag_header, payload + offset, take);
    const uint16_t crc =
        crc16(frame + 2, KL_CLIENT_HEADER_SIZE - 2 + frag_header + take);
    kl_write_le16(frame + KL_CLIENT_HEADER_SIZE + frag_header + take, crc);
    if (!link_->send(frame, KL_CLIENT_HEADER_SIZE + frag_header + take + 2)) return false;
  }
  return true;
}

bool KlintoClientBridge::send_legacy_frame(uint8_t type, const char *json, size_t len) {
  if (!link_ || !link_->connected() || !json || len == 0 || len > 1024) return false;
  uint8_t frame[1100];
  frame[0] = 0xA5;
  frame[1] = 0x5A;
  frame[2] = 1;
  frame[3] = type;
  kl_write_le16(frame + 4, (uint16_t)len);
  memcpy(frame + 6, json, len);
  kl_write_le16(frame + 6 + len, crc16(frame + 2, 4u + len));
  return link_->send(frame, 6u + len + 2u);
}

void KlintoClientBridge::handle_legacy_frame(uint8_t type, const uint8_t *payload, size_t len) {
  (void)payload;
  (void)len;
  if (type != 1 && type != 6) return; /* HELLO или PING */
  /* Ответ нельзя отправлять из GATT-колбэка: NimBLE может зависнуть.
   * Запоминаем тип и отдаём INFO/PONG из clientTask. */
  legacy_reply_type_ = type;
}

void KlintoClientBridge::flush_legacy_reply() {
  if (!legacy_reply_type_) return;
  const uint8_t type = legacy_reply_type_;
  legacy_reply_type_ = 0;
  const char *role = cfg_.role == KL_ROLE_GATEWAY
                         ? "gateway"
                         : (cfg_.role == KL_ROLE_ROUTER ? "repeater" : "wearable");
  char json[320];
  const int n = snprintf(
      json, sizeof(json),
      "{\"v\":1,\"kind\":\"info\",\"hardwareId\":\"%s\",\"bleMac\":\"%s\","
      "\"publicId\":\"%lu\",\"role\":\"%s\",\"firmware\":\"1.4/%u\",\"battery\":%u,"
      "\"gateway\":%s,\"queue\":%u,\"rssi\":-50,\"attached\":true,\"ownerNetId\":%lu,"
      "\"ownerPrefix\":\"%s\",\"bleMod6\":\"%s\"}",
      cfg_.hardware_id, cfg_.ble_mod6, (unsigned long)cfg_.node_id, role,
      (unsigned)KL_FIRMWARE_BUILD, (unsigned)(router_ ? router_->battery_percent() : 0),
      cfg_.role == KL_ROLE_GATEWAY ? "true" : "false", (unsigned)pending_outbox(),
      (unsigned long)cfg_.owner_net_id, cfg_.owner_ble_prefix, cfg_.ble_mod6);
  if (n > 0 && (size_t)n < sizeof(json)) {
    send_legacy_frame(type == 6 ? 7 : 2, json, (size_t)n);
  }
}

void KlintoClientBridge::on_link_data(const uint8_t *data, size_t len) {  if (!data || !len) return;
  if (rx_len_ + len > sizeof(rx_buf_)) {
    /* Resync: drop up to the next magic pair. */
    rx_len_ = 0;
    return;
  }
  memcpy(rx_buf_ + rx_len_, data, len);
  rx_len_ += len;

  size_t consumed = 0;
  while (rx_len_ - consumed >= KL_CLIENT_HEADER_SIZE + 2) {
    const uint8_t *p = rx_buf_ + consumed;
    /* Совместимость: текущая мобильная сборка ещё шлёт кадры A5 5A. */
    if (rx_len_ - consumed >= 8 && p[0] == 0xA5 && p[1] == 0x5A) {
      const uint16_t legacy_len = (uint16_t)(p[4] | ((uint16_t)p[5] << 8));
      if (legacy_len <= 1024) {
        const size_t legacy_total = 6u + legacy_len + 2u;
        if (rx_len_ - consumed < legacy_total) break;
        const uint16_t legacy_crc =
            (uint16_t)(p[6 + legacy_len] | ((uint16_t)p[6 + legacy_len + 1] << 8));
        if (crc16(p + 2, 4u + legacy_len) == legacy_crc) {
          handle_legacy_frame(p[3], p + 6, legacy_len);
          consumed += legacy_total;
          continue;
        }
      }
    }
    if (p[0] != KL_CLIENT_MAGIC0 || p[1] != KL_CLIENT_MAGIC1 ||
        p[2] != KL_CLIENT_VERSION) {
      consumed++;
      continue;
    }
    const uint16_t plen = (uint16_t)(p[7] | ((uint16_t)p[8] << 8));
    if (plen > KL_CLIENT_MAX_FRAME) {
      consumed++;
      continue;
    }
    const size_t total = KL_CLIENT_HEADER_SIZE + plen + 2;
    if (rx_len_ - consumed < total) break;
    const uint16_t expected = (uint16_t)(p[KL_CLIENT_HEADER_SIZE + plen] |
                                         ((uint16_t)p[KL_CLIENT_HEADER_SIZE + plen + 1] << 8));
    if (crc16(p + 2, KL_CLIENT_HEADER_SIZE - 2 + plen) != expected) {
      consumed++;
      continue;
    }
    const uint8_t type = p[3];
    const uint8_t flags = p[4];
    const uint8_t *payload = p + KL_CLIENT_HEADER_SIZE;
    if (flags & KL_CF_FLAG_FRAGMENT) {
      if (plen < 6) {
        consumed += total;
        continue;
      }
      const uint16_t msg_id = (uint16_t)(payload[0] | ((uint16_t)payload[1] << 8));
      const uint16_t offset = (uint16_t)(payload[2] | ((uint16_t)payload[3] << 8));
      const uint16_t frag_total = (uint16_t)(payload[4] | ((uint16_t)payload[5] << 8));
      const uint8_t *chunk = payload + 6;
      const size_t chunk_len = plen - 6;
      if (frag_total == 0 || frag_total > KL_CLIENT_MAX_FRAME ||
          (size_t)offset + chunk_len > frag_total) {
        consumed += total;
        continue;
      }
      FragSlot *slot = nullptr;
      for (int i = 0; i < 2; ++i) {
        if (frags_[i].used && frags_[i].type == type && frags_[i].total == frag_total) {
          slot = &frags_[i];
          break;
        }
      }
      if (!slot) {
        for (int i = 0; i < 2; ++i) {
          if (!frags_[i].used) {
            slot = &frags_[i];
            break;
          }
        }
      }
      if (!slot) {
        /* Replace the oldest reassembly. */
        slot = frags_[0].started_ms < frags_[1].started_ms ? &frags_[0] : &frags_[1];
      }
      if (offset == 0 || slot->type != type || slot->total != frag_total) {
        memset(slot, 0, sizeof(*slot));
        slot->used = true;
        slot->type = type;
        slot->total = frag_total;
        slot->started_ms = kl_uptime_ms();
      }
      (void)msg_id;
      memcpy(slot->data + offset, chunk, chunk_len);
      slot->covered = (uint16_t)(slot->covered + chunk_len);
      if (slot->covered >= slot->total) {
        handle_frame(type, flags & (uint8_t)~KL_CF_FLAG_FRAGMENT, slot->data, slot->total);
        slot->used = false;
      }
    } else {
      handle_frame(type, flags, payload, plen);
    }
    consumed += total;
  }
  if (consumed > 0) {
    memmove(rx_buf_, rx_buf_ + consumed, rx_len_ - consumed);
    rx_len_ -= consumed;
  }
  if (rx_len_ > sizeof(rx_buf_) - 64) rx_len_ = 0;
}

void KlintoClientBridge::handle_frame(uint8_t type, uint8_t flags, const uint8_t *payload,
                                  size_t len) {
  (void)flags;
  switch (type) {
    case KL_CF_HELLO:
      send_info();
      break;
    case KL_CF_RPC_UP:
      handle_rpc_up(payload, len);
      break;
    case KL_CF_CONFIG:
      handle_config(payload, len);
      break;
    case KL_CF_PROXY_DOWN:
      handle_proxy_down(payload, len);
      break;
    case KL_CF_INET_STATUS:
      handle_inet_status(payload, len);
      break;
    case KL_CF_SET_OWNER:
      handle_set_owner(payload, len);
      break;
    case KL_CF_SET_OWNER_LOCAL:
      handle_local_owner(payload, len);
      break;
    case KL_CF_PING: {
      uint8_t pong[8];
      kl_write_le32(pong, kl_uptime_ms());
      send_frame(KL_CF_PONG, pong, 4);
      break;
    }
    default:
      break;
  }
}

void KlintoClientBridge::handle_config(const uint8_t *payload, size_t len) {
  if (!payload || !len) return;
  char json[512];
  const size_t copy = len < sizeof(json) - 1 ? len : sizeof(json) - 1;
  memcpy(json, payload, copy);
  json[copy] = '\0';
  if (sink_.config) sink_.config(sink_.ctx, json, copy);
}

void KlintoClientBridge::handle_proxy_down(const uint8_t *payload, size_t len) {
  if (!payload || !len || !router_) return;
  kl_packet_t pkt;
  if (!kl_packet_parse(payload, len, &pkt)) return;
  router_->forward_downlink(&pkt, kl_uptime_ms());
}

void KlintoClientBridge::handle_inet_status(const uint8_t *payload, size_t len) {
  if (!payload || len < 4) return;
  const bool has_internet = payload[0] != 0;
  const uint16_t rtt = (uint16_t)(payload[1] | ((uint16_t)payload[2] << 8));
  const bool allow_relay = payload[3] != 0;
  if (sink_.inet_status) sink_.inet_status(sink_.ctx, has_internet, rtt, allow_relay);
}

void KlintoClientBridge::handle_set_owner(const uint8_t *payload, size_t len) {
  kl_owner_claim_t claim;
  if (!kl_owner_claim_parse(payload, len, &claim)) {
    log_line("[klinto] set_owner: bad payload");
    return;
  }
  if (claim.epoch <= cfg_.owner_epoch) {
    log_line("[klinto] set_owner: stale epoch");
    return;
  }
  if (!sink_.verify_owner_claim ||
      !kl_owner_claim_verify(cfg_.ble_mod6, &claim, sink_.verify_owner_claim, sink_.ctx)) {
    log_line("[klinto] set_owner: signature rejected");
    return;
  }
  cfg_.owner_net_id = claim.net_id;
  cfg_.owner_epoch = claim.epoch;
  memcpy(cfg_.owner_ble_prefix, claim.prefix, sizeof(cfg_.owner_ble_prefix));
  if (sink_.owner_changed) {
    sink_.owner_changed(sink_.ctx, claim.prefix, claim.net_id, claim.epoch);
  }
  log_line("[klinto] owner changed: %s net=%lu", claim.prefix, (unsigned long)claim.net_id);
}

void KlintoClientBridge::handle_local_owner(const uint8_t *payload, size_t len) {
  /* Первичная локальная привязка по BLE, без интернета и без подписи.
   * Разрешена только для ещё не привязанного модуля (prefix 00000000). */
  if (!payload || len < 16) return;
  if (strncmp(cfg_.owner_ble_prefix, "00000000", 8) != 0) {
    log_line("[klinto] local owner ignored: already bound");
    return;
  }
  char prefix[KL_OWNER_PREFIX_LEN + 1];
  memset(prefix, 0, sizeof(prefix));
  for (int i = 0; i < KL_OWNER_PREFIX_LEN; ++i) prefix[i] = (char)payload[i];
  char normalized[KL_OWNER_PREFIX_LEN + 1];
  if (!kl_owner_prefix_normalize(prefix, normalized)) return;
  const uint32_t net_id = kl_read_le32(payload + 8);
  const uint32_t epoch = kl_read_le32(payload + 12);
  if (sink_.owner_changed) {
    sink_.owner_changed(sink_.ctx, normalized, net_id, epoch ? epoch : 1);
  }
  log_line("[klinto] local owner set: %s net=%lu", normalized, (unsigned long)net_id);
}

bool KlintoClientBridge::proxy_uplink(const kl_packet_t *pkt) {
  if (!pkt) return false;
  uint8_t wire[KL_MAX_PACKET_SIZE];
  const size_t len = kl_packet_serialize(pkt, wire, sizeof(wire));
  if (!len) return false;
  if (send_frame(KL_CF_PROXY_UP, wire, len, KL_CF_FLAG_URGENT)) return true;
  return false;
}

void KlintoClientBridge::handle_rpc_up(const uint8_t *payload, size_t len) {
  if (!payload || len < KL_CLIENT_UP_HEADER || !router_) return;
  const uint32_t dst = kl_read_le32(payload);
  const uint8_t app_flags = payload[4];
  const uint64_t uuid = kl_read_le64(payload + 5);
  const uint8_t *rpc = payload + KL_CLIENT_UP_HEADER;
  const size_t rpc_len = len - KL_CLIENT_UP_HEADER;
  if (!rpc_len || rpc_len > KL_MAX_TEXT + 8) {
    status(uuid, 0, KL_STATUS_FAILED);
    return;
  }

  /* Re-encode text through Unishox2 (compression always precedes crypto). */
  uint8_t plain[KL_MAX_PAYLOAD];
  size_t plain_len = 0;
  uint8_t op = 0, rflags = 0;
  uint16_t chat_ref = KL_CODEC_NO_CHAT;
  if (!kl_codec_peek(rpc, rpc_len, &op, &rflags, &chat_ref)) {
    status(uuid, 0, KL_STATUS_FAILED);
    return;
  }
  log_line("[TRACE 1/4] BLE->NODE: recv RPC cmd=%u len=%u msg_uuid=%08lx%08lx dst=%lu",
           (unsigned)op, (unsigned)rpc_len, (unsigned long)(uuid >> 32),
           (unsigned long)(uuid & 0xFFFFFFFFu), (unsigned long)dst);
  if (op == KL_RPC_SEND_TEXT) {
    kl_rpc_text_t text;
    char decoded[KL_MAX_TEXT + 1];
    if (!kl_codec_decode_text(rpc, rpc_len, &text, decoded, sizeof(decoded))) {
      status(uuid, 0, KL_STATUS_FAILED);
      return;
    }
    plain_len = kl_codec_encode_text(plain, sizeof(plain), chat_ref, decoded, strlen(decoded),
                                     text.rpc_flags);
  } else {
    if (rpc_len > sizeof(plain)) {
      status(uuid, 0, KL_STATUS_FAILED);
      return;
    }
    memcpy(plain, rpc, rpc_len);
    plain_len = rpc_len;
  }
  if (!plain_len) {
    status(uuid, 0, KL_STATUS_FAILED);
    return;
  }

  kl_packet_t pkt;
  kl_packet_init(&pkt, KL_TYPE_DATA, cfg_.node_id, dst, KL_BROADCAST_ID,
                 (uint8_t)(app_flags | KL_FLAG_NEED_ACK | KL_FLAG_TEMP_MESH_KEY |
                           (dst == KL_BROADCAST_ID ? 0 : KL_FLAG_NEED_CLOUD_ARCHIVE)));
  pkt.msg_uuid = uuid ? uuid : kl_snowflake_next(cfg_.node_id, kl_uptime_ms());

  if (cfg_.has_temp_key) {
    kl_crypto_aad_t aad;
    memset(&aad, 0, sizeof(aad));
    aad.packet_id = pkt.packet_id;
    aad.msg_uuid = pkt.msg_uuid;
    aad.src_id = pkt.src_id;
    aad.dst_id = pkt.dst_id;
    aad.type = pkt.type;
    aad.flags = pkt.flags;
    aad.payload_len = (uint8_t)(KL_CRYPTO_HDR_LEN + plain_len + KL_TEMP_TAG_LEN);
    size_t sealed_len = 0;
    if (!kl_crypto_seal(cfg_.temp_mesh_key, &aad, plain, plain_len, KL_TEMP_TAG_LEN, pkt.payload,
                        sizeof(pkt.payload), &sealed_len)) {
      status(pkt.msg_uuid, pkt.packet_id, KL_STATUS_FAILED);
      return;
    }
    pkt.payload_len = (uint8_t)sealed_len;
  } else {
#ifdef KL_ALLOW_PLAINTEXT_MESH
    memcpy(pkt.payload, plain, plain_len);
    pkt.payload_len = (uint8_t)plain_len;
    pkt.flags = (uint8_t)(pkt.flags & ~KL_FLAG_TEMP_MESH_KEY);
#else
    log_line("mesh temp key is not provisioned; refusing to send");
    status(pkt.msg_uuid, pkt.packet_id, KL_STATUS_FAILED);
    return;
#endif
  }

  if (router_->send(&pkt, kl_uptime_ms(), 0xFF, true)) {
    status(pkt.msg_uuid, pkt.packet_id, KL_STATUS_QUEUED);
  } else {
    status(pkt.msg_uuid, pkt.packet_id, KL_STATUS_FAILED);
  }
}

void KlintoClientBridge::deliver_mesh(const kl_packet_t *pkt) {
  if (!pkt) return;
  kl_packet_t out = *pkt;

  /* Decrypt and decompress into a transparent RPC for the app. */
  if ((pkt->flags & KL_FLAG_TEMP_MESH_KEY) && cfg_.has_temp_key &&
      kl_crypto_is_envelope(pkt->payload, pkt->payload_len)) {
    kl_crypto_aad_t aad;
    memset(&aad, 0, sizeof(aad));
    aad.packet_id = pkt->packet_id;
    aad.msg_uuid = pkt->msg_uuid;
    aad.src_id = pkt->src_id;
    aad.dst_id = pkt->dst_id;
    aad.type = pkt->type;
    aad.flags = pkt->flags;
    aad.payload_len = pkt->payload_len;
    uint8_t plain[KL_MAX_PAYLOAD];
    size_t plain_len = 0;
    if (!kl_crypto_open(cfg_.temp_mesh_key, pkt->payload, pkt->payload_len, &aad, plain,
                        sizeof(plain), &plain_len)) {
      log_line("drop: mesh decrypt failed (uuid=%08lx)", (unsigned long)pkt->msg_uuid);
      return;
    }
    uint8_t op = 0, rflags = 0;
    uint16_t chat = KL_CODEC_NO_CHAT;
    if (!kl_codec_peek(plain, plain_len, &op, &rflags, &chat)) return;
    if (op == KL_RPC_SEND_TEXT) {
      kl_rpc_text_t text;
      char decoded[KL_MAX_TEXT + 1];
      if (!kl_codec_decode_text(plain, plain_len, &text, decoded, sizeof(decoded))) return;
      out.payload_len = (uint8_t)kl_codec_encode_text(out.payload, sizeof(out.payload), text.chat_ref,
                                                      decoded, strlen(decoded), text.rpc_flags);
    } else {
      memcpy(out.payload, plain, plain_len);
      out.payload_len = (uint8_t)plain_len;
    }
    out.flags = (uint8_t)(out.flags & ~(KL_FLAG_TEMP_MESH_KEY | KL_FLAG_COMPRESSED_UNISHOX));
  }

  uint8_t wire[KL_MAX_PACKET_SIZE];
  const size_t wire_len = kl_packet_serialize(&out, wire, sizeof(wire));
  if (!wire_len) return;

  if (link_ && link_->connected() && send_frame(KL_CF_RPC_DOWN, wire, wire_len)) {
    log_line("[TRACE 4/4] HUB->GW->NODE->BLE: delivered msg_uuid=%08lx%08lx src=%lu",
             (unsigned long)(out.msg_uuid >> 32), (unsigned long)(out.msg_uuid & 0xFFFFFFFFu),
             (unsigned long)out.src_id);
    return;
  }
  if (outbox_) outbox_->push(&out);
}

void KlintoClientBridge::status(uint64_t msg_uuid, uint32_t packet_id, uint8_t status_code) {
  StatusEvt evt;
  memset(&evt, 0, sizeof(evt));
  evt.msg_uuid = msg_uuid;
  evt.packet_id = packet_id;
  evt.status = status_code;
  evt.kind = 0;
  if (link_ && link_->connected()) {
    uint8_t payload[13];
    kl_write_le64(payload, msg_uuid);
    kl_write_le32(payload + 8, packet_id);
    payload[12] = status_code;
    if (send_frame(KL_CF_STATUS, payload, sizeof(payload), KL_CF_FLAG_URGENT)) return;
  }
  queue_status(evt);
}

void KlintoClientBridge::synced(uint64_t msg_uuid, uint32_t server_seq) {
  StatusEvt evt;
  memset(&evt, 0, sizeof(evt));
  evt.msg_uuid = msg_uuid;
  evt.server_seq = server_seq;
  evt.status = KL_STATUS_SYNCED_PERMANENT;
  evt.kind = 1;
  if (link_ && link_->connected()) {
    uint8_t payload[13];
    kl_write_le64(payload, msg_uuid);
    kl_write_le32(payload + 8, server_seq);
    payload[12] = KL_STATUS_SYNCED_PERMANENT;
    if (send_frame(KL_CF_SYNC_ACK, payload, sizeof(payload), KL_CF_FLAG_URGENT)) return;
  }
  queue_status(evt);
}

void KlintoClientBridge::queue_status(const StatusEvt &evt) {
  KlintoGuard guard(status_lock_);
  const uint8_t next = (uint8_t)((status_head_ + 1) % 16);
  if (next == status_tail_) {
    /* Drop the oldest status; the app will resync from the server anyway. */
    status_tail_ = (uint8_t)((status_tail_ + 1) % 16);
  }
  statuses_[status_head_] = evt;
  status_head_ = next;
}

void KlintoClientBridge::flush_statuses() {
  if (!link_ || !link_->connected()) return;
  KlintoGuard guard(status_lock_);
  while (status_tail_ != status_head_) {
    const StatusEvt &evt = statuses_[status_tail_];
    bool ok;
    if (evt.kind == 1) {
      uint8_t payload[13];
      kl_write_le64(payload, evt.msg_uuid);
      kl_write_le32(payload + 8, evt.server_seq);
      payload[12] = evt.status;
      ok = send_frame(KL_CF_SYNC_ACK, payload, sizeof(payload), KL_CF_FLAG_URGENT);
    } else {
      uint8_t payload[13];
      kl_write_le64(payload, evt.msg_uuid);
      kl_write_le32(payload + 8, evt.packet_id);
      payload[12] = evt.status;
      ok = send_frame(KL_CF_STATUS, payload, sizeof(payload), KL_CF_FLAG_URGENT);
    }
    if (!ok) return;
    status_tail_ = (uint8_t)((status_tail_ + 1) % 16);
  }
}

bool KlintoClientBridge::send_info() {
  char info[224];
  const int n = snprintf(
      info, sizeof(info),
      "{\"v\":3,\"kind\":\"info\",\"nodeId\":%lu,\"role\":%u,\"mtu\":%u,\"queue\":%u,"
      "\"ownerNetId\":%lu,\"ownerPrefix\":\"%s\",\"bleMod6\":\"%s\"}",
      (unsigned long)cfg_.node_id, (unsigned)cfg_.role,
      (unsigned)(link_ ? link_->mtu() : 0), (unsigned)(outbox_ ? outbox_->count() : 0),
      (unsigned long)cfg_.owner_net_id, cfg_.owner_ble_prefix, cfg_.ble_mod6);
  if (n <= 0) return false;
  return send_frame(KL_CF_INFO, (const uint8_t *)info, (size_t)n);
}

void KlintoClientBridge::flush_outbox() {
  if (!outbox_ || !link_ || !link_->connected()) return;
  kl_packet_t pkt;
  int budget = 4;
  while (budget-- > 0 && !outbox_->empty()) {
    if (!outbox_->peek(&pkt)) {
      outbox_->pop(nullptr);
      continue;
    }
    uint8_t wire[KL_MAX_PACKET_SIZE];
    const size_t wire_len = kl_packet_serialize(&pkt, wire, sizeof(wire));
    if (!wire_len || !send_frame(KL_CF_RPC_DOWN, wire, wire_len)) return;
    outbox_->pop(nullptr);
  }
}

void KlintoClientBridge::loop(uint32_t now_ms) {
  if (link_) link_->poll(now_ms);
  if (link_ && link_->connected()) {
    flush_legacy_reply();
  }
  if (link_ && link_->connected() && now_ms - last_flush_ms_ > 250) {
    last_flush_ms_ = now_ms;
    flush_statuses();
    flush_outbox();
  }
  for (int i = 0; i < 2; ++i) {
    if (frags_[i].used && now_ms - frags_[i].started_ms > 15000) frags_[i].used = false;
  }
}
