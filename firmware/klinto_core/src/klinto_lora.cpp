#include "klinto_lora.h"
#include "klinto_channel_plan.h"

#include <string.h>

#if defined(ESP32) && KL_HAS_LORA

#include <Arduino.h>
#include <RadioLib.h>
#include <esp_random.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

LoraInterface::LoraInterface()
    : cb_(nullptr),
      cb_ctx_(nullptr),
      count_(0),
      seq_(0),
      inited_(false),
      transmitting_(false),
      self_id_(0),
      self_gateway_(false),
      last_quality_(0),
      cad_busy_(0),
      cad_total_(0),
      airtime_window_ms_(0),
      airtime_used_ms_(0),
      channel_pending_(false),
      pending_channel_(1),
      module_(nullptr),
      sx1262_(nullptr),
      sx1278_(nullptr),
      phys_(nullptr) {
  memset(&cfg_, 0, sizeof(cfg_));
  memset(queue_, 0, sizeof(queue_));
}

void LoraInterface::setReceiveCallback(kl_rx_callback_t cb, void *ctx) {
  cb_ = cb;
  cb_ctx_ = ctx;
}

bool LoraInterface::init(const kl_config_t &cfg) {
  if (!cfg.lora.present) return false;
  cfg_ = cfg;
  self_id_ = cfg.node_id;
  self_gateway_ = cfg.role == KL_ROLE_GATEWAY;

  const uint8_t cs = (uint8_t)cfg.lora.cs;
  const uint8_t rst = cfg.lora.rst < 0 ? (uint8_t)RADIOLIB_NC : (uint8_t)cfg.lora.rst;
  const uint8_t irq = (uint8_t)(cfg.lora.dio1 >= 0 ? cfg.lora.dio1 : cfg.lora.dio0);
  const uint8_t busy = cfg.lora.busy < 0 ? (uint8_t)RADIOLIB_NC : (uint8_t)cfg.lora.busy;

  int16_t state = RADIOLIB_ERR_UNKNOWN;
  if (cfg.lora.chip == KL_LORA_SX1262) {
    module_ = new Module(cs, irq, rst, busy);
    sx1262_ = new SX1262(module_);
    phys_ = sx1262_;
    state = sx1262_->begin(cfg.lora.freq_mhz, cfg.lora.bw_khz, cfg.lora.sf, cfg.lora.cr,
                          cfg.lora.sync_word, cfg.lora.power_dbm, cfg.lora.preamble);
  } else {
    module_ = new Module(cs, irq, rst, (uint8_t)RADIOLIB_NC);
    sx1278_ = new SX1278(module_);
    phys_ = sx1278_;
    state = sx1278_->begin(cfg.lora.freq_mhz, cfg.lora.bw_khz, cfg.lora.sf, cfg.lora.cr,
                          cfg.lora.sync_word, cfg.lora.power_dbm, cfg.lora.preamble);
  }
  if (state != RADIOLIB_ERR_NONE || !phys_) {
    inited_ = false;
    return false;
  }
  phys_->startReceive();
  inited_ = true;
  xTaskCreatePinnedToCore(&LoraInterface::taskEntry, "kl_lora", 6144, this, 4, nullptr, 0);
  return true;
}

bool LoraInterface::setChannel(uint8_t wifi_channel) {
  if (wifi_channel < 1 || wifi_channel > KL_CHANNEL_COUNT) return false;
  pending_channel_ = wifi_channel;
  channel_pending_ = true;
  return true;
}

bool LoraInterface::applyRadioConfig() {
  if (!inited_) return false;
  int16_t state = RADIOLIB_ERR_NONE;
  if (sx1262_) {
    state |= sx1262_->setFrequency(cfg_.lora.freq_mhz);
    state |= sx1262_->setBandwidth(cfg_.lora.bw_khz);
    state |= sx1262_->setSpreadingFactor(cfg_.lora.sf);
    state |= sx1262_->setCodingRate(cfg_.lora.cr);
    state |= sx1262_->setSyncWord(cfg_.lora.sync_word);
  } else if (sx1278_) {
    state |= sx1278_->setFrequency(cfg_.lora.freq_mhz);
    state |= sx1278_->setBandwidth(cfg_.lora.bw_khz);
    state |= sx1278_->setSpreadingFactor(cfg_.lora.sf);
    state |= sx1278_->setCodingRate(cfg_.lora.cr);
    state |= sx1278_->setSyncWord(cfg_.lora.sync_word);
  }
  if (phys_) phys_->startReceive();
  return state == RADIOLIB_ERR_NONE;
}

