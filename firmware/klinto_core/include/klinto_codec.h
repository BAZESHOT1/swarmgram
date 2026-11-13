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
  KL_RPC_PRESENCE = 0x07,
  KL_RPC_SEARCH_REQ = 0x08,
  KL_RPC_SEARCH_RESP = 0x09,
  KL_RPC_FEED_SYNC_REQ = 0x0A,
  KL_RPC_FEED_SYNC_RESP = 0x0B,
  KL_RPC_CHAT_HISTORY_REQ = 0x0C,
  KL_RPC_CHAT_HISTORY_RESP = 0x0D
};

enum kl_search_type_t : uint8_t {
  KL_SEARCH_ALL = 0,
  KL_SEARCH_USERS = 1,
  KL_SEARCH_GROUPS = 2,
  KL_SEARCH_CHANNELS = 3
};

#define KL_SEARCH_MAX_RESULTS 5
#define KL_FEED_MAX_ENTRIES 5
#define KL_HISTORY_MAX_MESSAGES 8

enum kl_rpc_flags_t : uint8_t {
  KL_RPC_FLAG_COMPRESSED = 0x01,
  KL_RPC_FLAG_GROUP = 0x02,
  KL_RPC_FLAG_IS_GROUP_OR_CHANNEL = 0x02,
  KL_RPC_FLAG_REPLY = 0x04,
  KL_RPC_FLAG_TYPING = 0x08,
  KL_RPC_FLAG_MORE = 0x40
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

/* --------------------------------------------------- поиск/лента/история -- */

struct kl_search_request_t {
  uint16_t req_id;
  uint8_t search_type;
  char query[40];
};

struct kl_search_result_t {
  uint32_t entity_id;
  uint8_t entity_type;
  char name[40];
};

struct kl_feed_entry_t {
  uint16_t chat_ref;
  uint16_t unread_count;
  uint64_t last_msg_uuid;
  uint32_t timestamp;
  char preview[48];
};

struct kl_chat_message_t {
  uint64_t msg_uuid;
  uint32_t sender_id;
  uint32_t timestamp;
  char text[72];
};

size_t kl_codec_encode_search_req(uint8_t *out, size_t cap, uint16_t chat_ref,
                                  const kl_search_request_t *req);
bool kl_codec_decode_search_req(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                                kl_search_request_t *out);
size_t kl_codec_encode_search_resp(uint8_t *out, size_t cap, uint16_t chat_ref, uint16_t req_id,
                                   const kl_search_result_t *items, uint8_t count, bool more);
bool kl_codec_decode_search_resp(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                                 uint16_t *req_id, kl_search_result_t *items, uint8_t max_items,
                                 uint8_t *count, bool *more);

size_t kl_codec_encode_feed_req(uint8_t *out, size_t cap, uint16_t chat_ref,
                                uint32_t last_sync_ts);
bool kl_codec_decode_feed_req(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                              uint32_t *last_sync_ts);
size_t kl_codec_encode_feed_resp(uint8_t *out, size_t cap, uint16_t chat_ref,
                                 const kl_feed_entry_t *items, uint8_t count, bool more);
bool kl_codec_decode_feed_resp(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                               kl_feed_entry_t *items, uint8_t max_items, uint8_t *count,
                               bool *more);

size_t kl_codec_encode_history_req(uint8_t *out, size_t cap, uint16_t chat_ref,
                                   uint64_t before_uuid, uint8_t limit);
bool kl_codec_decode_history_req(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                                 uint64_t *before_uuid, uint8_t *limit);
size_t kl_codec_encode_history_resp(uint8_t *out, size_t cap, uint16_t chat_ref,
                                    const kl_chat_message_t *items, uint8_t count, bool more);
bool kl_codec_decode_history_resp(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                                  kl_chat_message_t *items, uint8_t max_items, uint8_t *count,
                                  bool *more);

/** QoS: сервисные RPC (поиск/лента/история) всегда LOW. */
uint8_t kl_rpc_priority_hint(const uint8_t *payload, size_t len);

/** Read the 4-byte RPC prefix. */
bool kl_codec_peek(const uint8_t *payload, size_t len, uint8_t *op, uint8_t *rpc_flags,
                   uint16_t *chat_ref);

const char *kl_delivery_status_name(uint8_t status);

#endif  // KLINTO_CODEC_H
