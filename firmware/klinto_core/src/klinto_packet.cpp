#include "klinto_packet.h"
#include "klinto_util.h"

#include <atomic>
#include <string.h>

static std::atomic<uint32_t> g_packet_counter(0);
static uint32_t g_packet_boot_salt = 0;

uint32_t kl_packet_next_id() {
  if (g_packet_boot_salt == 0) {
    uint32_t salt = 0;
    kl_random_bytes((uint8_t *)&salt, sizeof(salt));
    g_packet_boot_salt = salt | 1u;
  }
  uint32_t n = g_packet_counter.fetch_add(1, std::memory_order_relaxed);
  /* Xor with a per-boot salt keeps ids unique across reboots without RTC. */
  uint32_t id = n * 2654435761u ^ g_packet_boot_salt;
  return id ? id : 1u;
}

void kl_packet_clear(kl_packet_t *pkt) {
  if (!pkt) return;
  memset(pkt, 0, sizeof(*pkt));
  pkt->magic = KL_PACKET_MAGIC;
  pkt->version = KL_PACKET_VERSION;
}

void kl_packet_init(kl_packet_t *pkt, uint8_t type, uint32_t src_id, uint32_t dst_id,
                    uint32_t next_hop_id, uint8_t flags) {
  kl_packet_clear(pkt);
  pkt->packet_id = kl_packet_next_id();
  pkt->src_id = src_id;
  pkt->dst_id = dst_id;
  pkt->next_hop_id = next_hop_id;
  pkt->type = type;
  pkt->flags = flags;
  pkt->ttl = KL_DEFAULT_TTL;
  pkt->hop_count = 0;
  pkt->payload_len = 0;
}

bool kl_packet_set_payload(kl_packet_t *pkt, const void *data, size_t len) {
  if (!pkt || len > KL_MAX_PAYLOAD) return false;
  if (len && !data) return false;
  if (len) memcpy(pkt->payload, data, len);
  if (len < KL_MAX_PAYLOAD) memset(pkt->payload + len, 0, KL_MAX_PAYLOAD - len);
  pkt->payload_len = (uint8_t)len;
  return true;
}

size_t kl_packet_wire_size(const kl_packet_t *pkt) {
  if (!pkt) return 0;
  if (pkt->payload_len > KL_MAX_PAYLOAD) return 0;
  return KL_PACKET_HEADER_SIZE + pkt->payload_len + 2;
}

uint16_t kl_packet_compute_crc(const uint8_t *buf, size_t len_without_crc) {
  return kl_crc16(buf, len_without_crc, 0xFFFF);
}

size_t kl_packet_serialize(const kl_packet_t *pkt, uint8_t *out, size_t cap) {
  if (!pkt || !out) return 0;
  const size_t total = kl_packet_wire_size(pkt);
  if (!total || cap < total) return 0;

  out[0] = pkt->magic;
  out[1] = pkt->version;
  kl_write_le32(out + 2, pkt->packet_id);
  kl_write_le64(out + 6, pkt->msg_uuid);
  kl_write_le32(out + 14, pkt->src_id);
  kl_write_le32(out + 18, pkt->dst_id);
  kl_write_le32(out + 22, pkt->next_hop_id);
  kl_write_le32(out + 26, pkt->last_hop_id);
  out[30] = pkt->type;
  out[31] = pkt->flags;
  out[32] = pkt->ttl;
  out[33] = pkt->hop_count;
  out[34] = pkt->payload_len;
  if (pkt->payload_len) memcpy(out + KL_PACKET_HEADER_SIZE, pkt->payload, pkt->payload_len);
  const uint16_t crc = kl_packet_compute_crc(out, KL_PACKET_HEADER_SIZE + pkt->payload_len);
  kl_write_le16(out + KL_PACKET_HEADER_SIZE + pkt->payload_len, crc);
  return total;
}

bool kl_packet_parse_header(const uint8_t *buf, size_t len, kl_packet_header_t *out) {
  if (!buf || !out || len < KL_PACKET_HEADER_SIZE + 2) return false;
  if (buf[0] != KL_PACKET_MAGIC || buf[1] != KL_PACKET_VERSION) return false;
  const uint8_t payload_len = buf[34];
  if (payload_len > KL_MAX_PAYLOAD) return false;
  const size_t total = KL_PACKET_HEADER_SIZE + (size_t)payload_len + 2;
  if (len < total) return false;
  const uint16_t expected = (uint16_t)buf[total - 2] | ((uint16_t)buf[total - 1] << 8);
  if (kl_packet_compute_crc(buf, KL_PACKET_HEADER_SIZE + payload_len) != expected) return false;

  out->magic = buf[0];
  out->version = buf[1];
  out->packet_id = kl_read_le32(buf + 2);
  out->msg_uuid = kl_read_le64(buf + 6);
  out->src_id = kl_read_le32(buf + 14);
  out->dst_id = kl_read_le32(buf + 18);
  out->next_hop_id = kl_read_le32(buf + 22);
  out->last_hop_id = kl_read_le32(buf + 26);
  out->type = buf[30];
  out->flags = buf[31];
  out->ttl = buf[32];
  out->hop_count = buf[33];
  out->payload_len = payload_len;
  return true;
}

bool kl_packet_parse(const uint8_t *buf, size_t len, kl_packet_t *out) {
  kl_packet_header_t h;
  if (!out || !kl_packet_parse_header(buf, len, &h)) return false;
  kl_packet_clear(out);
  out->packet_id = h.packet_id;
  out->msg_uuid = h.msg_uuid;
  out->src_id = h.src_id;
  out->dst_id = h.dst_id;
  out->next_hop_id = h.next_hop_id;
  out->last_hop_id = h.last_hop_id;
  out->type = h.type;
  out->flags = h.flags;
  out->ttl = h.ttl;
  out->hop_count = h.hop_count;
  out->payload_len = h.payload_len;
  if (h.payload_len) {
    memcpy(out->payload, buf + KL_PACKET_HEADER_SIZE, h.payload_len);
  }
  const uint16_t crc = (uint16_t)buf[KL_PACKET_HEADER_SIZE + h.payload_len] |
                       ((uint16_t)buf[KL_PACKET_HEADER_SIZE + h.payload_len + 1] << 8);
  out->crc16 = crc;
  return true;
}

bool kl_packet_is_broadcast(const kl_packet_t *pkt) {
  return pkt && (pkt->dst_id == KL_BROADCAST_ID || pkt->dst_id == KL_ANY_GATEWAY_ID);
}

bool kl_packet_is_for(const kl_packet_t *pkt, uint32_t self_id, bool self_is_gateway) {
  if (!pkt) return false;
  if (pkt->dst_id == self_id) return true;
  if (pkt->dst_id == KL_BROADCAST_ID) return true;
  if (pkt->dst_id == KL_ANY_GATEWAY_ID && self_is_gateway) return true;
  return false;
}

const char *kl_packet_type_name(uint8_t type) {
  switch (type) {
    case KL_TYPE_DATA: return "DATA";
    case KL_TYPE_ACK: return "ACK";
    case KL_TYPE_RREQ: return "RREQ";
    case KL_TYPE_RREP: return "RREP";
    case KL_TYPE_GW_BEACON: return "GW_BEACON";
    case KL_TYPE_NODE_PRESENCE: return "NODE_PRESENCE";
    case KL_TYPE_SYNC_ARCHIVE: return "SYNC_ARCHIVE";
    default: return "?";
  }
}
