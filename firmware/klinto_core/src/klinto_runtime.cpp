#include "klinto_runtime.h"

#if defined(ESP32)

#include <Arduino.h>
#include <esp_mac.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <string.h>

#include "klinto_codec.h"
#include "klinto_platform_esp32.h"
#include "klinto_ota_esp32.h"
#include "klinto_owner.h"
#include "klinto_util.h"

#if __has_include("config.h")
#include "config.h"
#endif

#ifndef KL_ROLE
#define KL_ROLE "wearable"
#endif
#ifndef KL_USE_LORA
#define KL_USE_LORA 0
#endif
#ifndef KL_CONNECTIVITY
#define KL_CONNECTIVITY "wifi"
#endif
#ifndef KL_MESH_CHANNEL
#define KL_MESH_CHANNEL 11
#endif
#ifndef KL_HUB_URL
#define KL_HUB_URL ""
#endif
#ifndef KL_MODULE_TOKEN
#define KL_MODULE_TOKEN ""
#endif
#ifndef KL_WIFI_SSID
#define KL_WIFI_SSID ""
#endif
#ifndef KL_WIFI_PASS
#define KL_WIFI_PASS ""
#endif
#ifndef KL_LORA_CHIP_SX1262
#define KL_LORA_CHIP_SX1262 1
#endif
#ifndef KL_LORA_SCK
#define KL_LORA_SCK 4
#endif
#ifndef KL_LORA_MISO
#define KL_LORA_MISO 5
#endif
#ifndef KL_LORA_MOSI
#define KL_LORA_MOSI 6
#endif
#ifndef KL_LORA_CS
#define KL_LORA_CS 7
#endif
#ifndef KL_LORA_RST
#define KL_LORA_RST 3
#endif
#ifndef KL_LORA_DIO0
#define KL_LORA_DIO0 2
#endif
#ifndef KL_LORA_BUSY
#define KL_LORA_BUSY 10
#endif
#ifndef KL_LORA_FREQ
#define KL_LORA_FREQ 869.525f
#endif
#ifndef KL_LORA_SF
#define KL_LORA_SF 9
#endif
#ifndef KL_LORA_BW
#define KL_LORA_BW 125.0f
#endif
#ifndef KL_LORA_CR
#define KL_LORA_CR 5
#endif
#ifndef KL_LORA_POWER
#define KL_LORA_POWER 17
#endif

namespace {

/** LittleFS adapter for KlintoFlashQueue (one path per queue). */
struct LfsCtx {
  const char *path;
};

/* Один экземпляр на процесс (скетч — синглтон); очередь хранит указатель
 * на эти структуры, поэтому они должны жить дольше KlintoNode::begin(). */
static LfsCtx g_up_ctx = {"/klinto_up.q"};
static LfsCtx g_down_ctx = {"/klinto_down.q"};

bool lfs_read(void *ctx, uint32_t off, void *buf, size_t len) {
  const LfsCtx *c = (const LfsCtx *)ctx;
  File f = LittleFS.open(c->path, "r");
  if (!f) {
    /* A missing file reads as zeroes; init() will format it. */
    memset(buf, 0, len);
    return true;
  }
  if (!f.seek(off)) {
    f.close();
    return false;
  }
  const size_t n = f.read((uint8_t *)buf, len);
  f.close();
  if (n < len) memset((uint8_t *)buf + n, 0, len - n);
  return true;
}

bool lfs_write(void *ctx, uint32_t off, const void *buf, size_t len) {
  const LfsCtx *c = (const LfsCtx *)ctx;
  File f = LittleFS.open(c->path, "r+");
  if (!f) f = LittleFS.open(c->path, "w+");
  if (!f) return false;
  if (!f.seek(off)) {
    f.close();
    return false;
  }
  const size_t n = f.write((const uint8_t *)buf, len);
  f.close();
  return n == len;
}

bool lfs_size(void *ctx, uint32_t *out) {
  const LfsCtx *c = (const LfsCtx *)ctx;
  File f = LittleFS.open(c->path, "r");
  if (!f) {
    *out = 0;
    return true;
  }
  *out = (uint32_t)f.size();
  f.close();
  return true;
}

bool lfs_truncate(void *ctx, uint32_t size) {
  const LfsCtx *c = (const LfsCtx *)ctx;
  File f = LittleFS.open(c->path, "w");
  if (!f) return false;
  if (size) {
    if (!f.seek(size - 1)) {
      f.close();
      return false;
    }
    f.write((uint8_t)0);
  }
  f.close();
  return true;
}

bool parseMqttUrl(const char *url, char *host, size_t host_cap, uint16_t *port, bool *tls) {  if (!url || !host || !port || !tls) return false;
  *tls = false;
  *port = 1883;
  const char *p = url;
  if (!strncmp(p, "mqtts://", 8)) {
    *tls = true;
    *port = 8883;
    p += 8;
  } else if (!strncmp(p, "mqtt://", 7)) {
    p += 7;
  } else if (!strncmp(p, "https://", 8)) {
    *tls = true;
    *port = 8883;
    p += 8;
  } else if (!strncmp(p, "http://", 7)) {
    p += 7;
  } else {
    return false;
  }
  const char *slash = strchr(p, '/');
  const char *colon = strchr(p, ':');
  const size_t host_len = colon && (!slash || colon < slash) ? (size_t)(colon - p)
                                                             : (slash ? (size_t)(slash - p) : strlen(p));
  if (host_len == 0 || host_len >= host_cap) return false;
  memcpy(host, p, host_len);
  host[host_len] = '\0';
  if (colon && (!slash || colon < slash)) {
    const long value = strtol(colon + 1, nullptr, 10);
    if (value > 0 && value < 65536) *port = (uint16_t)value;
  }
  return true;
}

}  // namespace

