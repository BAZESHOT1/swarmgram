/**
 * Klinto KMesh_v1 — PayloadCodec.
 *
 * RPC-команды бинарные (без JSON) и сжимаются Unishox2 до шифрования.
 * Сжатие выполняет прошивка, поэтому приложение остаётся тонким
 * BLE-клиентом и не тащит собственную версию компрессора.
 */
#ifndef KLINTO_CODEC_H
#define KLINTO_CODEC_H

#include "klinto_config.h"

#define KL_RPC_HEADER_SIZE 4
#define KL_CODEC_NO_CHAT 0xFFFFu

enum kl_rpc_op_t : uint8_t {
  KL_RPC_SEND_TEXT = 0x01,
  KL_RPC_MSG_ACK = 0x02,
  KL_RPC_MSG_READ = 0x03,
  KL_RPC_LOCATION_PING = 0x04,
  KL_RPC_SYNC_REQUEST = 0x05,
  KL_RPC_SYNC_MESSAGE = 0x06,
  KL_RPC_PRESENCE = 0x07
};

enum kl_rpc_flags_t : uint8_t {
  KL_RPC_FLAG_COMPRESSED = 0x01,
  KL_RPC_FLAG_GROUP = 0x02,
  KL_RPC_FLAG_REPLY = 0x04,
  KL_RPC_FLAG_TYPING = 0x08
};

/** Delivery states surfaced to the app (matches the TS client). */
enum kl_delivery_status_t : uint8_t {
  KL_STATUS_QUEUED = 0,
  KL_STATUS_SENT_TO_MESH = 1,
  KL_STATUS_DELIVERED_TO_PEER = 2,
  KL_STATUS_ACKED_BY_GATEWAY = 3,
  KL_STATUS_SYNCED_PERMANENT = 4,
  KL_STATUS_FAILED = 5,
  KL_STATUS_RECEIVED = 6,
  KL_STATUS_READ = 7
};

struct kl_rpc_location_t {
  int32_t lat_e7;
  int32_t lon_e7;
  uint16_t accuracy_m;
  uint8_t battery;
};

struct kl_rpc_sync_request_t {
  uint32_t since_server_seq;
  uint16_t chat_ref;
  uint8_t limit;
};

struct kl_rpc_text_t {
  uint16_t chat_ref;
  uint8_t rpc_flags;
  const uint8_t *text;
  uint16_t text_len;
};

/**
 * Кодирует RPC_SEND_TEXT. Сначала пробует Unishox2, затем откатывается
 * к сырому UTF-8, если сжатие не экономит хотя бы один байт.
 * @return bytes written, 0 on error.
 */
size_t kl_codec_encode_text(uint8_t *out, size_t cap, uint16_t chat_ref, const char *text,
                            size_t text_len, uint8_t rpc_flags);
/** Decode RPC_SEND_TEXT into a NUL-terminated UTF-8 buffer. */
bool kl_codec_decode_text(const uint8_t *payload, size_t len, kl_rpc_text_t *out, char *text_out,
                          size_t text_cap);

size_t kl_codec_encode_ack(uint8_t *out, size_t cap, uint16_t chat_ref, uint32_t acked_packet_id,
                           uint8_t status);
size_t kl_codec_encode_read(uint8_t *out, size_t cap, uint16_t chat_ref);
size_t kl_codec_encode_location(uint8_t *out, size_t cap, uint16_t chat_ref,
                                const kl_rpc_location_t *loc);
size_t kl_codec_encode_sync_request(uint8_t *out, size_t cap, const kl_rpc_sync_request_t *req);
size_t kl_codec_encode_presence(uint8_t *out, size_t cap, uint8_t battery, int8_t rssi,
                                uint8_t role, uint8_t capabilities);

/** Read the 4-byte RPC prefix. */
bool kl_codec_peek(const uint8_t *payload, size_t len, uint8_t *op, uint8_t *rpc_flags,
                   uint16_t *chat_ref);

const char *kl_delivery_status_name(uint8_t status);

#endif  // KLINTO_CODEC_H
