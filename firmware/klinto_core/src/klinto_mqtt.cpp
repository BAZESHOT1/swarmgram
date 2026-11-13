#include "klinto_mqtt.h"

#if defined(ESP32)

#include <Arduino.h>
#include <WiFi.h>
#include <string.h>

MqttTlsTransport::MqttTlsTransport()
    : port_(1883),
      tls_(false),
      last_error_(""),
      connected_(false),
      packet_id_(1),
      last_ping_ms_(0),
      last_rx_ms_(0),
      rx_len_(0) {
  memset(host_, 0, sizeof(host_));
  memset(user_, 0, sizeof(user_));
  memset(pass_, 0, sizeof(pass_));
  memset(ca_, 0, sizeof(ca_));
  memset(client_id_, 0, sizeof(client_id_));
  memset(down_topic_, 0, sizeof(down_topic_));
  memset(rx_, 0, sizeof(rx_));
}

bool MqttTlsTransport::begin(const char *host, uint16_t port, bool tls, const char *user,
                             const char *pass, const char *ca_pem, const char *client_id,
                             const char *down_topic) {
  if (!host || !client_id || !down_topic) return false;
  strncpy(host_, host, sizeof(host_) - 1);
  port_ = port;
  tls_ = tls;
  if (user) strncpy(user_, user, sizeof(user_) - 1);
  if (pass) strncpy(pass_, pass, sizeof(pass_) - 1);
  if (ca_pem) strncpy(ca_, ca_pem, sizeof(ca_) - 1);
  strncpy(client_id_, client_id, sizeof(client_id_) - 1);
  strncpy(down_topic_, down_topic, sizeof(down_topic_) - 1);
  if (tls_) {
    if (ca_[0]) {
      secure_.setCACert(ca_);
    } else {
      secure_.setInsecure();
    }
  }
  return true;
}

size_t MqttTlsTransport::encodeRemaining(uint8_t *out, size_t value) {
  size_t n = 0;
  do {
    uint8_t byte = (uint8_t)(value % 128);
    value /= 128;
    if (value) byte |= 0x80;
    out[n++] = byte;
  } while (value && n < 4);
  return n;
}

bool MqttTlsTransport::decodeRemaining(const uint8_t *in, size_t len, size_t *value,
                                       size_t *used) {
  size_t result = 0;
  size_t multiplier = 1;
  size_t i = 0;
  do {
    if (i >= len || i >= 4) return false;
    const uint8_t byte = in[i++];
    result += (size_t)(byte & 0x7F) * multiplier;
    multiplier *= 128;
    if (!(byte & 0x80)) {
      *value = result;
      *used = i;
      return true;
    }
  } while (true);
}

bool MqttTlsTransport::writeAll(const uint8_t *data, size_t len) {
  Client *io = sock();
  size_t off = 0;
  while (off < len) {
    const size_t n = io->write(data + off, len - off);
    if (!n) return false;
    off += n;
  }
  return true;
}

bool MqttTlsTransport::connect() {
  if (connected_) return true;
  if (!WiFi.isConnected()) {
    last_error_ = "wifi_down";
    return false;
  }
  if (tls_) {
    secure_.setTimeout(4000);
    if (!secure_.connect(host_, port_)) {
      last_error_ = "tls_connect";
      return false;
    }
  } else {
    plain_.setTimeout(4000);
    if (!plain_.connect(host_, port_)) {
      last_error_ = "tcp_connect";
      return false;
    }
  }
  if (!sendConnect()) {
    sock()->stop();
    return false;
  }
  /* Wait for CONNACK (fixed header 0x20, 2-byte payload). */
  uint8_t header = 0;
  uint8_t payload[8];
  size_t plen = 0;
  if (!readPacket(&header, payload, sizeof(payload), &plen, 4000)) {
    last_error_ = "connack_timeout";
    sock()->stop();
    return false;
  }
  if (header != 0x20 || plen != 2 || payload[1] != 0) {
    last_error_ = "connack_rejected";
    sock()->stop();
    return false;
  }
  connected_ = true;
  last_ping_ms_ = millis();
  last_rx_ms_ = millis();
  if (!sendSubscribe()) {
    last_error_ = "subscribe_failed";
  }
  return true;
}

void MqttTlsTransport::disconnect() {
  connected_ = false;
  sock()->stop();
}

bool MqttTlsTransport::sendConnect() {
  uint8_t packet[256];
  size_t o = 0;
  packet[o++] = 0x10; /* CONNECT */
  const size_t len_pos = o;
  o++; /* remaining length placeholder (single byte for our short client ids) */
  /* variable header */
  packet[o++] = 0x00;
  packet[o++] = 0x04;
  packet[o++] = 'M';
  packet[o++] = 'Q';
  packet[o++] = 'T';
  packet[o++] = 'T';
  packet[o++] = 0x04; /* protocol level 3.1.1 */
  uint8_t flags = 0x02; /* clean session */
  const size_t user_len = strlen(user_);
  const size_t pass_len = strlen(pass_);
  if (user_len) flags |= 0x80;
  if (pass_len) flags |= 0x40;
  packet[o++] = flags;
  packet[o++] = 0x00;
  packet[o++] = 60; /* keepalive */

  const size_t cid_len = strlen(client_id_);
  packet[o++] = (uint8_t)(cid_len >> 8);
  packet[o++] = (uint8_t)cid_len;
  memcpy(packet + o, client_id_, cid_len);
  o += cid_len;
  if (user_len) {
    packet[o++] = (uint8_t)(user_len >> 8);
    packet[o++] = (uint8_t)user_len;
    memcpy(packet + o, user_, user_len);
    o += user_len;
  }
  if (pass_len) {
    packet[o++] = (uint8_t)(pass_len >> 8);
    packet[o++] = (uint8_t)pass_len;
    memcpy(packet + o, pass_, pass_len);
    o += pass_len;
  }
  const size_t remaining = o - len_pos - 1;
  if (remaining > 127) {
    last_error_ = "connect_too_long";
    return false;
  }
  packet[len_pos] = (uint8_t)remaining;
  return writeAll(packet, o);
}