KlintoNode &KlintoNode::instance() {
  static KlintoNode node;
  return node;
}

KlintoNode::KlintoNode()
    : client_link_(nullptr), hardware_id_{0}, started_(false), boot_valid_ms_(0) {
  memset(&cfg_, 0, sizeof(cfg_));
}

bool KlintoNode::loadConfig() {
  kl_config_defaults(&cfg_);
  cfg_.node_id = kl_node_id_from_mac();
  snprintf(hardware_id_, sizeof(hardware_id_), "esp32-%08lx", (unsigned long)cfg_.node_id);
  strncpy(cfg_.hardware_id, hardware_id_, sizeof(cfg_.hardware_id) - 1);
  cfg_.wifi_channel = KL_MESH_CHANNEL;
  cfg_.espnow_enabled = strcmp(KL_CONNECTIVITY, "lora") != 0;

  if (!strcmp(KL_ROLE, "gateway")) cfg_.role = KL_ROLE_GATEWAY;
  else if (!strcmp(KL_ROLE, "repeater") || !strcmp(KL_ROLE, "router")) cfg_.role = KL_ROLE_ROUTER;
  else cfg_.role = KL_ROLE_CLIENT;
#ifdef KL_HYBRID_PORTABLE
  cfg_.hybrid_portable = KL_HYBRID_PORTABLE != 0;
#endif
#ifdef KL_RELAY_ALLOWED
  cfg_.relay_allowed = KL_RELAY_ALLOWED != 0;
#endif
  cfg_.gateway_id = cfg_.node_id;

  if (KL_USE_LORA) {
    cfg_.lora_present = true;
    cfg_.lora.chip = KL_LORA_CHIP_SX1262 ? KL_LORA_SX1262 : KL_LORA_SX1278;
    cfg_.lora.sck = KL_LORA_SCK;
    cfg_.lora.miso = KL_LORA_MISO;
    cfg_.lora.mosi = KL_LORA_MOSI;
    cfg_.lora.cs = KL_LORA_CS;
    cfg_.lora.rst = KL_LORA_RST;
    cfg_.lora.dio0 = KL_LORA_DIO0;
    cfg_.lora.dio1 = KL_LORA_DIO0;
    cfg_.lora.busy = KL_LORA_BUSY;
    cfg_.lora.freq_mhz = KL_LORA_FREQ;
    cfg_.lora.sf = KL_LORA_SF;
    cfg_.lora.bw_khz = KL_LORA_BW;
    cfg_.lora.cr = KL_LORA_CR;
    cfg_.lora.power_dbm = KL_LORA_POWER;
  }
  strncpy(cfg_.hub_url, KL_HUB_URL, sizeof(cfg_.hub_url) - 1);
  strncpy(cfg_.module_token, KL_MODULE_TOKEN, sizeof(cfg_.module_token) - 1);

#ifdef KL_TEMP_MESH_KEY
  kl_config_set_temp_key_hex(&cfg_, KL_TEMP_MESH_KEY);
#endif
  /* NVS wins over compile-time defaults (hardware is user-assembled). */
  kl_config_load_nvs(&cfg_);
  {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    kl_ble_mod6(mac, cfg_.ble_mod6);
    char prefix[KL_OWNER_PREFIX_LEN + 1];
    if (kl_nvs_get_str("klinto3", "owner_prefix", prefix, sizeof(prefix)) &&
        kl_owner_prefix_normalize(prefix, cfg_.owner_ble_prefix)) {
      /* загружено из NVS */
    }
    cfg_.owner_net_id = kl_nvs_get_uint("klinto3", "owner_net", cfg_.owner_net_id);
    cfg_.owner_epoch = kl_nvs_get_uint("klinto3", "owner_epoch", cfg_.owner_epoch);
  }
  if (cfg_.role == KL_ROLE_GATEWAY) cfg_.gateway_id = cfg_.node_id;
  kl_config_validate(&cfg_);
  return true;
}