void LoraInterface::applyPendingChannel() {
  if (!channel_pending_) return;
  channel_pending_ = false;
  const uint8_t channel = pending_channel_;
  const uint8_t band = kl_channel_plan_band_for_freq(cfg_.lora.freq_mhz);
  const kl_channel_plan_entry_t *entry = kl_channel_plan_entry(channel, band);
  if (!entry) return;
  cfg_.wifi_channel = channel;
  cfg_.lora.freq_mhz = (float)entry->lora_freq_hz / 1000000.0f;
  cfg_.lora.sync_word = entry->lora_sync_word;
  cfg_.lora.bw_khz = (float)entry->lora_bw_khz;
  cfg_.lora.sf = entry->lora_sf;
  applyRadioConfig();
}

void LoraInterface::shutdown() {
  inited_ = false;
  vTaskDelay(pdMS_TO_TICKS(30));
  if (phys_) phys_->standby();
}

bool LoraInterface::sendPacket(const uint8_t *data, size_t len, uint32_t next_hop_id,
                               uint8_t priority) {
  if (!inited_ || !data || len == 0 || len > KL_MAX_PACKET_SIZE) return false;
  KlintoGuard guard(queue_lock_);
  /* OTA-чанки идут только в полностью свободный эфир. */
  if (priority == KL_PRIO_OTA_IDLE && count_ > 0) return false;
  if (count_ >= 12) {
    if (priority == KL_PRIO_LOW) return false;
    /* Preempt the oldest LOW entry. */
    int victim = -1;
    for (int i = 0; i < 12; ++i) {
      if (queue_[i].len && queue_[i].priority == KL_PRIO_LOW) {
        victim = i;
        break;
      }
    }
    if (victim < 0) return false;
    memmove(&queue_[victim], &queue_[victim + 1], sizeof(TxItem) * (11 - victim));
    count_--;
  }
  if (priority == KL_PRIO_LOW && count_ * 100 >= 12 * cfg_.lora_low_watermark) {    return false; /* low-priority drop before the queue saturates */
  }
  TxItem &item = queue_[count_];
  item.priority = priority;
  item.len = (uint16_t)len;
  item.next_hop = next_hop_id;
  item.seq = seq_++;
  memcpy(item.data, data, len);
  count_++;
  return true;
}

void LoraInterface::pushRx(const uint8_t *data, size_t len, int16_t rssi) {
  if (len < KL_PACKET_HEADER_SIZE + 2) return;
  if (data[0] != KL_PACKET_MAGIC || data[1] != KL_PACKET_VERSION) return;
  const uint8_t payload_len = data[34];
  if (len < (size_t)KL_PACKET_HEADER_SIZE + payload_len + 2) return;
  const uint32_t next_hop = kl_read_le32(data + 22);
  if (next_hop != KL_BROADCAST_ID && next_hop != self_id_ &&
      !(self_gateway_ && next_hop == KL_ANY_GATEWAY_ID)) {
    return;
  }
  rx_.push(data, len, rssi, KL_IFACE_LORA);
}

bool LoraInterface::cadClear() {
  int16_t result = RADIOLIB_CHANNEL_FREE;
  ++cad_total_;
  if (cfg_.lora.chip == KL_LORA_SX1262 && sx1262_) {
    result = sx1262_->scanChannel();
  } else if (sx1278_) {
    result = sx1278_->scanChannel();
  }
  return result == RADIOLIB_CHANNEL_FREE;
}

bool LoraInterface::trySendNow(const TxItem &item, uint32_t air_ms) {
  /* Duty-cycle accounting over a one-minute sliding window. */
  const uint32_t now = millis();
  if (now - airtime_window_ms_ >= 60000) {
    airtime_window_ms_ = now;
    airtime_used_ms_ = 0;
  }
  if (airtime_used_ms_ + air_ms > cfg_.lora.max_airtime_ms_per_min) return false;

  /* CSMA/CA: a handful of CAD probes with exponential jitter. */
  for (int attempt = 0; attempt < 4; ++attempt) {
    if (cadClear()) {
      if (!phys_) return false;
      transmitting_ = true;
      const int16_t state = phys_->transmit(const_cast<uint8_t *>(item.data), item.len);
      transmitting_ = false;
      if (state == RADIOLIB_ERR_NONE) {
        airtime_used_ms_ += air_ms;
        return true;
      }
      return false;
    }
    ++cad_busy_;
    uint32_t jitter = 20 + (uint32_t)(esp_random() % (40u << attempt));
    if (jitter > 180) jitter = 180;
    vTaskDelay(pdMS_TO_TICKS(jitter));
  }
  return false;
}

