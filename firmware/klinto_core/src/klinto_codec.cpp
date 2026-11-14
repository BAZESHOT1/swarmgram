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
  return kl_codec_encode_presence_ex(out, cap, battery, rssi, role, capabilities, nullptr);
}

size_t kl_codec_encode_presence_ex(uint8_t *out, size_t cap, uint8_t battery, int8_t rssi,
                                   uint8_t role, uint8_t capabilities,
                                   const kl_presence_telemetry_t *telemetry) {
  size_t head = put_prefix(out, cap, KL_RPC_PRESENCE, 0, KL_CODEC_NO_CHAT);
  if (!head || cap < head + 4) return 0;
  out[head] = battery;
  out[head + 1] = (uint8_t)rssi;
  out[head + 2] = role;
  out[head + 3] = capabilities;
  if (!telemetry) return head + 4;
  if (cap < head + 11) return 0;
  kl_write_le16(out + head + 4, telemetry->fw_build);
  out[head + 6] = telemetry->chip_arch;
  out[head + 7] = telemetry->node_role;
  out[head + 8] = telemetry->radio_caps;
  out[head + 9] = telemetry->ota_state;
  out[head + 10] = telemetry->battery_pct;
  return head + 11;
}

bool kl_codec_decode_presence_telemetry(const uint8_t *payload, size_t len,
                                        kl_presence_telemetry_t *out) {
  if (!payload || !out || len < KL_RPC_HEADER_SIZE + 11) return false;
  if (payload[0] != KL_RPC_PRESENCE) return false;
  out->fw_build = (uint16_t)(payload[8] | ((uint16_t)payload[9] << 8));
  out->chip_arch = payload[10];
  out->node_role = payload[11];
  out->radio_caps = payload[12];
  out->ota_state = payload[13];
  out->battery_pct = payload[14];
  return true;
}

bool kl_codec_peek(const uint8_t *payload, size_t len, uint8_t *op, uint8_t *rpc_flags,
                   uint16_t *chat_ref) {
  if (!payload || len < KL_RPC_HEADER_SIZE) return false;
  if (op) *op = payload[0];
  if (rpc_flags) *rpc_flags = payload[1];
  if (chat_ref) *chat_ref = (uint16_t)(payload[2] | ((uint16_t)payload[3] << 8));
  return true;
}

/* Текст с однобайтовым префиксом: bit7 = Unishox2, младшие 7 бит = длина. */
static size_t put_text(uint8_t *out, size_t cap, const char *text, size_t len) {
  if (!out || !text || cap < 1) return 0;
  if (len > 127) len = 127;
  char packed[160];
  int n = unishox2_compress(text, (int)len, packed, (int)sizeof(packed), USX_PSET_DFLT);
  if (n > 0 && (size_t)n < len && (size_t)n + 1 <= cap) {
    out[0] = (uint8_t)(0x80 | (uint8_t)n);
    memcpy(out + 1, packed, (size_t)n);
    return (size_t)n + 1;
  }
  if (len + 1 > cap) return 0;
  out[0] = (uint8_t)len;
  memcpy(out + 1, text, len);
  return len + 1;
}

static bool get_text(const uint8_t *in, size_t len, size_t *used, char *out, size_t cap) {
  if (!in || !out || len < 1 || cap < 1) return false;
  const uint8_t head = in[0];
  const size_t n = head & 0x7F;
  if (len < 1 + n) return false;
  if (used) *used = 1 + n;
  if (head & 0x80) {
    int d = unishox2_decompress((const char *)in + 1, (int)n, out, (int)cap - 1, USX_PSET_DFLT);
    if (d < 0) return false;
    out[d] = '\0';
    return true;
  }
  if (n >= cap) return false;
  memcpy(out, in + 1, n);
  out[n] = '\0';
  return true;
}

size_t kl_codec_encode_search_req(uint8_t *out, size_t cap, uint16_t chat_ref,
                                  const kl_search_request_t *req) {
  if (!req) return 0;
  const size_t head = put_prefix(out, cap, KL_RPC_SEARCH_REQ, 0, chat_ref);
  if (!head || cap < head + 3) return 0;
  kl_write_le16(out + head, req->req_id);
  out[head + 2] = req->search_type;
  const size_t n = put_text(out + head + 3, cap - head - 3, req->query, strlen(req->query));
  return n ? head + 3 + n : 0;
}

bool kl_codec_decode_search_req(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                                kl_search_request_t *out) {
  uint8_t op = 0, flags = 0;
  uint16_t chat = 0;
  if (!out || !kl_codec_peek(payload, len, &op, &flags, &chat)) return false;
  if (op != KL_RPC_SEARCH_REQ || len < KL_RPC_HEADER_SIZE + 3) return false;
  out->req_id = (uint16_t)(payload[4] | ((uint16_t)payload[5] << 8));
  out->search_type = payload[6];
  size_t used = 0;
  if (!get_text(payload + 7, len - 7, &used, out->query, sizeof(out->query))) return false;
  if (chat_ref) *chat_ref = chat;
  return true;
}