bool KlintoNode::begin() {
  if (started_) return true;
  Serial.begin(115200);
  delay(100);
  Serial.println();
  Serial.println("[klinto3] boot");

  if (!LittleFS.begin(true)) {
    Serial.println("[klinto3] LittleFS mount failed");
  }
  loadConfig();

  Serial.printf("[klinto3] role=%u node=%lu iface=%s%s\n", (unsigned)cfg_.role,
                (unsigned long)cfg_.node_id, cfg_.espnow_enabled ? "espnow" : "",
                cfg_.lora_present ? "+lora" : "");

  if (cfg_.role == KL_ROLE_GATEWAY) {
    if (strlen(KL_WIFI_SSID)) {
      WiFi.mode(WIFI_STA);
      WiFi.begin(KL_WIFI_SSID, KL_WIFI_PASS);
      const uint32_t start = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) delay(200);
      if (WiFi.status() == WL_CONNECTED) {
        cfg_.wifi_channel = (uint8_t)WiFi.channel();
        Serial.printf("[klinto3] wifi up, channel %u\n", (unsigned)cfg_.wifi_channel);
      }
    }
  } else {
    WiFi.mode(WIFI_STA);
    WiFi.disconnect(false, false);
    delay(30);
  }

  if (cfg_.espnow_enabled) {
    if (!espnow_.init(cfg_)) Serial.println("[klinto3] ESP-NOW init failed");
    espnow_.setReceiveCallback(&KlintoNode::onRadioFrame, this);
  }
  if (cfg_.lora_present) {
    if (!lora_.init(cfg_)) Serial.println("[klinto3] LoRa init failed");
    lora_.setReceiveCallback(&KlintoNode::onRadioFrame, this);
  }

  kl_storage_ops_t up_ops = {&g_up_ctx, lfs_read, lfs_write, lfs_size, lfs_truncate};
  kl_storage_ops_t down_ops = {&g_down_ctx, lfs_read, lfs_write, lfs_size, lfs_truncate};
  up_queue_.init(&up_ops);
  down_queue_.init(&down_ops);

  kl_router_sink_t sink = {this, &KlintoNode::sinkSend,       &KlintoNode::sinkDeliver,
                           &KlintoNode::sinkStatus,          &KlintoNode::sinkArchive,
                           &KlintoNode::sinkPresence,        &KlintoNode::sinkBeacon};
  router_.init(&cfg_, &sink);

  /* OTA: телеметрия версии и каскадный приём дельта-патчей. */
  kl_ota_esp32_begin();
  ota_.init(kl_ota_esp32_platform(), (uint8_t)KL_CHIP_ARCH, (uint16_t)KL_FIRMWARE_BUILD,
            kl_ota_esp32_stored_build());
  ota_.set_send(&KlintoNode::otaSend, this);
  ota_.set_state_cb(&KlintoNode::otaState, this);
  {
    uint8_t radio_caps = 0;
    if (cfg_.lora_present) {
      radio_caps |= KL_RADIO_LORA;
      radio_caps |= cfg_.lora.chip == KL_LORA_SX1262 ? KL_RADIO_SX1262 : KL_RADIO_SX127X;
    }
#if KL_HAS_BLE
    radio_caps |= KL_RADIO_BLE;
#endif
    if (cfg_.espnow_enabled) radio_caps |= KL_RADIO_WIFI_MESH;
    router_.set_telemetry((uint16_t)KL_FIRMWARE_BUILD, (uint8_t)KL_CHIP_ARCH, radio_caps);
    router_.set_owner_net_id(cfg_.owner_net_id);
  }
  boot_valid_ms_ = millis();

  /* Частотное кластерирование: шлюз фиксирует канал AP, остальные ищут соту. */
  kl_cell_host_t cell_host = {this, &KlintoNode::cellApplyChannel, &KlintoNode::cellLocked,
                              &KlintoNode::cellOffline};
  cell_.init(&cfg_, &cell_host);
  if (cfg_.role == KL_ROLE_GATEWAY) {
    uint8_t channel = cfg_.wifi_channel;
    if (WiFi.status() == WL_CONNECTED) {
      const int wifi_channel = WiFi.channel();
      if (wifi_channel >= 1 && wifi_channel <= KL_CHANNEL_COUNT) channel = (uint8_t)wifi_channel;
    }
    cell_.lock_gateway(channel, millis());
    router_.emit_gateway_beacon(millis());
  } else {
    cell_.start_scan(millis(), KL_SCAN_BOOT);
  }

  /* Client bridge: BLE by default, USB serial for headless/dev boards. */
  char chosen[16] = "ble";
  if (kl_nvs_get_str("klinto3", "client_link", chosen, sizeof(chosen))) {
    /* already copied */
  }
