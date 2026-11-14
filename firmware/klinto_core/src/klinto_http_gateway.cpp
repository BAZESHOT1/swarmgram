#include "klinto_http_gateway.h"

#if defined(ESP32)

#include <HTTPClient.h>
#include <WiFi.h>
#include <string.h>

#include "klinto_packet.h"
#include "klinto_util.h"

#ifndef KL_GATEWAY_POLL_MS
#define KL_GATEWAY_POLL_MS 1800u
#endif

namespace {

bool starts_with(const char *s, const char *prefix) {
  return s && prefix && strncmp(s, prefix, strlen(prefix)) == 0;
}

void trim_trailing_slashes(char *url) {
  if (!url) return;
  size_t n = strlen(url);
  while (n > 0 && url[n - 1] == '/') url[--n] = '\0';
}

/** Достаёт беззнаковое число по ключу "key": из плоского JSON-объекта. */
bool json_uint(const char *begin, const char *end, const char *key, uint32_t *out) {
  if (!begin || !end || !key || !out) return false;
  const size_t key_len = strlen(key);
  for (const char *p = begin; p + key_len + 2 < end; ++p) {
    if (*p != '"' || strncmp(p + 1, key, key_len) != 0 || p[1 + key_len] != '"') continue;
    p += key_len + 2;
    while (p < end && (*p == ' ' || *p == ':')) ++p;
    if (p >= end || *p < '0' || *p > '9') return false;
    uint32_t value = 0;
    while (p < end && *p >= '0' && *p <= '9') {
      value = value * 10u + (uint32_t)(*p - '0');
      ++p;
    }
    *out = value;
    return true;
  }
  return false;
}

}  // namespace

HttpGatewayTransport::HttpGatewayTransport()
    : tls_(false),
      enabled_(false),
      cursor_(0),
      last_poll_ms_(0),
      body_len_(0),
      parse_pos_(0) {
  base_[0] = '\0';
  key_hex_[0] = '\0';
  body_[0] = '\0';
  memset(&cfg_, 0, sizeof(cfg_));
}

void HttpGatewayTransport::init(const kl_config_t *cfg) {
  if (cfg) cfg_ = *cfg;
  tls_ = starts_with(cfg_.hub_url, "https://");
  enabled_ = starts_with(cfg_.hub_url, "http://") || tls_;
  snprintf(base_, sizeof(base_), "%s", cfg_.hub_url);
  trim_trailing_slashes(base_);
  key_hex_[0] = '\0';
  if (cfg_.has_temp_key) {
    kl_hex_encode(cfg_.temp_mesh_key, sizeof(cfg_.temp_mesh_key), key_hex_, sizeof(key_hex_),
                  false);
  }
  if (tls_) tls_client_.setInsecure();
  cursor_ = 0;
  body_len_ = 0;
  parse_pos_ = 0;
}

bool HttpGatewayTransport::connect() {
  return enabled_ && WiFi.status() == WL_CONNECTED;
}

void HttpGatewayTransport::disconnect() {
  plain_.stop();
  tls_client_.stop();
}

bool HttpGatewayTransport::connected() const {
  return enabled_ && WiFi.status() == WL_CONNECTED;
}

bool HttpGatewayTransport::post(const String &url, const char *body, size_t len) {
  if (!body || len == 0) return false;
  HTTPClient http;
  http.setTimeout(4000);
  const bool begun = tls_ ? http.begin(tls_client_, url) : http.begin(plain_, url);
  if (!begun) return false;
  http.addHeader("content-type", "application/json");
  http.addHeader("x-gateway-id", String((unsigned long)cfg_.gateway_id));
  if (key_hex_[0]) http.addHeader("x-kmesh-key", key_hex_);
  if (cfg_.module_token[0]) {
    http.addHeader("authorization", String("Bearer ") + cfg_.module_token);
  }
  const int code = http.POST((uint8_t *)body, len);
  http.end();
  const bool ok = code >= 200 && code < 300;
  if (ok) {
    Serial.printf("[TRACE 3/4] GW->HUB: uplink ok status=%d\n", code);
  } else {
    Serial.printf("[TRACE 3/4] GW->HUB: uplink failed status=%d\n", code);
  }
  return ok;
}

bool HttpGatewayTransport::publish(const char *topic, const uint8_t *data, size_t len) {
  if (!connected() || !data || len == 0 || len > 1200) return false;
  const bool presence = topic && strstr(topic, "presence") != nullptr;
  String url = String(base_) + "/v1/kmesh/v1/relay?kind=" + (presence ? "presence" : "archive");
  return post(url, (const char *)data, len);
}