size_t kl_codec_encode_search_resp(uint8_t *out, size_t cap, uint16_t chat_ref, uint16_t req_id,
                                   const kl_search_result_t *items, uint8_t count, bool more) {
  if (!out || (!items && count)) return 0;
  const size_t head = put_prefix(out, cap, KL_RPC_SEARCH_RESP,
                                 more ? KL_RPC_FLAG_MORE : 0, chat_ref);
  if (!head || cap < head + 3) return 0;
  kl_write_le16(out + head, req_id);
  out[head + 2] = 0;
  size_t offset = head + 3;
  uint8_t written = 0;
  for (uint8_t i = 0; i < count && i < KL_SEARCH_MAX_RESULTS; ++i) {
    if (cap - offset < 6) break;
    out[offset++] = (uint8_t)(items[i].entity_id);
    out[offset++] = (uint8_t)(items[i].entity_id >> 8);
    out[offset++] = (uint8_t)(items[i].entity_id >> 16);
    out[offset++] = (uint8_t)(items[i].entity_id >> 24);
    out[offset++] = items[i].entity_type;
    const size_t n = put_text(out + offset, cap - offset, items[i].name, strlen(items[i].name));
    if (!n) break;
    offset += n;
    written++;
  }
  out[head + 2] = written;
  return offset;
}

bool kl_codec_decode_search_resp(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                                 uint16_t *req_id, kl_search_result_t *items, uint8_t max_items,
                                 uint8_t *count, bool *more) {
  uint8_t op = 0, flags = 0;
  uint16_t chat = 0;
  if (!payload || !items || len < KL_RPC_HEADER_SIZE + 3) return false;
  if (!kl_codec_peek(payload, len, &op, &flags, &chat) || op != KL_RPC_SEARCH_RESP) return false;
  if (chat_ref) *chat_ref = chat;
  if (req_id) *req_id = (uint16_t)(payload[4] | ((uint16_t)payload[5] << 8));
  if (more) *more = (flags & KL_RPC_FLAG_MORE) != 0;
  const uint8_t total = payload[6];
  size_t offset = 7;
  uint8_t written = 0;
  for (uint8_t i = 0; i < total && written < max_items; ++i) {
    if (offset + 5 > len) break;
    kl_search_result_t &r = items[written];
    r.entity_id = (uint32_t)payload[offset] | ((uint32_t)payload[offset + 1] << 8) |
                  ((uint32_t)payload[offset + 2] << 16) | ((uint32_t)payload[offset + 3] << 24);
    r.entity_type = payload[offset + 4];
    offset += 5;
    size_t used = 0;
    if (!get_text(payload + offset, len - offset, &used, r.name, sizeof(r.name))) break;
    offset += used;
    written++;
  }
  if (count) *count = written;
  return true;
}

size_t kl_codec_encode_feed_req(uint8_t *out, size_t cap, uint16_t chat_ref,
                                uint32_t last_sync_ts) {
  const size_t head = put_prefix(out, cap, KL_RPC_FEED_SYNC_REQ, 0, chat_ref);
  if (!head || cap < head + 4) return 0;
  kl_write_le32(out + head, last_sync_ts);
  return head + 4;
}

bool kl_codec_decode_feed_req(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                              uint32_t *last_sync_ts) {
  uint8_t op = 0, flags = 0;
  uint16_t chat = 0;
  if (!kl_codec_peek(payload, len, &op, &flags, &chat) || op != KL_RPC_FEED_SYNC_REQ) return false;
  if (len < KL_RPC_HEADER_SIZE + 4) return false;
  if (last_sync_ts) *last_sync_ts = kl_read_le32(payload + 4);
  if (chat_ref) *chat_ref = chat;
  return true;
}

size_t kl_codec_encode_feed_resp(uint8_t *out, size_t cap, uint16_t chat_ref,
                                 const kl_feed_entry_t *items, uint8_t count, bool more) {
  if (!out || (!items && count)) return 0;
  const size_t head = put_prefix(out, cap, KL_RPC_FEED_SYNC_RESP,
                                 more ? KL_RPC_FLAG_MORE : 0, chat_ref);
  if (!head || cap < head + 3) return 0;
  out[head] = 0;
  out[head + 1] = 0;
  out[head + 2] = 0;
  size_t offset = head + 3;
  uint8_t written = 0;
  for (uint8_t i = 0; i < count && i < KL_FEED_MAX_ENTRIES; ++i) {
    if (offset + 17 > cap) break;
    kl_write_le16(out + offset, items[i].chat_ref);
    kl_write_le16(out + offset + 2, items[i].unread_count);
    kl_write_le64(out + offset + 4, items[i].last_msg_uuid);
    kl_write_le32(out + offset + 12, items[i].timestamp);
    const size_t n = put_text(out + offset + 16, cap - offset - 16, items[i].preview,
                              strlen(items[i].preview));
    if (!n) break;
    offset += 16 + n;
    written++;
  }
  out[head + 2] = written;
  return offset;
}