void LoraInterface::taskLoop() {
  for (;;) {
    applyPendingChannel();
    if (!inited_) {
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }

    /* Drain a bounded number of received packets. */
    if (phys_ && phys_->available()) {
      uint8_t buf[KL_MAX_PACKET_SIZE];
      size_t len = sizeof(buf);
      const int16_t state = phys_->readData(buf, len);
      if (state == RADIOLIB_ERR_NONE && len > 0) {
        const int16_t rssi = (int16_t)phys_->getRSSI();
        last_quality_ = (int8_t)kl_rssi_to_quality(rssi);
        pushRx(buf, len, rssi);
      }
      phys_->startReceive();
    }

    TxItem item;
    bool have = false;
    {
      KlintoGuard guard(queue_lock_);
      if (count_ == 0) {
        vTaskDelay(pdMS_TO_TICKS(5));
        continue;
      }
      int best = -1;
      for (int i = 0; i < 12; ++i) {
        if (!queue_[i].len) continue;
        if (best < 0 || queue_[i].priority < queue_[best].priority ||
            (queue_[i].priority == queue_[best].priority && queue_[i].seq < queue_[best].seq)) {
          best = i;
        }
      }
      if (best < 0) {
        count_ = 0;
        continue;
      }
      item = queue_[best];
      have = true;
    }
    if (!have) continue;

    const uint32_t air_ms = phys_ ? (uint32_t)phys_->getTimeOnAir(item.len) : 1000;
    const bool low = item.priority == KL_PRIO_LOW;
    if (trySendNow(item, air_ms) || low) {
      /* Remove by seq: sendPacket may have appended/preempted concurrently. */
      remove_item(item.seq);
    }
    if (phys_) phys_->startReceive();
    vTaskDelay(pdMS_TO_TICKS(2));
  }
}

void LoraInterface::remove_item(uint32_t seq) {
  KlintoGuard guard(queue_lock_);
  for (int i = 0; i < 12; ++i) {
    if (queue_[i].len && queue_[i].seq == seq) {
      memmove(&queue_[i], &queue_[i + 1], sizeof(TxItem) * (size_t)(11 - i));
      memset(&queue_[11], 0, sizeof(TxItem));
      if (count_ > 0) count_--;
      return;
    }
  }
}

void LoraInterface::taskEntry(void *arg) {
  static_cast<LoraInterface *>(arg)->taskLoop();
}

void LoraInterface::poll(uint32_t now_ms) {
  (void)now_ms;
  kl_rx_frame_t frame;
  int budget = 3;
  while (budget-- > 0 && rx_.pop(&frame)) {
    if (cb_) cb_(cb_ctx_, frame.data, frame.len, frame.rssi, KL_IFACE_LORA);
  }
}

bool LoraInterface::isBusy() const { return count_ > 0 || transmitting_; }

int8_t LoraInterface::getLinkQuality() const { return last_quality_; }

#elif defined(ESP32)
/* Сборка без LoRa: RadioLib полностью исключён из линковки. */
LoraInterface::LoraInterface() : cb_(nullptr), cb_ctx_(nullptr), count_(0), seq_(0), inited_(false),
                                 transmitting_(false), self_id_(0), self_gateway_(false),
                                 last_quality_(0), cad_busy_(0), cad_total_(0),
                                 airtime_window_ms_(0), airtime_used_ms_(0),
                                 channel_pending_(false), pending_channel_(1), module_(nullptr),
                                 sx1262_(nullptr), sx1278_(nullptr), phys_(nullptr) {
  memset(&cfg_, 0, sizeof(cfg_));
}
bool LoraInterface::init(const kl_config_t &) { return false; }
void LoraInterface::shutdown() {}
bool LoraInterface::sendPacket(const uint8_t *, size_t, uint32_t, uint8_t) { return false; }
void LoraInterface::poll(uint32_t) {}
bool LoraInterface::isBusy() const { return false; }
int8_t LoraInterface::getLinkQuality() const { return 0; }
void LoraInterface::setReceiveCallback(kl_rx_callback_t cb, void *ctx) { cb_ = cb; cb_ctx_ = ctx; }
bool LoraInterface::setChannel(uint8_t) { return false; }
void LoraInterface::taskEntry(void *) {}
void LoraInterface::taskLoop() {}
bool LoraInterface::trySendNow(const TxItem &, uint32_t) { return false; }
void LoraInterface::remove_item(uint32_t) {}
bool LoraInterface::cadClear() { return false; }
bool LoraInterface::applyRadioConfig() { return false; }
void LoraInterface::applyPendingChannel() {}
void LoraInterface::pushRx(const uint8_t *, size_t, int16_t) {}
#endif  // ESP32

