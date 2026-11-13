/**
 * Klinto KMesh_v1 — единый формат пакета для ESP-NOW, LoRa и шлюза.
 *
 * Пакет не пересобирается при смене среды: меняются только ttl,
 * hop_count и next_hop_id, после чего пересчитывается CRC.
 */
#ifndef KLINTO_PACKET_H
#define KLINTO_PACKET_H

#include "klinto_config.h"
#include "klinto_util.h"

enum kl_packet_type_t : uint8_t {
  KL_TYPE_DATA = 1,
  KL_TYPE_ACK = 2,
  KL_TYPE_RREQ = 3,
  KL_TYPE_RREP = 4,
  KL_TYPE_GW_BEACON = 5,
  KL_TYPE_NODE_PRESENCE = 6,
  KL_TYPE_SYNC_ARCHIVE = 7
};

enum kl_packet_flags_t : uint8_t {
  KL_FLAG_NEED_ACK = 0x01,
  KL_FLAG_TO_INTERNET = 0x02,
  KL_FLAG_FROM_INTERNET = 0x04,
  KL_FLAG_TEMP_MESH_KEY = 0x08,
  KL_FLAG_PERM_USER_KEY = 0x10,
  KL_FLAG_NEED_CLOUD_ARCHIVE = 0x20,
  KL_FLAG_COMPRESSED_UNISHOX = 0x40,
  /* 0 = CLIENT_RESIGN (client re-signs on sync), 1 = SERVER_RESIGN. */
  KL_FLAG_SERVER_RESIGN = 0x80
};

#define KL_PACKET_MAGIC 0xA7
#define KL_PACKET_VERSION 3
#define KL_PACKET_HEADER_SIZE 35

struct kl_packet_header_t {
  uint8_t magic;
  uint8_t version;
  uint32_t packet_id;
  uint64_t msg_uuid;
  uint32_t src_id;
  uint32_t dst_id;
  uint32_t next_hop_id;
  uint32_t last_hop_id;
  uint8_t type;
  uint8_t flags;
  uint8_t ttl;
  uint8_t hop_count;
  uint8_t payload_len;
} KL_PACKED;

struct kl_packet_t {
  uint8_t magic;
  uint8_t version;
  uint32_t packet_id;
  uint64_t msg_uuid;
  uint32_t src_id;
  uint32_t dst_id;
  uint32_t next_hop_id;
  uint32_t last_hop_id;
  uint8_t type;
  uint8_t flags;
  uint8_t ttl;
  uint8_t hop_count;
  uint8_t payload_len;
  uint8_t payload[KL_MAX_PAYLOAD];
  uint16_t crc16;
} KL_PACKED;

static_assert(sizeof(kl_packet_header_t) == KL_PACKET_HEADER_SIZE,
              "MeshPacket header must be 35 bytes on the wire");
static_assert(sizeof(kl_packet_t) == 35 + KL_MAX_PAYLOAD + 2,
              "MeshPacket must stay packed");

/** Monotonic, boot-unique packet id. */
uint32_t kl_packet_next_id();

void kl_packet_init(kl_packet_t *pkt, uint8_t type, uint32_t src_id, uint32_t dst_id,
                    uint32_t next_hop_id, uint8_t flags);
void kl_packet_clear(kl_packet_t *pkt);
bool kl_packet_set_payload(kl_packet_t *pkt, const void *data, size_t len);
size_t kl_packet_wire_size(const kl_packet_t *pkt);
/** Serialize and append the CRC. Returns bytes written, 0 on overflow. */
size_t kl_packet_serialize(const kl_packet_t *pkt, uint8_t *out, size_t cap);
/** Full validation (magic, version, bounds, CRC). */
bool kl_packet_parse(const uint8_t *buf, size_t len, kl_packet_t *out);
/** Cheap validation used by radio RX callbacks before copying a frame. */
bool kl_packet_parse_header(const uint8_t *buf, size_t len, kl_packet_header_t *out);
uint16_t kl_packet_compute_crc(const uint8_t *buf, size_t len_without_crc);

/** True when the packet is addressed to `self_id` (unicast, broadcast or any gateway). */
bool kl_packet_is_for(const kl_packet_t *pkt, uint32_t self_id, bool self_is_gateway);
bool kl_packet_is_broadcast(const kl_packet_t *pkt);
const char *kl_packet_type_name(uint8_t type);

#endif  // KLINTO_PACKET_H