#if KL_HAS_BLE
  {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char ble_name[KL_OWNER_NAME_LEN];
    if (!kl_ble_name_build(cfg_.owner_ble_prefix, mac, ble_name, sizeof(ble_name))) {
      snprintf(ble_name, sizeof(ble_name), "KL-00000000-%s", cfg_.ble_mod6);
    }
    ble_.begin(ble_name);
    ble_.setReceiveCallback(&KlintoNode::onClientLink, this);
  }
#endif
  serial_.begin(115200);
  serial_.setReceiveCallback(&KlintoNode::onClientLink, this);
  if (!strncmp(chosen, "serial", 6)
#if !KL_HAS_BLE
      || true
#endif
  ) {
    client_link_ = &serial_;
  } else {
    client_link_ = &ble_;
  }

  kl_bridge_sink_t bridge_sink = {this, &KlintoNode::onConfig, &KlintoNode::onLog,
                                  &KlintoNode::onInetStatus, &KlintoNode::onVerifyOwnerClaim,
                                  &KlintoNode::onOwnerChanged};
  bridge_.init(&router_, &cfg_, client_link_, &down_queue_, &bridge_sink);

  if (cfg_.role == KL_ROLE_GATEWAY) {
#if KL_HAS_MQTT
    char host[96] = {0};
    uint16_t port = 1883;
    bool tls = false;
    if (parseMqttUrl(cfg_.hub_url, host, sizeof(host), &port, &tls)) {
      char down_topic[80];
      snprintf(down_topic, sizeof(down_topic), "klinto/kmesh/v1/gw/%lu/down",
               (unsigned long)cfg_.gateway_id);
      char client_id[48];
      snprintf(client_id, sizeof(client_id), "klinto-gw-%lu", (unsigned long)cfg_.gateway_id);
      char mqtt_ca[1600] = {0};
      kl_nvs_get_str("klinto3", "mqtt_ca", mqtt_ca, sizeof(mqtt_ca));
      char mqtt_user[48] = {0};
      kl_nvs_get_str("klinto3", "mqtt_user", mqtt_user, sizeof(mqtt_user));
      char mqtt_pass[48] = {0};
      kl_nvs_get_str("klinto3", "mqtt_pass", mqtt_pass, sizeof(mqtt_pass));
      if (tls && !mqtt_ca[0]) {
        Serial.println("[klinto3] WARNING: MQTT TLS without mqtt_ca -> insecure mode");
      }
      mqtt_.begin(host, port, tls, mqtt_user[0] ? mqtt_user : nullptr,
                  mqtt_pass[0] ? mqtt_pass : cfg_.module_token, mqtt_ca[0] ? mqtt_ca : nullptr,
                  client_id, down_topic);
    }
    kl_gateway_sink_t gsink = {this, &KlintoNode::sinkInjectDownlink,
                               &KlintoNode::sinkGatewayStatus};
    gateway_.init(&cfg_, &mqtt_, &up_queue_, &gsink);
#endif
  }

  startTasks();
  started_ = true;
  return true;
}