bool HttpGatewayTransport::poll_downlink(uint32_t now_ms) {
  if (now_ms - last_poll_ms_ < KL_GATEWAY_POLL_MS) return false;
  last_poll_ms_ = now_ms;
  String url = String(base_) + "/v1/kmesh/v1/downlink?gateway_id=" +
               String((unsigned long)cfg_.gateway_id) + "&since=" + String((unsigned long)cursor_);
  HTTPClient http;
  http.setTimeout(4000);
  const bool begun = tls_ ? http.begin(tls_client_, url) : http.begin(plain_, url);
  if (!begun) return false;
  http.addHeader("x-gateway-id", String((unsigned long)cfg_.gateway_id));
  if (key_hex_[0]) http.addHeader("x-kmesh-key", key_hex_);
  if (cfg_.module_token[0]) {
    http.addHeader("authorization", String("Bearer ") + cfg_.module_token);
  }
  const int code = http.GET();
  if (code < 200 || code >= 300) {
    http.end();
    return false;
  }
  String payload = http.getString();
  http.end();
  const size_t n = payload.length() < sizeof(body_) - 1 ? payload.length() : sizeof(body_) - 1;
  memcpy(body_, payload.c_str(), n);
  body_[n] = '\0';
  body_len_ = n;
  parse_pos_ = 0;
  uint32_t next_cursor = cursor_;
  if (json_uint(body_, body_ + body_len_, "cursor", &next_cursor)) cursor_ = next_cursor;
  return true;
}

bool HttpGatewayTransport::build_ack(uint32_t dst_node, uint32_t packet_id, uint8_t *out,
                                     size_t cap, size_t *len) {
  if (!out || !len) return false;
  kl_packet_t pkt;
  kl_packet_init(&pkt, KL_TYPE_ACK, cfg_.gateway_id, dst_node, dst_node, 0);
  pkt.hop_count = 0;
  uint8_t payload[9];
  memset(payload, 0, sizeof(payload));
  kl_write_le32(payload + 4, packet_id);
  if (!kl_packet_set_payload(&pkt, payload, sizeof(payload))) return false;
  *len = kl_packet_serialize(&pkt, out, cap);
  return *len > 0;
}

int HttpGatewayTransport::next_downlink(uint8_t *data, size_t data_cap) {
  if (!data || body_len_ == 0) return 0;
  const char *end = body_ + body_len_;
  while (parse_pos_ < body_len_) {
    const char *obj = strchr(body_ + parse_pos_, '{');
    if (!obj || obj >= end) {
      parse_pos_ = body_len_;
      return 0;
    }
    const char *obj_end = strchr(obj, '}');
    if (!obj_end) {
      parse_pos_ = body_len_;
      return 0;
    }
    parse_pos_ = (size_t)(obj_end - body_) + 1;
    if (!strstr(obj, "\"kind\"")) continue;

    if (strstr(obj, "\"ack\"")) {
      uint32_t dst = 0;
      uint32_t packet_id = 0;
      if (!json_uint(obj, obj_end, "dst_node_id", &dst) ||
          !json_uint(obj, obj_end, "packet_id", &packet_id)) {
        continue;
      }
      size_t len = 0;
      if (build_ack(dst, packet_id, data, data_cap, &len)) return (int)len;
      continue;
    }

    /* Серверный пакет целиком: base64 от MeshPacket. */
    const char *b64 = strstr(obj, "\"packet_b64\":\"");
    if (!b64 || b64 >= obj_end) continue;
    b64 += strlen("\"packet_b64\":\"");
    const char *b64_end = strchr(b64, '"');
    if (!b64_end || b64_end > obj_end) continue;
    const size_t decoded = kl_base64_decode(b64, (size_t)(b64_end - b64), data, data_cap);
    if (decoded > 0) return (int)decoded;
  }
  return 0;
}

int HttpGatewayTransport::read(char *topic, size_t topic_cap, uint8_t *data, size_t data_cap) {
  if (!connected()) return -1;
  int n = next_downlink(data, data_cap);
  if (n > 0) {
    if (topic && topic_cap) snprintf(topic, topic_cap, "down");
    return n;
  }
  if (poll_downlink(millis())) {
    n = next_downlink(data, data_cap);
    if (n > 0) {
      if (topic && topic_cap) snprintf(topic, topic_cap, "down");
      return n;
    }
  }
  return 0;
}

void HttpGatewayTransport::loop() {
  /* Сетевые операции выполняются в publish/read, чтобы не блокировать
   * mesh-задачу: gateway_.loop() крутится в отдельной FreeRTOS-задаче. */
}

#endif  // ESP32
