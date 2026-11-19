#include "klinto_lora.h"
#include "klinto_channel_plan.h"

#include <string.h>

#if defined(ESP32) && KL_HAS_LORA

#include <Arduino.h>
#include <RadioLib.h>
#include <SPI.h>
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

  /* RadioLib 8: единая конфигурация LoRa (частоты в Гц). */
  ConfigLoRa_t lc;
  lc.frequency = (uint32_t)(cfg.lora.freq_mhz * 1000000.0f);
  lc.bandwidth = (uint32_t)(cfg.lora.bw_khz * 1000.0f);
  lc.spreadingFactor = cfg.lora.sf;
  lc.codingRate = cfg.lora.cr;
  lc.syncWord = cfg.lora.sync_word;
  lc.power = cfg.lora.power_dbm;
  lc.preambleLength = cfg.lora.preamble;
  /* Пины шины из конфигурации (раньше всегда шла SPI по умолчанию). */
  SPI.begin(cfg.lora.sck, cfg.lora.miso, cfg.lora.mosi, cfg.lora.cs);
  int16_t state = RADIOLIB_ERR_UNKNOWN;
  chip_ = cfg.lora.chip;
  irq_pin_ = (int)irq;
  if (cfg.lora.chip == KL_LORA_SX1262) {
    module_ = new Module(cs, irq, rst, busy, SPI);
    SX1262 *r = new SX1262(module_);
    phys_ = r;
    radio_ = r;
    /* TCXO: RadioLib сам пробует 1.6 В и откатывается на кварц, если TCXO нет. */
    state = r->begin(lc);
    /* Большинство модулей SX1262 (E22, Heltec, RAK) переключают антенну через DIO2. */
    if (state == RADIOLIB_ERR_NONE) r->setDio2AsRfSwitch(true);
  } else if (cfg.lora.chip == KL_LORA_LR2021) {
    module_ = new Module(cs, irq, rst, busy, SPI);
    LR2021 *r = new LR2021(module_);
    phys_ = r;
    radio_ = r;
    state = r->begin(lc);
  } else if (cfg.lora.chip == KL_LORA_SX1276) {
    module_ = new Module(cs, irq, rst, (uint32_t)RADIOLIB_NC, SPI);
    SX1276 *r = new SX1276(module_);
    phys_ = r;
    radio_ = r;
    state = r->begin(lc);
  } else {
    module_ = new Module(cs, irq, rst, (uint32_t)RADIOLIB_NC, SPI);
    SX1278 *r = new SX1278(module_);
    phys_ = r;
    radio_ = r;
    state = r->begin(lc);
  }
  init_state_ = state;
  Serial.printf("[lora] init chip=%u state=%d freq=%.3f sf=%u bw=%.0f sync=0x%02X pins sck=%d miso=%d mosi=%d cs=%d rst=%d irq=%d busy=%d\n",
                (unsigned)cfg.lora.chip, (int)state, (double)cfg.lora.freq_mhz, (unsigned)cfg.lora.sf,
                (double)cfg.lora.bw_khz, (unsigned)cfg.lora.sync_word, (int)cfg.lora.sck, (int)cfg.lora.miso,
                (int)cfg.lora.mosi, (int)cfg.lora.cs, (int)cfg.lora.rst, irq_pin_, (int)cfg.lora.busy);
  if (state != RADIOLIB_ERR_NONE || !phys_) {
    inited_ = false;
    return false;
  }
  pinMode(irq_pin_, INPUT);
  phys_->startReceive();
  inited_ = true;
  xTaskCreatePinnedToCore(&LoraInterface::taskEntry, "kl_lora", 6144, this, 2, nullptr, 0);
  return true;
}

bool LoraInterface::setSync(uint8_t sync_word) {
  if (!radio_) return false;
  int16_t st = RADIOLIB_ERR_UNKNOWN;
  switch (chip_) {
    case KL_LORA_SX1262: st = static_cast<SX1262 *>(radio_)->setSyncWord(sync_word); break;
    case KL_LORA_LR2021: st = static_cast<LR2021 *>(radio_)->setSyncWord(sync_word); break;
    case KL_LORA_SX1276: st = static_cast<SX1276 *>(radio_)->setSyncWord(sync_word); break;
    default: st = static_cast<SX1278 *>(radio_)->setSyncWord(sync_word); break;
  }
  return st == RADIOLIB_ERR_NONE;
}

bool LoraInterface::setChannel(uint8_t wifi_channel) {
  if (wifi_channel < 1 || wifi_channel > KL_CHANNEL_COUNT) return false;
  pending_channel_ = wifi_channel;
  channel_pending_ = true;
  return true;
}

bool LoraInterface::applyRadioConfig() {
  if (!inited_) return false;
  if (!phys_) return false;
  int16_t state = RADIOLIB_ERR_NONE;
  phys_->standby();
  state |= phys_->setFrequency((uint32_t)(cfg_.lora.freq_mhz * 1000000.0f));
  state |= phys_->setBandwidth((uint32_t)(cfg_.lora.bw_khz * 1000.0f));
  state |= phys_->setSpreadingFactor(cfg_.lora.sf);
  state |= phys_->setCodingRate(cfg_.lora.cr);
  if (!setSync(cfg_.lora.sync_word)) state |= RADIOLIB_ERR_INVALID_SYNC_WORD;
  phys_->startReceive();
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
  if (phys_) result = phys_->scanChannel();
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
        tx_packets_++;
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
    /* RX_DONE выставляет IRQ-пин (DIO1 у SX126x/LR2021, DIO0 у SX127x). */
    if (phys_ && irq_pin_ >= 0 && digitalRead(irq_pin_) == HIGH) {
      uint8_t buf[256];
      const size_t plen = phys_->getPacketLength();
      bool good = false;
      if (plen > 0 && plen <= KL_MAX_PACKET_SIZE) {
        const int16_t state = phys_->readData(buf, plen);
        if (state == RADIOLIB_ERR_NONE) {
          const int16_t rssi = (int16_t)phys_->getRSSI();
          last_quality_ = (int8_t)kl_rssi_to_quality(rssi);
          rx_packets_++;
          good = true;
          pushRx(buf, plen, rssi);
        }
      } else {
        (void)phys_->readData(buf, plen > 0 && plen <= sizeof(buf) ? plen : 1); /* сброс флагов IRQ */
      }
      phys_->startReceive();
      /* IRQ-пин висит в «1» без пакетов (не тот пин, не подключён, нет подтяжки): без паузы этот
       * цикл забирал весь процессор, и шлюз переставал работать. Даём остальным задачам время. */
      if (good) {
        irq_noise_ = 0;
      } else if (++irq_noise_ >= 20) {
        irq_noise_ = 0;
        const uint32_t now = millis();
        if (now - irq_noise_log_ms_ > 60000u) {
          irq_noise_log_ms_ = now;
          Serial.printf("[lora] IRQ pin %d stuck high without packets: check IRQ/DIO wiring\n", irq_pin_);
        }
        vTaskDelay(pdMS_TO_TICKS(100));
      }
      vTaskDelay(pdMS_TO_TICKS(1));
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
                                 phys_(nullptr) {
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