bool MqttTlsTransport::sendSubscribe() {
  uint8_t packet[160];
  size_t o = 0;
  packet[o++] = 0x82; /* SUBSCRIBE */
  const size_t topic_len = strlen(down_topic_);
  const size_t remaining = 2 + 2 + topic_len + 1;
  if (remaining > 127) return false;
  packet[o++] = (uint8_t)remaining;
  packet[o++] = 0x00;
  packet[o++] = (uint8_t)(packet_id_ >> 8);
  packet[o++] = (uint8_t)(packet_id_++ & 0xFF);
  packet[o++] = (uint8_t)(topic_len >> 8);
  packet[o++] = (uint8_t)topic_len;
  memcpy(packet + o, down_topic_, topic_len);
  o += topic_len;
  packet[o++] = 0x00; /* QoS 0 */
  return writeAll(packet, o);
}

bool MqttTlsTransport::publish(const char *topic, const uint8_t *data, size_t len) {
  if (!connected_ || !topic || !data) return false;
  const size_t topic_len = strlen(topic);
  if (topic_len > 120 || len > 512) return false;
  uint8_t packet[768];
  size_t o = 0;
  packet[o++] = 0x30; /* PUBLISH QoS0 */
  uint8_t rem[4];
  const size_t rem_len = 2 + topic_len + len;
  const size_t rem_n = encodeRemaining(rem, rem_len);
  memcpy(packet + o, rem, rem_n);
  o += rem_n;
  packet[o++] = (uint8_t)(topic_len >> 8);
  packet[o++] = (uint8_t)topic_len;
  memcpy(packet + o, topic, topic_len);
  o += topic_len;
  memcpy(packet + o, data, len);
  o += len;
  if (!writeAll(packet, o)) {
    disconnect();
    return false;
  }
  last_rx_ms_ = millis();
  return true;
}

bool MqttTlsTransport::readPacket(uint8_t *header, uint8_t *payload, size_t cap,
                                  size_t *payload_len, uint32_t timeout_ms) {
  const uint32_t start = millis();
  uint8_t byte = 0;
  while (millis() - start < timeout_ms) {
    if (sock()->available() <= 0) {
      delay(2);
      continue;
    }
    if (sock()->read(&byte, 1) != 1) continue;
    *header = byte;
    uint8_t enc[4];
    size_t enc_len = 0;
    size_t remaining = 0;
    size_t used = 0;
    while (enc_len < 4) {
      while (sock()->available() <= 0) {
        if (millis() - start >= timeout_ms) return false;
        delay(1);
      }
      if (sock()->read(&enc[enc_len], 1) != 1) continue;
      ++enc_len;
      if (!(enc[enc_len - 1] & 0x80)) {
        if (!decodeRemaining(enc, enc_len, &remaining, &used)) return false;
        break;
      }
    }
    if (remaining > cap) {
      /* Drain oversized packet. */
      for (size_t i = 0; i < remaining; ++i) {
        while (sock()->available() <= 0) delay(1);
        sock()->read();
      }
      return false;
    }
    size_t got = 0;
    while (got < remaining) {
      if (sock()->available() <= 0) {
        if (millis() - start >= timeout_ms) return false;
        delay(1);
        continue;
      }
      const int n = sock()->read(payload + got, remaining - got);
      if (n <= 0) continue;
      got += (size_t)n;
    }
    *payload_len = remaining;
    return true;
  }
  return false;
}

int MqttTlsTransport::read(char *topic, size_t topic_cap, uint8_t *data, size_t data_cap) {
  if (!connected_) return -1;
  if (sock()->available() <= 0) return 0;
  uint8_t header = 0;
  size_t plen = 0;
  if (!readPacket(&header, rx_, sizeof(rx_), &plen, 500)) return 0;
  last_rx_ms_ = millis();
  if ((header & 0xF0) != 0x30) return 0; /* not PUBLISH */
  if (plen < 2) return 0;
  const size_t tlen = ((size_t)rx_[0] << 8) | rx_[1];
  if (2 + tlen > plen) return 0;
  const size_t copy_topic = tlen < topic_cap - 1 ? tlen : topic_cap - 1;
  memcpy(topic, rx_ + 2, copy_topic);
  topic[copy_topic] = '\0';
  const size_t payload_len = plen - 2 - tlen;
  if (payload_len > data_cap) return 0;
  memcpy(data, rx_ + 2 + tlen, payload_len);
  return (int)payload_len;
}

void MqttTlsTransport::loop() {
  if (!connected_) return;
  const uint32_t now = millis();
  if (now - last_ping_ms_ > 30000) {
    const uint8_t ping[2] = {0xC0, 0x00};
    if (!writeAll(ping, 2)) {
      disconnect();
      return;
    }
    last_ping_ms_ = now;
  }
  if (!sock()->connected()) disconnect();
}

#endif  // ESP32
