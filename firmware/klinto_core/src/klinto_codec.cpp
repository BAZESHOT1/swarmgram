#include "klinto_codec.h"
#include "klinto_util.h"

#include <string.h>

#ifndef UNISHOX_API_WITH_OUTPUT_LEN
#define UNISHOX_API_WITH_OUTPUT_LEN 1
#endif
extern "C" {
#include "unishox2.h"
}

static size_t put_prefix(uint8_t *out, size_t cap, uint8_t op, uint8_t flags, uint16_t chat_ref) {
  if (!out || cap < KL_RPC_HEADER_SIZE) return 0;
  out[0] = op;
  out[1] = flags;
  kl_write_le16(out + 2, chat_ref);
  return KL_RPC_HEADER_SIZE;
}

size_t kl_codec_encode_text(uint8_t *out, size_t cap, uint16_t chat_ref, const char *text,
                            size_t text_len, uint8_t rpc_flags) {
  if (!out || !text) return 0;
  if (text_len == 0 || text_len > KL_MAX_TEXT) return 0;
  size_t head = put_prefix(out, cap, KL_RPC_SEND_TEXT, rpc_flags, chat_ref);
  if (!head) return 0;
  const size_t room = cap - head;
  if (room < 2) return 0;

  /* Unishox2 работает с короткими UTF-8 строками; для несжимаемых данных
   * выход может быть больше, поэтому используем временный буфер и fallback. */
  char compressed[KL_MAX_TEXT + 32];
  int clen = unishox2_compress((const char *)text, (int)text_len, compressed,
                               (int)sizeof(compressed), USX_PSET_DFLT);
  if (clen > 0 && (size_t)clen < text_len && (size_t)clen + 1 <= room) {
    out[1] |= KL_RPC_FLAG_COMPRESSED;
    memcpy(out + head, compressed, (size_t)clen);
    return head + (size_t)clen;
  }
  if (text_len > room) return 0;
  memcpy(out + head, text, text_len);
  return head + text_len;
}

bool kl_codec_decode_text(const uint8_t *payload, size_t len, kl_rpc_text_t *out, char *text_out,
                          size_t text_cap) {
  if (!payload || !out || !text_out || len < KL_RPC_HEADER_SIZE) return false;
  uint8_t op = 0;
  uint8_t rpc_flags = 0;
  uint16_t chat_ref = 0;
  if (!kl_codec_peek(payload, len, &op, &rpc_flags, &chat_ref)) return false;
  if (op != KL_RPC_SEND_TEXT) return false;
  out->chat_ref = chat_ref;
  out->rpc_flags = rpc_flags;
  out->text = payload + KL_RPC_HEADER_SIZE;
  out->text_len = (uint16_t)(len - KL_RPC_HEADER_SIZE);
  if (!out->text_len || !text_cap) return false;

  if (rpc_flags & KL_RPC_FLAG_COMPRESSED) {
    int dlen = unishox2_decompress((const char *)out->text, out->text_len, text_out,
                                   (int)text_cap - 1, USX_PSET_DFLT);
    if (dlen < 0) return false;
    text_out[dlen] = '\0';
    return true;
  }
  size_t copy = out->text_len;
  if (copy >= text_cap) copy = text_cap - 1;
  memcpy(text_out, out->text, copy);
  text_out[copy] = '\0';
  return true;
}

size_t kl_codec_encode_ack(uint8_t *out, size_t cap, uint16_t chat_ref, uint32_t acked_packet_id,
                           uint8_t status) {
  size_t head = put_prefix(out, cap, KL_RPC_MSG_ACK, 0, chat_ref);
  if (!head || cap < head + 5) return 0;
  kl_write_le32(out + head, acked_packet_id);
  out[head + 4] = status;
  return head + 5;
}

size_t kl_codec_encode_read(uint8_t *out, size_t cap, uint16_t chat_ref) {
  return put_prefix(out, cap, KL_RPC_MSG_READ, 0, chat_ref);
}

size_t kl_codec_encode_location(uint8_t *out, size_t cap, uint16_t chat_ref,
                                const kl_rpc_location_t *loc) {
  if (!loc) return 0;
  size_t head = put_prefix(out, cap, KL_RPC_LOCATION_PING, 0, chat_ref);
  if (!head || cap < head + 11) return 0;
  kl_write_le32(out + head, (uint32_t)loc->lat_e7);
  kl_write_le32(out + head + 4, (uint32_t)loc->lon_e7);
  kl_write_le16(out + head + 8, loc->accuracy_m);
  out[head + 10] = loc->battery;
  return head + 11;
}

size_t kl_codec_encode_sync_request(uint8_t *out, size_t cap, const kl_rpc_sync_request_t *req) {
  if (!req) return 0;
  size_t head = put_prefix(out, cap, KL_RPC_SYNC_REQUEST, 0, req->chat_ref);
  if (!head || cap < head + 7) return 0;
  kl_write_le32(out + head, req->since_server_seq);
  out[head + 4] = req->limit;
  kl_write_le16(out + head + 5, req->chat_ref);
  return head + 7;
}

size_t kl_codec_encode_presence(uint8_t *out, size_t cap, uint8_t battery, int8_t rssi,
                                uint8_t role, uint8_t capabilities) {
  size_t head = put_prefix(out, cap, KL_RPC_PRESENCE, 0, KL_CODEC_NO_CHAT);
  if (!head || cap < head + 4) return 0;
  out[head] = battery;
  out[head + 1] = (uint8_t)rssi;
  out[head + 2] = role;
  out[head + 3] = capabilities;
  return head + 4;
}

bool kl_codec_peek(const uint8_t *payload, size_t len, uint8_t *op, uint8_t *rpc_flags,
                   uint16_t *chat_ref) {
  if (!payload || len < KL_RPC_HEADER_SIZE) return false;
  if (op) *op = payload[0];
  if (rpc_flags) *rpc_flags = payload[1];
  if (chat_ref) *chat_ref = (uint16_t)(payload[2] | ((uint16_t)payload[3] << 8));
  return true;
}

const char *kl_delivery_status_name(uint8_t status) {
  switch (status) {
    case KL_STATUS_QUEUED: return "QUEUED";
    case KL_STATUS_SENT_TO_MESH: return "SENT_TO_MESH";
    case KL_STATUS_DELIVERED_TO_PEER: return "DELIVERED_TO_PEER";
    case KL_STATUS_ACKED_BY_GATEWAY: return "ACKED_BY_GATEWAY";
    case KL_STATUS_SYNCED_PERMANENT: return "SYNCED_PERMANENT";
    case KL_STATUS_FAILED: return "FAILED";
    case KL_STATUS_RECEIVED: return "RECEIVED";
    case KL_STATUS_READ: return "READ";
    default: return "UNKNOWN";
  }
}