bool kl_codec_decode_feed_resp(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                               kl_feed_entry_t *items, uint8_t max_items, uint8_t *count,
                               bool *more) {
  uint8_t op = 0, flags = 0;
  uint16_t chat = 0;
  if (!payload || !items || len < KL_RPC_HEADER_SIZE + 3) return false;
  if (!kl_codec_peek(payload, len, &op, &flags, &chat) || op != KL_RPC_FEED_SYNC_RESP) return false;
  if (chat_ref) *chat_ref = chat;
  if (more) *more = (flags & KL_RPC_FLAG_MORE) != 0;
  const uint8_t total = payload[6];
  size_t offset = 7;
  uint8_t written = 0;
  for (uint8_t i = 0; i < total && written < max_items; ++i) {
    if (offset + 17 > len) break;
    kl_feed_entry_t &e = items[written];
    e.chat_ref = (uint16_t)(payload[offset] | ((uint16_t)payload[offset + 1] << 8));
    e.unread_count = (uint16_t)(payload[offset + 2] | ((uint16_t)payload[offset + 3] << 8));
    e.last_msg_uuid = kl_read_le64(payload + offset + 4);
    e.timestamp = kl_read_le32(payload + offset + 12);
    offset += 16;
    size_t used = 0;
    if (!get_text(payload + offset, len - offset, &used, e.preview, sizeof(e.preview))) break;
    offset += used;
    written++;
  }
  if (count) *count = written;
  return true;
}

size_t kl_codec_encode_history_req(uint8_t *out, size_t cap, uint16_t chat_ref,
                                   uint64_t before_uuid, uint8_t limit) {
  const size_t head = put_prefix(out, cap, KL_RPC_CHAT_HISTORY_REQ, 0, chat_ref);
  if (!head || cap < head + 9) return 0;
  kl_write_le64(out + head, before_uuid);
  out[head + 8] = limit;
  return head + 9;
}

bool kl_codec_decode_history_req(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                                 uint64_t *before_uuid, uint8_t *limit) {
  uint8_t op = 0, flags = 0;
  uint16_t chat = 0;
  if (!kl_codec_peek(payload, len, &op, &flags, &chat) || op != KL_RPC_CHAT_HISTORY_REQ) return false;
  if (len < KL_RPC_HEADER_SIZE + 9) return false;
  if (before_uuid) *before_uuid = kl_read_le64(payload + 4);
  if (limit) *limit = payload[12];
  if (chat_ref) *chat_ref = chat;
  return true;
}

size_t kl_codec_encode_history_resp(uint8_t *out, size_t cap, uint16_t chat_ref,
                                    const kl_chat_message_t *items, uint8_t count, bool more) {
  if (!out || (!items && count)) return 0;
  const size_t head = put_prefix(out, cap, KL_RPC_CHAT_HISTORY_RESP,
                                 more ? KL_RPC_FLAG_MORE : 0, chat_ref);
  if (!head || cap < head + 1) return 0;
  out[head] = 0;
  size_t offset = head + 1;
  uint8_t written = 0;
  for (uint8_t i = 0; i < count && i < KL_HISTORY_MAX_MESSAGES; ++i) {
    if (offset + 17 > cap) break;
    kl_write_le64(out + offset, items[i].msg_uuid);
    kl_write_le32(out + offset + 8, items[i].sender_id);
    kl_write_le32(out + offset + 12, items[i].timestamp);
    const size_t n = put_text(out + offset + 16, cap - offset - 16, items[i].text,
                              strlen(items[i].text));
    if (!n) break;
    offset += 16 + n;
    written++;
  }
  out[head] = written;
  return offset;
}

bool kl_codec_decode_history_resp(const uint8_t *payload, size_t len, uint16_t *chat_ref,
                                  kl_chat_message_t *items, uint8_t max_items, uint8_t *count,
                                  bool *more) {
  uint8_t op = 0, flags = 0;
  uint16_t chat = 0;
  if (!payload || !items || len < KL_RPC_HEADER_SIZE + 1) return false;
  if (!kl_codec_peek(payload, len, &op, &flags, &chat) || op != KL_RPC_CHAT_HISTORY_RESP) return false;
  if (chat_ref) *chat_ref = chat;
  if (more) *more = (flags & KL_RPC_FLAG_MORE) != 0;
  const uint8_t total = payload[4];
  size_t offset = 5;
  uint8_t written = 0;
  for (uint8_t i = 0; i < total && written < max_items; ++i) {
    if (offset + 17 > len) break;
    kl_chat_message_t &m = items[written];
    m.msg_uuid = kl_read_le64(payload + offset);
    m.sender_id = kl_read_le32(payload + offset + 8);
    m.timestamp = kl_read_le32(payload + offset + 12);
    offset += 16;
    size_t used = 0;
    if (!get_text(payload + offset, len - offset, &used, m.text, sizeof(m.text))) break;
    offset += used;
    written++;
  }
  if (count) *count = written;
  return true;
}

uint8_t kl_rpc_priority_hint(const uint8_t *payload, size_t len) {
  if (!payload || len < 1) return 1;
  const uint8_t op = payload[0];
  return (op >= KL_RPC_SEARCH_REQ && op <= KL_RPC_CHAT_HISTORY_RESP) ? 2 : 1;
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