void KlintoNode::startTasks() {
  xTaskCreatePinnedToCore(&KlintoNode::meshTaskEntry, "kl_mesh", 8192, this, 5, nullptr, 0);
  xTaskCreatePinnedToCore(&KlintoNode::clientTaskEntry, "kl_client", 8192, this, 3, nullptr, 1);
  if (cfg_.role == KL_ROLE_GATEWAY) {
    xTaskCreatePinnedToCore(&KlintoNode::gatewayTaskEntry, "kl_gateway", 16384, this, 2, nullptr, 0);
  }
}

void KlintoNode::loop() { vTaskDelay(pdMS_TO_TICKS(1000)); }

void KlintoNode::onRadioFrame(void *ctx, const uint8_t *data, size_t len, int16_t rssi,
                             uint8_t iface) {
  KlintoNode *self = (KlintoNode *)ctx;
  kl_packet_t pkt;
  if (!kl_packet_parse(data, len, &pkt)) return;
  self->router_.on_packet(&pkt, iface, rssi, kl_uptime_ms());
}

bool KlintoNode::sinkSend(void *ctx, const kl_packet_t *pkt, uint8_t iface, uint32_t next_hop) {
  KlintoNode *self = (KlintoNode *)ctx;
  uint8_t wire[KL_MAX_PACKET_SIZE];
  const size_t len = kl_packet_serialize(pkt, wire, sizeof(wire));
  if (!len) return false;
  uint8_t priority = KL_PRIO_MEDIUM;
  if (pkt->type == KL_TYPE_ACK || pkt->type == KL_TYPE_RREP) priority = KL_PRIO_HIGH;
  else if (pkt->type == KL_TYPE_OTA_ANNOUNCE || pkt->type == KL_TYPE_OTA_CHUNK ||
           pkt->type == KL_TYPE_OTA_NACK) {
    priority = KL_PRIO_OTA_IDLE;
  } else if (pkt->type == KL_TYPE_GW_BEACON || pkt->type == KL_TYPE_NODE_PRESENCE ||
           pkt->type == KL_TYPE_RREQ) {
    priority = KL_PRIO_LOW;
  } else if (pkt->type == KL_TYPE_DATA &&
             kl_rpc_priority_hint(pkt->payload, pkt->payload_len) == KL_PRIO_LOW) {
    priority = KL_PRIO_LOW;
  }
  if (iface == KL_IFACE_LORA) return self->lora_.sendPacket(wire, len, next_hop, priority);
  if (iface == KL_IFACE_ESPNOW) return self->espnow_.sendPacket(wire, len, next_hop, priority);
  return false;
}

