#include "klinto_espnow.h"

#if defined(ESP32)

#include <Arduino.h>
#include <WiFi.h>
#include <string.h>

EspNowInterface *EspNowInterface::s_instance = nullptr;
static const uint8_t kBroadcastMac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

EspNowInterface::EspNowInterface()
    : cb_(nullptr),
      cb_ctx_(nullptr),
      tx_head_(0),
      tx_tail_(0),
      inited_(false),
      self_id_(0),
      self_gateway_(false),
      last_rssi_(-90),
      last_tx_ms_(0) {
  memset(tx_, 0, sizeof(tx_));
}

void EspNowInterface::setReceiveCallback(kl_rx_callback_t cb, void *ctx) {
  cb_ = cb;
  cb_ctx_ = ctx;
}

bool EspNowInterface::init(const kl_config_t &cfg) {
  self_id_ = cfg.node_id;
  self_gateway_ = cfg.role == KL_ROLE_GATEWAY;
  s_instance = this;
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(false, false);
  delay(50);
  esp_wifi_set_channel(cfg.wifi_channel, WIFI_SECOND_CHAN_NONE);

  if (esp_now_init() != ESP_OK) {
    inited_ = false;
    return false;
  }
  esp_now_register_recv_cb(&EspNowInterface::on_recv);
  esp_now_register_send_cb(&EspNowInterface::on_sent);

  esp_now_peer_info_t peer;
  memset(&peer, 0, sizeof(peer));
  memset(peer.peer_addr, 0xFF, 6);
  peer.channel = 0; /* current channel */
  peer.encrypt = false;
  peer.ifidx = WIFI_IF_STA;
  const esp_err_t err = esp_now_add_peer(&peer);
  if (err != ESP_OK && err != ESP_ERR_ESPNOW_EXIST) {
    esp_now_deinit();
    inited_ = false;
    return false;
  }
  inited_ = true;
  return true;
}

void EspNowInterface::shutdown() {
  if (inited_) {
    esp_now_deinit();
    inited_ = false;
  }
  s_instance = nullptr;
}

void EspNowInterface::on_recv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  EspNowInterface *self = s_instance;
  if (!self || !data || len < (int)(KL_PACKET_HEADER_SIZE + 2)) return;
  if (data[0] != KL_PACKET_MAGIC || data[1] != KL_PACKET_VERSION) return;
  const uint8_t payload_len = data[34];
  if (len < (int)(KL_PACKET_HEADER_SIZE + payload_len + 2)) return;

  const uint32_t next_hop = kl_read_le32(data + 22);
  if (next_hop != KL_BROADCAST_ID && next_hop != self->self_id_ &&
      !(self->self_gateway_ && next_hop == KL_ANY_GATEWAY_ID)) {
    return; /* not our hop: zero further work */
  }
  int16_t rssi = -90;
  if (info && info->rx_ctrl) {
    rssi = (int16_t)info->rx_ctrl->rssi;
    self->last_rssi_ = rssi;
  }
  self->rx_.push(data, (size_t)len, rssi, KL_IFACE_ESPNOW);
}

void EspNowInterface::on_sent(const wifi_tx_info_t *info, esp_now_send_status_t status) {
  (void)info;
  (void)status;
}

bool EspNowInterface::enqueue_tx(const uint8_t *data, size_t len, uint32_t next_hop) {
  if (!data || len == 0 || len > KL_MAX_PACKET_SIZE) return false;
  const uint8_t next = (uint8_t)((tx_head_ + 1) % KL_ESPNOW_TX_QUEUE);
  if (next == tx_tail_) return false; /* очередь переполнена: кадр теряется */
  TxSlot &slot = tx_[tx_head_];
  slot.len = (uint16_t)len;
  slot.next_hop = next_hop;
  slot.tries = 0;
  memcpy(slot.data, data, len);
  tx_head_ = next;
  return true;
}

bool EspNowInterface::transmit(const uint8_t *data, size_t len) {
  const esp_err_t err = esp_now_send(kBroadcastMac, data, len); /* nullptr = broadcast peer */
  if (err == ESP_OK) {
    last_tx_ms_ = millis();
    return true;
  }
  return false;
}

bool EspNowInterface::sendPacket(const uint8_t *data, size_t len, uint32_t next_hop_id,
                                 uint8_t priority) {
  (void)priority;
  if (!inited_ || !data || len == 0 || len > KL_MAX_PACKET_SIZE) return false;

  /* Жёсткий TX pacing: даже если приложение просит отправить пачку,
   * кадры уходят не чаще одного раза в 25 мс. */
  const uint32_t now = millis();
  const bool queue_empty = tx_head_ == tx_tail_;
  if (queue_empty && now - last_tx_ms_ >= KL_ESPNOW_MIN_TX_GAP_MS) {
    if (transmit(data, len)) return true;
  }
  return enqueue_tx(data, len, next_hop_id);
}

void EspNowInterface::pump_tx(uint32_t now_ms) {
  if (tx_tail_ == tx_head_) return;
  if (now_ms - last_tx_ms_ < KL_ESPNOW_MIN_TX_GAP_MS) return;

  TxSlot &slot = tx_[tx_tail_];
  if (transmit(slot.data, slot.len)) {
    tx_tail_ = (uint8_t)((tx_tail_ + 1) % KL_ESPNOW_TX_QUEUE);
    return;
  }
  slot.tries++;
  if (slot.tries >= KL_ESPNOW_MAX_RETRIES) {
    /* Три неудачи подряд — выбрасываем кадр, чтобы не зациклить эфир. */
    tx_tail_ = (uint8_t)((tx_tail_ + 1) % KL_ESPNOW_TX_QUEUE);
  }
}

void EspNowInterface::poll(uint32_t now_ms) {
  pump_tx(now_ms);
  kl_rx_frame_t frame;
  int budget = 4;
  while (budget-- > 0 && rx_.pop(&frame)) {
    if (cb_) cb_(cb_ctx_, frame.data, frame.len, frame.rssi, KL_IFACE_ESPNOW);
  }
}

bool EspNowInterface::isBusy() const { return tx_tail_ != tx_head_; }

bool EspNowInterface::setChannel(uint8_t wifi_channel) {
  if (wifi_channel < 1 || wifi_channel > 13) return false;
  return esp_wifi_set_channel(wifi_channel, WIFI_SECOND_CHAN_NONE) == ESP_OK;
}

int8_t EspNowInterface::getLinkQuality() const {
  return (int8_t)kl_rssi_to_quality(last_rssi_);
}

#endif  // ESP32