void KlintoNode::sinkDeliver(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface) {
  KlintoNode *self = (KlintoNode *)ctx;
  if (!pkt) return;
  if (pkt->type == KL_TYPE_OTA_ANNOUNCE || pkt->type == KL_TYPE_OTA_CHUNK ||
      pkt->type == KL_TYPE_OTA_NACK) {
    self->ota_.handle_packet(pkt, kl_uptime_ms());
    return;
  }
  if (pkt->type == KL_TYPE_NODE_PRESENCE) {
    /* Router.presence already reported it; avoid a duplicate publish. */
    return;
  }
  if (pkt->type == KL_TYPE_GW_BEACON || pkt->type == KL_TYPE_ACK || pkt->type == KL_TYPE_RREQ ||
      pkt->type == KL_TYPE_RREP) {
    return;
  }
  if ((self->cfg_.role == KL_ROLE_GATEWAY || self->router_.mobile_gateway_active()) &&
      ((pkt->flags & KL_FLAG_TO_INTERNET) || pkt->dst_id == KL_ANY_GATEWAY_ID)) {
    if (self->router_.mobile_gateway_active()) {
      /* Мобильный шлюз: телефон-курьер отправляет пакет на Hub. */
      self->bridge_.proxy_uplink(pkt);
    } else {
      /* Стационарный шлюз: не блокируем mesh-задачу на TLS. */
      self->up_queue_.push(pkt);
    }
    return;
  }
  self->bridge_.deliver_mesh(pkt);
}

void KlintoNode::sinkStatus(void *ctx, uint64_t msg_uuid, uint32_t packet_id, uint8_t status) {
  KlintoNode *self = (KlintoNode *)ctx;
  self->bridge_.status(msg_uuid, packet_id, status);
}

void KlintoNode::sinkArchive(void *ctx, const kl_packet_t *pkt) {
  KlintoNode *self = (KlintoNode *)ctx;
  if (!pkt) return;
  if (self->router_.mobile_gateway_active()) {
    self->bridge_.proxy_uplink(pkt);
  } else {
    self->up_queue_.push(pkt);
  }
}

void KlintoNode::sinkPresence(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface) {
  (void)rssi;
  (void)iface;
  KlintoNode *self = (KlintoNode *)ctx;
  if (!pkt) return;
  if (self->router_.mobile_gateway_active()) {
    self->bridge_.proxy_uplink(pkt);
  } else {
    self->up_queue_.push(pkt);
  }
}

void KlintoNode::sinkBeacon(void *ctx, const kl_packet_t *pkt, int16_t rssi, uint8_t iface) {
  (void)iface;
  KlintoNode *self = (KlintoNode *)ctx;
  if (!pkt) return;
  uint32_t gateway_id = pkt->src_id;
  if (pkt->payload_len >= 8) gateway_id = kl_read_le32(pkt->payload + 4);
  self->cell_.on_beacon(gateway_id, pkt->hop_count, rssi, kl_uptime_ms());
}

bool KlintoNode::cellApplyChannel(void *ctx, uint8_t wifi_channel) {
  KlintoNode *self = (KlintoNode *)ctx;
  if (wifi_channel < 1 || wifi_channel > KL_CHANNEL_COUNT) return false;
  const uint8_t band = kl_channel_plan_band_for_freq(self->cfg_.lora.freq_mhz);
  const kl_channel_plan_entry_t *entry = kl_channel_plan_entry(wifi_channel, band);
  if (!entry) return false;
  self->cfg_.wifi_channel = wifi_channel;
  self->cfg_.lora.freq_mhz = (float)entry->lora_freq_hz / 1000000.0f;
  self->cfg_.lora.sync_word = entry->lora_sync_word;
  self->cfg_.lora.bw_khz = (float)entry->lora_bw_khz;
  self->cfg_.lora.sf = entry->lora_sf;
  if (self->cfg_.espnow_enabled) self->espnow_.setChannel(wifi_channel);
  if (self->cfg_.lora_present) self->lora_.setChannel(wifi_channel);
  self->router_.on_channel_changed(wifi_channel);
  Serial.printf("[klinto] radio cell: wifi=%u lora=%.3f MHz sync=0x%02X\n",
                (unsigned)wifi_channel, (double)self->cfg_.lora.freq_mhz,
                (unsigned)self->cfg_.lora.sync_word);
  return true;
}

void KlintoNode::cellLocked(void *ctx, uint8_t channel, uint32_t gateway_id, int16_t rssi,
                            uint8_t hops, uint8_t reason) {
  KlintoNode *self = (KlintoNode *)ctx;
  Serial.printf("[klinto] cell locked ch=%u gw=%lu rssi=%d hops=%u reason=%u\n",
                (unsigned)channel, (unsigned long)gateway_id, (int)rssi, (unsigned)hops,
                (unsigned)reason);
  self->router_.request_presence();
}

void KlintoNode::cellOffline(void *ctx, uint8_t channel) {
  KlintoNode *self = (KlintoNode *)ctx;
  Serial.printf("[klinto] no gateway, offline channel=%u\n", (unsigned)channel);
  self->router_.request_presence();
}

bool KlintoNode::sinkInjectDownlink(void *ctx, const kl_packet_t *pkt) {
  KlintoNode *self = (KlintoNode *)ctx;
  kl_packet_t copy = *pkt;
  return self->router_.forward_downlink(&copy, kl_uptime_ms());
}

void KlintoNode::sinkGatewayStatus(void *ctx, uint64_t msg_uuid, uint32_t packet_id,
                                  uint8_t status) {
  KlintoNode *self = (KlintoNode *)ctx;
  if (status == KL_STATUS_SYNCED_PERMANENT) {
    self->bridge_.synced(msg_uuid, packet_id);
  } else {
    self->bridge_.status(msg_uuid, packet_id, status);
  }
}

void KlintoNode::onClientLink(void *ctx, const uint8_t *data, size_t len, int16_t rssi,
                             uint8_t iface) {
  (void)rssi;
  (void)iface;
  KlintoNode *self = (KlintoNode *)ctx;
  self->bridge_.on_link_data(data, len);
}

void KlintoNode::onConfig(void *ctx, const char *json, size_t len) {
  KlintoNode *self = (KlintoNode *)ctx;
  self->onConfigJson(json, len);
}

void KlintoNode::onLog(void *ctx, const char *text) {
  (void)ctx;
  if (text) Serial.println(text);
}

void KlintoNode::onInetStatus(void *ctx, bool has_internet, uint16_t rtt_ms, bool allow_relay) {
  KlintoNode *self = (KlintoNode *)ctx;
  self->router_.set_internet_status(has_internet, rtt_ms, allow_relay);
  Serial.printf("[klinto] inet=%d rtt=%ums relay=%d mobile_gw=%d\n", has_internet ? 1 : 0,
                (unsigned)rtt_ms, allow_relay ? 1 : 0,
                self->router_.mobile_gateway_active() ? 1 : 0);
}

bool KlintoNode::otaSend(void *ctx, uint8_t type, const uint8_t *payload, size_t len,
                         bool broadcast) {
  KlintoNode *self = (KlintoNode *)ctx;
  if (!payload || len > KL_MAX_PAYLOAD) return false;
  /* OTA-чанки — только в пустой эфир: пользовательские очереди и ACK важнее. */
  if (type == KL_TYPE_OTA_CHUNK &&
      (self->router_.pending_count() > 0 || self->router_.ack_count() > 0 ||
       (self->cfg_.lora_present && self->lora_.queueDepth() > 0))) {
    return false;
  }
  kl_packet_t pkt;
  kl_packet_init(&pkt, type, self->cfg_.node_id,
                 broadcast ? KL_BROADCAST_ID : KL_ANY_GATEWAY_ID, KL_BROADCAST_ID, 0);
  if (!kl_packet_set_payload(&pkt, payload, len)) return false;
  return self->router_.send(&pkt, kl_uptime_ms(), 0xFF, false);
}

void KlintoNode::otaState(void *ctx, uint8_t state) {
  KlintoNode *self = (KlintoNode *)ctx;
  self->router_.set_ota_state(state);
  Serial.printf("[klinto] ota_state=%u build=%u\n", (unsigned)state,
                (unsigned)self->ota_.current_build());
}

bool KlintoNode::onVerifyOwnerClaim(void *ctx, const uint8_t digest[32], const uint8_t *sig,
                                    size_t sig_len) {
  (void)ctx;
  return kl_ota_esp32_verify_pubkey(digest, sig, sig_len);
}

void KlintoNode::onOwnerChanged(void *ctx, const char *prefix, uint32_t net_id, uint32_t epoch) {
  KlintoNode *self = (KlintoNode *)ctx;
  char norm[KL_OWNER_PREFIX_LEN + 1];
  if (!kl_owner_prefix_normalize(prefix, norm)) return;
  memcpy(self->cfg_.owner_ble_prefix, norm, sizeof(self->cfg_.owner_ble_prefix));
  self->cfg_.owner_net_id = net_id;
  self->cfg_.owner_epoch = epoch;
  kl_nvs_set_str("klinto3", "owner_prefix", norm);
  kl_nvs_set_uint("klinto3", "owner_net", net_id);
  kl_nvs_set_uint("klinto3", "owner_epoch", epoch);
  self->router_.set_owner_net_id(net_id);
  self->router_.request_presence();
#if KL_HAS_BLE
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  char name[KL_OWNER_NAME_LEN];
  if (kl_ble_name_build(norm, mac, name, sizeof(name))) self->ble_.rename(name);
#endif
  Serial.printf("[klinto] owner saved: %s net=%lu epoch=%lu\n", norm, (unsigned long)net_id,
                (unsigned long)epoch);
}

void KlintoNode::onConfigJson(const char *json, size_t len) {
  (void)len;  char ssid[64];
  char pass[64];
  if (kl_json_get_string(json, "wifiSsid", ssid, sizeof(ssid))) {
    kl_nvs_set_str("wifi", "ssid", ssid);
  }
  if (kl_json_get_string(json, "wifiPassword", pass, sizeof(pass))) {
    kl_nvs_set_str("wifi", "pass", pass);
  }
}

void KlintoNode::meshTaskEntry(void *arg) {
  KlintoNode *self = (KlintoNode *)arg;
  uint32_t last_tick = 0;
  uint32_t last_ota_tick = 0;
  for (;;) {
    const uint32_t now = kl_uptime_ms();
    if (self->cfg_.espnow_enabled) self->espnow_.poll(now);
    if (self->cfg_.lora_present) self->lora_.poll(now);
    if (now - last_tick >= 10) {
      self->cell_.tick(now);
      self->router_.tick(now);
      last_tick = now;
    }
    if (now - last_ota_tick >= 100) {
      self->ota_.tick(now);
      last_ota_tick = now;
    }
    /* 30 секунд стабильной работы: подтверждаем OTA-образ и фиксируем build. */
    if (self->boot_valid_ms_ && now - self->boot_valid_ms_ >= 30000u) {
      self->boot_valid_ms_ = 0;
      self->ota_.mark_boot_valid();
      kl_ota_esp32_store_build((uint16_t)KL_FIRMWARE_BUILD);
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

void KlintoNode::clientTaskEntry(void *arg) {
  KlintoNode *self = (KlintoNode *)arg;
  for (;;) {
    self->bridge_.loop(kl_uptime_ms());
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

void KlintoNode::gatewayTaskEntry(void *arg) {
  KlintoNode *self = (KlintoNode *)arg;
  uint32_t next_ota_check = 0;
  for (;;) {
    const uint32_t now = kl_uptime_ms();
    self->gateway_.loop(now);
    if (!self->ota_.source_active() && (next_ota_check == 0 || now >= next_ota_check)) {
      next_ota_check = now + 300000u;
      const char *url = strncmp(self->cfg_.hub_url, "http", 4) == 0
                            ? self->cfg_.hub_url
                            : "http://150.251.143.212:8080";
      kl_ota_manifest_t manifest;
      if (kl_ota_esp32_sync(url, self->cfg_.module_token, (uint8_t)KL_CHIP_ARCH,
                            (uint16_t)KL_FIRMWARE_BUILD, &manifest)) {
        self->ota_.start_source(manifest);
        Serial.printf("[klinto] ota source build=%u patch=%lu\n",
                      (unsigned)manifest.target_build, (unsigned long)manifest.patch_size);
      }
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

#endif  // ESP32
