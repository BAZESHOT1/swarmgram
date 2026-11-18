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
#include <stdlib.h>

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
  /* hardwareId = esp32-<12 hex MAC>: Hub и клиент сверяют его с MAC модуля
   * (mod6 — последние 3 байта). Раньше здесь был 8-hex node_id, из-за чего
   * /kmesh/v1/modules/claim отвечал invalid_module_mac. */
  {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(hardware_id_, sizeof(hardware_id_), "esp32-%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  }
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
#ifdef KL_LORA_CHIP_ID
    cfg_.lora.chip = (uint8_t)KL_LORA_CHIP_ID; /* 0 sx1278, 1 sx1262, 2 sx1276, 3 lr2021 */
#else
    cfg_.lora.chip = KL_LORA_CHIP_SX1262 ? KL_LORA_SX1262 : KL_LORA_SX1278;
#endif
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
#ifdef KL_TEMP_MESH_KEY
  /* Исключение — транспортный KMesh-ключ: его задаёт сервер при сборке.
   * Сохранённая в NVS копия от старой прошивки не должна перекрывать новый
   * ключ, иначе шлюз не сможет расшифровать пакеты кластера. */
  kl_config_set_temp_key_hex(&cfg_, KL_TEMP_MESH_KEY);
#endif
#ifdef KL_HUB_URL
  /* Hub URL тоже задаёт сборка: после переезда на hub.kintoapp.xyz старый
   * адрес в NVS не должен удерживать шлюз на прежнем домене. */
  if (strlen(KL_HUB_URL)) {
    strncpy(cfg_.hub_url, KL_HUB_URL, sizeof(cfg_.hub_url) - 1);
    cfg_.hub_url[sizeof(cfg_.hub_url) - 1] = '\0';
  }
#endif
  {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    kl_ble_mod6(mac, cfg_.ble_mod6);
    char prefix[KL_OWNER_PREFIX_LEN + 1];
    if (kl_nvs_get_str("klinto3", "owner_prefix", prefix, sizeof(prefix)) &&
        kl_owner_prefix_normalize(prefix, cfg_.owner_ble_prefix)) {
      /* загружено из NVS */
    }
#ifdef KL_MODULE_NAME
    strncpy(cfg_.display_name, KL_MODULE_NAME, sizeof(cfg_.display_name) - 1);
#endif
    kl_nvs_get_str("klinto3", "name", cfg_.display_name, sizeof(cfg_.display_name));
    cfg_.owner_net_id = kl_nvs_get_uint("klinto3", "owner_net", cfg_.owner_net_id);
    cfg_.owner_epoch = kl_nvs_get_uint("klinto3", "owner_epoch", cfg_.owner_epoch);
  }
#if defined(KL_BATT_ENABLED) && KL_BATT_ENABLED
  cfg_.batt_pin = (int8_t)KL_BATT_PIN;
  cfg_.batt_ratio_x100 = (uint16_t)(KL_BATT_RATIO * 100.0f + 0.5f);
#endif
  loadHw();
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
  /* Фиксируем в NVS роль/распиновку/тип модуля из сборки: эти параметры
   * должны переживать перезагрузку и OTA. */
  kl_config_save_nvs(&cfg_);

  Serial.printf("[klinto3] role=%u node=%lu iface=%s%s\n", (unsigned)cfg_.role,
                (unsigned long)cfg_.node_id, cfg_.espnow_enabled ? "espnow" : "",
                cfg_.lora_present ? "+lora" : "");

  if (cfg_.role == KL_ROLE_GATEWAY) {
    /* Wi-Fi из приложения (SET_CONFIG) хранится в NVS и должен иметь
     * приоритет над compile-time SSID: иначе шлюз поднимает AP из сборки
     * и не выходит в Hub. */
    char nvsSsid[64] = {0};
    char nvsPass[64] = {0};
    kl_nvs_get_str("wifi", "ssid", nvsSsid, sizeof(nvsSsid));
    kl_nvs_get_str("wifi", "pass", nvsPass, sizeof(nvsPass));
    const char *ssid = nvsSsid[0] ? nvsSsid : KL_WIFI_SSID;
    const char *pass = nvsSsid[0] ? nvsPass : KL_WIFI_PASS;
    if (strlen(ssid)) {
      WiFi.mode(WIFI_STA);
      WiFi.setSleep(false);
      /* ESP32-C3 Super Mini: из-за антенны/питания на полной мощности роутер не
       * отвечает на auth (reason=2 AUTH_EXPIRE). 8.5 дБм подключается стабильно. */
#if defined(CONFIG_IDF_TARGET_ESP32C3)
      WiFi.setTxPower(WIFI_POWER_8_5dBm);
#endif
      /* Wi-Fi mesh Long Range: LR-PHY рядом с b/g/n (роутер продолжает работать как обычно). */
      esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N |
                                             WIFI_PROTOCOL_LR);
      // Диагностика: какие сети реально видны ESP32 (только 2.4 ГГц).
      const int found = WiFi.scanNetworks();
      Serial.printf("[klinto3] wifi scan: %d networks\n", found);
      for (int i = 0; i < found && i < 12; ++i) {
        Serial.printf("[klinto3]   ssid=%s ch=%d rssi=%d enc=%d\n", WiFi.SSID(i).c_str(),
                      (int)WiFi.channel(i), (int)WiFi.RSSI(i), (int)WiFi.encryptionType(i));
      }
      /* Причина отказа STA (auth/no AP/…) — без неё «status=6» ничего не говорит. */
      WiFi.onEvent([](arduino_event_id_t event, arduino_event_info_t info) {
        if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) {
          Serial.printf("[klinto3] wifi disconnect reason=%d\n",
                        (int)info.wifi_sta_disconnected.reason);
        }
      });
      WiFi.begin(ssid, pass);
      const uint32_t start = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) delay(200);
      if (WiFi.status() == WL_CONNECTED) {
        cfg_.wifi_channel = (uint8_t)WiFi.channel();
        Serial.printf("[klinto3] wifi up ssid=%s channel=%u ip=%s\n", ssid,
                      (unsigned)cfg_.wifi_channel, WiFi.localIP().toString().c_str());
      } else {
        Serial.printf("[klinto3] wifi failed ssid=%s status=%d\n", ssid, (int)WiFi.status());
      }
    }
  } else {
    WiFi.mode(WIFI_STA);
    WiFi.disconnect(false, false);
    delay(30);
    /* C3/C6: BLE и ESP-NOW делят радио. Modem sleep приводил к пропуску
     * GW_BEACON и RREP, из-за чего узел не видел шлюз. Держим радио
     * активным (для носимого модуля важнее стабильность, чем микро-экономия). */
    WiFi.setTxPower(WIFI_POWER_8_5dBm);
    WiFi.setSleep(false);
    esp_wifi_set_ps(WIFI_PS_NONE);
    /* Wi-Fi mesh Long Range (как в Esp-Wifi-Ble-Now): LR-PHY на STA в дополнение к b/g/n. */
    esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N |
                                           WIFI_PROTOCOL_LR);
  }

  if (cfg_.espnow_enabled) {
    if (!espnow_.init(cfg_)) Serial.println("[klinto3] ESP-NOW init failed");
    if (cfg_.espnow_dbm >= 2) esp_wifi_set_max_tx_power((int8_t)(cfg_.espnow_dbm * 4));
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
  /* Шлюз и узел — разные сборки (Wi-Fi/HTTP против BLE): образ одного другому не подходит. */
  ota_.set_variant((uint8_t)(KL_HAS_MQTT ? 1 : 0));
  ota_.set_bad_build(kl_ota_esp32_bad_build());
  ota_pending_ = kl_ota_esp32_pending();
  ota_need_ifc_ = kl_ota_esp32_need_ifc();
  if (ota_pending_) {
    Serial.printf("[ota] new firmware %u: validating (need ifc mask=0x%02x%s)\n", (unsigned)KL_FIRMWARE_BUILD,
                  (unsigned)ota_need_ifc_, cfg_.role == KL_ROLE_GATEWAY ? " + hub" : "");
  }
  if (led_pin_ >= 0) pinMode(led_pin_, OUTPUT);
  ota_.set_state_cb(&KlintoNode::otaState, this);
  {
    uint8_t radio_caps = 0;
    if (cfg_.lora_present) {
      radio_caps |= KL_RADIO_LORA;
      radio_caps |= (cfg_.lora.chip == KL_LORA_SX1262 || cfg_.lora.chip == KL_LORA_LR2021) ? KL_RADIO_SX1262 : KL_RADIO_SX127X;
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
                              &KlintoNode::cellOffline, &KlintoNode::cellProbe};
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
    /* Последний рабочий канал: скан начинается с него (и с ним же живём, пока подключён телефон). */
    cell_.set_preferred_channel((uint8_t)kl_nvs_get_uint("klinto3", "last_ch", 0));
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
    Serial.printf("[klinto3] heap before BLE: free=%u largest=%u\n", (unsigned)ESP.getFreeHeap(),
                  (unsigned)ESP.getMaxAllocHeap());
    ble_.begin(ble_name);
    Serial.printf("[klinto3] heap after BLE: free=%u largest=%u\n", (unsigned)ESP.getFreeHeap(),
                  (unsigned)ESP.getMaxAllocHeap());
    ble_.setReceiveCallback(&KlintoNode::onClientLink, this);
    ble_.setConnectedHook(&KlintoNode::onBleHook, this);
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
                                  &KlintoNode::onOwnerChanged, &KlintoNode::onRemoteConfig};
  bridge_.init(&router_, &cfg_, client_link_, &down_queue_, &bridge_sink);

  if (cfg_.role == KL_ROLE_GATEWAY) {
    /* Hub не требует MQTT: REST-транспорт работает всегда и не зависит
     * от наличия брокера. Очередь uplink та же. */
    http_gateway_.init(&cfg_);
    kl_gateway_sink_t gsink = {this, &KlintoNode::sinkInjectDownlink,
                               &KlintoNode::sinkGatewayStatus};
    gateway_.init(&cfg_, &http_gateway_, &up_queue_, &gsink);
    Serial.printf("[klinto] gateway uplink=http hub=%s\n", cfg_.hub_url);
  }

  startTasks();
  started_ = true;
  return true;
}

void KlintoNode::startTasks() {
  /* ESP32-C3 одноядерный: xTaskCreatePinnedToCore(core=1) роняет assert.
   * На dual-core оставляем mesh на core 0, BLE-клиент на core 1. */
#if defined(CONFIG_FREERTOS_UNICORE) && CONFIG_FREERTOS_UNICORE
  constexpr BaseType_t kClientCore = 0;
#else
  constexpr BaseType_t kClientCore = 1;
#endif
  xTaskCreatePinnedToCore(&KlintoNode::meshTaskEntry, "kl_mesh", 8192, this, 5, nullptr, 0);
  xTaskCreatePinnedToCore(&KlintoNode::clientTaskEntry, "kl_client", 8192, this, 3, nullptr,
                          kClientCore);
  if (cfg_.role == KL_ROLE_GATEWAY) {
    xTaskCreatePinnedToCore(&KlintoNode::gatewayTaskEntry, "kl_gateway", 16384, this, 2, nullptr, 0);
  }
}

void KlintoNode::loop() {
  if (restart_at_ms_ && (int32_t)(millis() - restart_at_ms_) >= 0) ESP.restart();
  if (led_pin_ >= 0) {
    const bool linked = router_.gateway_route()->valid || cfg_.role == KL_ROLE_GATEWAY;
    digitalWrite(led_pin_, linked ? HIGH : (((millis() / 400) & 1) ? HIGH : LOW));
  }
  vTaskDelay(pdMS_TO_TICKS(200));
}

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
    Serial.printf("[TRACE 2/4] ESPNOW->GW: rx packet msg_uuid=%08lx%08lx src=%lu type=%u\n",
                  (unsigned long)(pkt->msg_uuid >> 32),
                  (unsigned long)(pkt->msg_uuid & 0xFFFFFFFFu),
                  (unsigned long)pkt->src_id, (unsigned)pkt->type);
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
  KlintoNode *self = (KlintoNode *)ctx;
  if (!pkt) return;
  Serial.printf("[kmesh] presence src=%lu rssi=%d iface=%u\n", (unsigned long)pkt->src_id,
                (int)rssi, (unsigned)iface);
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
  const uint8_t advertised_channel = pkt->payload_len >= 11 ? pkt->payload[10] : 0;
  Serial.printf("[kmesh] beacon gw=%lu rssi=%d ch=%u\n", (unsigned long)gateway_id, (int)rssi,
                (unsigned)advertised_channel);
  self->cell_.on_beacon(gateway_id, pkt->hop_count, rssi, kl_uptime_ms(),
                        advertised_channel);
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
  /* Запоминаем канал (не чаще, чем он меняется: NVS-цикл записи ограничен). */
  static uint8_t saved_channel = 0;
  if (saved_channel != channel) {
    saved_channel = channel;
    kl_nvs_set_uint("klinto3", "last_ch", channel);
  }
}

void KlintoNode::onBleHook(void *ctx, bool connected) {
  KlintoNode *self = (KlintoNode *)ctx;
  if (connected) self->bridge_.push_info_burst();
}

void KlintoNode::cellProbe(void *ctx) {
  KlintoNode *self = (KlintoNode *)ctx;
  self->router_.emit_probe(kl_uptime_ms());
}

void KlintoNode::cellOffline(void *ctx, uint8_t channel) {
  KlintoNode *self = (KlintoNode *)ctx;
  Serial.printf("[klinto] no gateway, offline channel=%u\n", (unsigned)channel);
  self->router_.request_presence();
}

bool KlintoNode::sinkInjectDownlink(void *ctx, const kl_packet_t *pkt) {
  KlintoNode *self = (KlintoNode *)ctx;
  kl_packet_t copy = *pkt;
  const bool ok = self->router_.forward_downlink(&copy, kl_uptime_ms());
#if defined(ARDUINO)
  Serial.printf("[kmesh] downlink inject dst=%lu ok=%u\n", (unsigned long)pkt->dst_id, ok ? 1u : 0u);
#endif
  return ok;
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
  (void)broadcast;
  kl_packet_t pkt;
  kl_packet_init(&pkt, type, self->cfg_.node_id, KL_BROADCAST_ID, KL_BROADCAST_ID, 0);
  if (!kl_packet_set_payload(&pkt, payload, len)) return false;
  return self->router_.send_ota(&pkt, self->ota_.send_mask(), kl_uptime_ms());
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
  /* Дублируем в полный конфиг: prefix + net + pinout + тип модуля должны
   * восстанавливаться из одного места и переживать OTA. */
  kl_config_save_nvs(&self->cfg_);
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

/* ---- удалённая настройка железа ------------------------------------------------
 * p = "b=<пин>,<коэф×100>;c=<чип>;l=<sck>,<miso>,<mosi>,<cs>,<rst>,<irq>,<busy>;e=<дБм>;w=<дБм>;r=<c|r>"
 * Подписывает Hub (ключ OTA/владельца): sha256("KLINTO-CFG1|<mod6>|<epoch>|<p>"). Эпоха строго растёт. */
struct HwParsed {
  bool has_b = false, has_c = false, has_l = false, has_e = false, has_w = false, has_r = false;
  bool has_i = false, has_d = false;
  int ifc = 3;
  int led = -1;
  int b_pin = -1;
  int b_ratio = 200;
  int chip = 1;
  int l[7] = {0};
  int e = 0, w = 0;
  int role = 0;
};

static bool hw_parse_ints(const char *s, int *out, int n) {
  for (int i = 0; i < n; ++i) {
    char *end = nullptr;
    const long v = strtol(s, &end, 10);
    if (end == s) return false;
    out[i] = (int)v;
    s = end;
    if (i < n - 1) {
      if (*s != ',') return false;
      ++s;
    }
  }
  return *s == '\0';
}

static bool hw_parse(const char *p, HwParsed *o) {
  char buf[128];
  if (!p || strlen(p) >= sizeof(buf)) return false;
  strcpy(buf, p);
  char *save = nullptr;
  for (char *tok = strtok_r(buf, ";", &save); tok; tok = strtok_r(nullptr, ";", &save)) {
    if (tok[1] != '=') return false;
    const char key = tok[0];
    const char *val = tok + 2;
    int v[7];
    switch (key) {
      case 'b':
        if (!hw_parse_ints(val, v, 2) || v[0] < -1 || v[0] > 48 || v[1] < 100 || v[1] > 1000) return false;
        o->has_b = true; o->b_pin = v[0]; o->b_ratio = v[1];
        break;
      case 'c':
        if (!hw_parse_ints(val, v, 1) || v[0] < 0 || v[0] > 3) return false;
        o->has_c = true; o->chip = v[0];
        break;
      case 'l':
        if (!hw_parse_ints(val, v, 7)) return false;
        for (int i = 0; i < 7; ++i) if (v[i] < -1 || v[i] > 48) return false;
        o->has_l = true; memcpy(o->l, v, sizeof(v));
        break;
      case 'e':
        if (!hw_parse_ints(val, v, 1) || v[0] < 2 || v[0] > 21) return false;
        o->has_e = true; o->e = v[0];
        break;
      case 'w':
        if (!hw_parse_ints(val, v, 1) || v[0] < 2 || v[0] > 22) return false;
        o->has_w = true; o->w = v[0];
        break;
      case 'r':
        if (val[0] != 'c' && val[0] != 'r') return false;
        o->has_r = true; o->role = val[0] == 'r' ? 1 : 0;
        break;
      case 'i':
        if (!hw_parse_ints(val, v, 1) || v[0] < 1 || v[0] > 3) return false;
        o->has_i = true; o->ifc = v[0];
        break;
      case 'd':
        if (!hw_parse_ints(val, v, 1) || v[0] < -1 || v[0] > 48) return false;
        o->has_d = true; o->led = v[0];
        break;
      default:
        return false;
    }
  }
  return true;
}

/* Том данных модуля (NVS «hw»): всё, что нужно, чтобы после OTA модуль работал с прежними
 * настройками — транспорты, LoRa (чип, пины, мощность), делитель батареи, светодиод, мощность
 * ESP-NOW, тип; Wi-Fi шлюза — в «wifi», владелец и имя — в «klinto3». При первом запуске
 * значения берутся из сборки, дальше NVS главнее: OTA-образ одинаков для всех модулей. */
void KlintoNode::seedHw() {
  if (kl_nvs_get_uint("hw", "seed", 0)) return;
  kl_nvs_set_uint("hw", "if", (uint32_t)((cfg_.espnow_enabled ? 1 : 0) | (cfg_.lora_present ? 2 : 0)));
  if (cfg_.lora_present) {
    kl_nvs_set_uint("hw", "lc", (uint32_t)(cfg_.lora.chip + 1));
    char ls[48];
    snprintf(ls, sizeof(ls), "%d,%d,%d,%d,%d,%d,%d", cfg_.lora.sck, cfg_.lora.miso, cfg_.lora.mosi,
             cfg_.lora.cs, cfg_.lora.rst, cfg_.lora.dio0, cfg_.lora.busy);
    kl_nvs_set_str("hw", "ls", ls);
    kl_nvs_set_uint("hw", "lw", (uint32_t)cfg_.lora.power_dbm);
  }
  kl_nvs_set_uint("hw", "bp", (uint32_t)(cfg_.batt_pin + 1));
  kl_nvs_set_uint("hw", "br", cfg_.batt_ratio_x100);
#if defined(KL_LED_PIN)
  kl_nvs_set_uint("hw", "ld", (uint32_t)(KL_LED_PIN + 1));
#endif
  if (cfg_.role != KL_ROLE_GATEWAY) kl_nvs_set_uint("hw", "rl", cfg_.role == KL_ROLE_ROUTER ? 2u : 1u);
  if (cfg_.display_name[0]) {
    char name[32] = {0};
    if (!kl_nvs_get_str("klinto3", "name", name, sizeof(name)) || !name[0]) kl_nvs_set_str("klinto3", "name", cfg_.display_name);
  }
  if (cfg_.role == KL_ROLE_GATEWAY && strlen(KL_WIFI_SSID)) {
    char ssid[64] = {0};
    if (!kl_nvs_get_str("wifi", "ssid", ssid, sizeof(ssid)) || !ssid[0]) {
      kl_nvs_set_str("wifi", "ssid", KL_WIFI_SSID);
      kl_nvs_set_str("wifi", "pass", KL_WIFI_PASS);
    }
  }
  kl_nvs_set_uint("hw", "seed", 1);
  Serial.println("[klinto] hw: settings from build saved to NVS (data volume)");
}

void KlintoNode::loadHw() {
  seedHw();
  {
    const uint32_t ifc = kl_nvs_get_uint("hw", "if", 0);
    if (ifc) {
      cfg_.espnow_enabled = (ifc & 1u) != 0;
#if KL_HAS_LORA
      cfg_.lora_present = (ifc & 2u) != 0;
#else
      cfg_.lora_present = false;
#endif
      cfg_.lora.present = cfg_.lora_present;
    }
    const uint32_t ld = kl_nvs_get_uint("hw", "ld", 0);
    led_pin_ = ld ? (int8_t)((int)ld - 1) : -1;
  }
  const uint32_t bp = kl_nvs_get_uint("hw", "bp", 0);
  if (bp) {
    cfg_.batt_pin = (int8_t)((int)bp - 1);
    cfg_.batt_ratio_x100 = (uint16_t)kl_nvs_get_uint("hw", "br", cfg_.batt_ratio_x100);
  }
  cfg_.espnow_dbm = (int8_t)kl_nvs_get_uint("hw", "ep", 0);
  cfg_.hw_epoch = kl_nvs_get_uint("hw", "ev", 0);
  if (cfg_.lora_present) {
    const uint32_t lc = kl_nvs_get_uint("hw", "lc", 0);
    if (lc) cfg_.lora.chip = (uint8_t)(lc - 1);
    char ls[48] = {0};
    int v[7];
    if (kl_nvs_get_str("hw", "ls", ls, sizeof(ls)) && hw_parse_ints(ls, v, 7)) {
      cfg_.lora.sck = (int8_t)v[0]; cfg_.lora.miso = (int8_t)v[1]; cfg_.lora.mosi = (int8_t)v[2];
      cfg_.lora.cs = (int8_t)v[3]; cfg_.lora.rst = (int8_t)v[4];
      cfg_.lora.dio0 = (int8_t)v[5]; cfg_.lora.dio1 = (int8_t)v[5]; cfg_.lora.busy = (int8_t)v[6];
    }
    const uint32_t lw = kl_nvs_get_uint("hw", "lw", 0);
    if (lw) cfg_.lora.power_dbm = (int8_t)lw;
  }
  const uint32_t rl = kl_nvs_get_uint("hw", "rl", 0);
  if (rl && cfg_.role != KL_ROLE_GATEWAY) cfg_.role = rl == 2 ? KL_ROLE_ROUTER : KL_ROLE_CLIENT;
}

bool KlintoNode::applySignedHw(const char *p, uint32_t epoch, const uint8_t *sig, size_t sig_len) {
  if (!p || !sig || !sig_len || epoch <= cfg_.hw_epoch) {
    Serial.printf("[klinto] hw: rejected (epoch %lu <= %lu or empty)\n", (unsigned long)epoch,
                  (unsigned long)cfg_.hw_epoch);
    return false;
  }
  char canonical[192];
  const int n = snprintf(canonical, sizeof(canonical), "KLINTO-CFG1|%s|%lu|%s", cfg_.ble_mod6,
                         (unsigned long)epoch, p);
  if (n <= 0 || (size_t)n >= sizeof(canonical)) return false;
  uint8_t digest[32];
  kl_sha256(canonical, (size_t)n, digest);
  if (!kl_ota_esp32_verify_pubkey(digest, sig, sig_len)) {
    Serial.println("[klinto] hw: signature rejected");
    return false;
  }
  HwParsed hp;
  if (!hw_parse(p, &hp)) {
    Serial.println("[klinto] hw: bad parameters");
    return false;
  }
  if (hp.has_b) {
    kl_nvs_set_uint("hw", "bp", (uint32_t)(hp.b_pin + 1));
    kl_nvs_set_uint("hw", "br", (uint32_t)hp.b_ratio);
  }
  if (hp.has_c) kl_nvs_set_uint("hw", "lc", (uint32_t)(hp.chip + 1));
  if (hp.has_l) {
    char ls[48];
    snprintf(ls, sizeof(ls), "%d,%d,%d,%d,%d,%d,%d", hp.l[0], hp.l[1], hp.l[2], hp.l[3], hp.l[4],
             hp.l[5], hp.l[6]);
    kl_nvs_set_str("hw", "ls", ls);
  }
  if (hp.has_e) kl_nvs_set_uint("hw", "ep", (uint32_t)hp.e);
  if (hp.has_w) kl_nvs_set_uint("hw", "lw", (uint32_t)hp.w);
  if (hp.has_r) kl_nvs_set_uint("hw", "rl", hp.role ? 2u : 1u);
  if (hp.has_i) kl_nvs_set_uint("hw", "if", (uint32_t)hp.ifc);
  if (hp.has_d) kl_nvs_set_uint("hw", "ld", (uint32_t)(hp.led + 1));
  kl_nvs_set_uint("hw", "ev", epoch);
  cfg_.hw_epoch = epoch;
  Serial.printf("[klinto] hw config applied (epoch %lu): %s — restart\n", (unsigned long)epoch, p);
  restart_at_ms_ = millis() + 1500;
  if (!restart_at_ms_) restart_at_ms_ = 1;
  return true;
}

/* mesh: body = [epoch u32][sig_len u8][sig][p] */
void KlintoNode::onRemoteConfig(void *ctx, const uint8_t *body, size_t len) {
  KlintoNode *self = (KlintoNode *)ctx;
  if (!body || len < 6) return;
  const uint32_t epoch = kl_read_le32(body);
  const size_t sl = body[4];
  if (sl == 0 || sl > 72 || 5 + sl >= len) return;
  char p[128];
  const size_t pl = len - 5 - sl;
  if (pl >= sizeof(p)) return;
  memcpy(p, body + 5 + sl, pl);
  p[pl] = '\0';
  self->applySignedHw(p, epoch, body + 5, sl);
}

void KlintoNode::onConfigJson(const char *json, size_t len) {
  (void)len;
  {
    char p[128] = {0};
    char sighex[160] = {0};
    uint32_t epoch = 0;
    if (kl_json_get_string(json, "hw", p, sizeof(p)) && kl_json_get_string(json, "s", sighex, sizeof(sighex)) &&
        kl_json_get_uint(json, "e", &epoch)) {
      uint8_t sig[80];
      const size_t sl = kl_hex_decode(sighex, strlen(sighex), sig, sizeof(sig));
      if (sl) applySignedHw(p, epoch, sig, sl);
      return;
    }
  }
  char ssid[64] = {0};
  char pass[64] = {0};
  bool changed = false;
  char name[32] = {0};
  if (kl_json_get_string(json, "name", name, sizeof(name)) && name[0]) {
    strncpy(cfg_.display_name, name, sizeof(cfg_.display_name) - 1);
    kl_nvs_set_str("klinto3", "name", cfg_.display_name);
    Serial.printf("[klinto] name=%s\n", cfg_.display_name);
  }
  if (kl_json_get_string(json, "wifiSsid", ssid, sizeof(ssid)) && ssid[0]) {
    kl_nvs_set_str("wifi", "ssid", ssid);
    changed = true;
  }
  if (kl_json_get_string(json, "wifiPassword", pass, sizeof(pass))) {
    kl_nvs_set_str("wifi", "pass", pass);
  }
  if (changed) {
    /* Применяем сразу, не дожидаясь перезагрузки шлюза. */
    WiFi.disconnect(false, false);
    delay(50);
    WiFi.begin(ssid, pass);
    Serial.printf("[klinto] wifi config applied ssid=%s\n", ssid);
  }
}

void KlintoNode::meshTaskEntry(void *arg) {
  KlintoNode *self = (KlintoNode *)arg;
  uint32_t last_tick = 0;
  uint32_t last_ota_tick = 0;
  uint32_t last_stat = 0;
  for (;;) {
    const uint32_t now = kl_uptime_ms();
    if (self->cfg_.espnow_enabled) self->espnow_.poll(now);
    if (self->cfg_.lora_present) self->lora_.poll(now);
    if (now - last_tick >= 10) {
#if KL_HAS_BLE
      self->cell_.set_quiet(self->ble_.connected());
#endif
      self->cell_.tick(now);
      self->router_.tick(now);
      last_tick = now;
    }
    if (now - last_ota_tick >= 100) {
      self->ota_.tick(now);
      last_ota_tick = now;
    }
    /* Раз в 5 с — сводка меша: без неё не видно, слышат ли модули друг друга. */
    if (now - last_stat >= 5000) {
      last_stat = now;
      const kl_router_stats_t *st = self->router_.stats();
      Serial.printf("[mesh] t=%lus ch=%u cell=%u rx=%lu tx=%lu bcn_rx=%lu bcn_tx=%lu gw_age=%ld heap=%u\n",
                    (unsigned long)(now / 1000), (unsigned)self->cell_.channel(),
                    (unsigned)self->cell_.state(), (unsigned long)st->rx_packets,
                    (unsigned long)st->tx_packets, (unsigned long)self->router_.beacons_rx(),
                    (unsigned long)st->beacons_sent, (long)self->router_.gateway_age_ms(now),
                    (unsigned)ESP.getFreeHeap());
      if (self->cfg_.espnow_enabled) {
        Serial.printf("[radio] espnow rx_raw=%lu bad=%lu not_us=%lu tx_ok=%lu tx_err=%lu last_err=%d\n",
                      (unsigned long)self->espnow_.rxRaw(), (unsigned long)self->espnow_.rxMagicBad(),
                      (unsigned long)self->espnow_.rxNotForUs(), (unsigned long)self->espnow_.txOk(),
                      (unsigned long)self->espnow_.txErr(), self->espnow_.lastTxErr());
      }
    }
    /* 30 секунд стабильной работы: подтверждаем OTA-образ и фиксируем build. */
    if (self->ota_pending_) {
      self->otaValidateTick(now);
    } else if (self->boot_valid_ms_ && now - self->boot_valid_ms_ >= 30000u) {
      self->boot_valid_ms_ = 0;
      self->ota_.mark_boot_valid();
      kl_ota_esp32_store_build((uint16_t)KL_FIRMWARE_BUILD);
    }
    if (self->ota_relay_until_ && (int32_t)(now - self->ota_relay_until_) >= 0) {
      self->ota_relay_until_ = 0;
      if (self->ota_.source_active()) self->ota_.stop_source();
      Serial.println("[ota] relay finished");
    }
    /* Перед перезагрузкой после OTA сохраняем конфиг (Wi-Fi, владелец,
     * распиновка/тип) в NVS: OTA пишет только app-раздел, но фиксируем явно. */
    if (self->ota_.state() == KL_OTA_PENDING_REBOOT && !self->ota_config_saved_) {
      self->ota_config_saved_ = true;
      kl_config_save_nvs(&self->cfg_);
      /* После перезагрузки проверим те транспорты, по которым модуль слышал сеть последние 10 минут. */
      uint8_t need = 0;
      for (uint8_t i = 0; i < KL_IFACE_COUNT; ++i) {
        const uint32_t t = self->router_.last_rx_ms(i);
        if (t && now - t < 600000u) need |= (uint8_t)(1u << i);
      }
      kl_ota_esp32_set_need_ifc(need);
      Serial.printf("[ota] rebooting into new firmware, will validate ifc mask=0x%02x\n", (unsigned)need);
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

extern volatile uint32_t g_kl_hub_ok_ms;

/* Новая прошивка подтверждается, только когда модуль снова в кластере по каждому транспорту,
 * который работал до обновления (и шлюз достучался до Hub). Нет связи 10 минут — откат на
 * прошлый слот, сборка помечается сломанной и больше не ставится. */
void KlintoNode::otaValidateTick(uint32_t now) {
  static uint32_t last_log = 0;
  bool ok = now >= 45000u;
  for (uint8_t i = 0; i < KL_IFACE_COUNT; ++i) {
    if (ota_need_ifc_ & (1u << i)) ok = ok && router_.last_rx_ms(i) != 0;
  }
  if (cfg_.role == KL_ROLE_GATEWAY) ok = ok && g_kl_hub_ok_ms != 0;
  if (ok) {
    ota_pending_ = false;
    boot_valid_ms_ = 0;
    ota_.mark_boot_valid();
    kl_ota_esp32_store_build((uint16_t)KL_FIRMWARE_BUILD);
    Serial.printf("[ota] firmware %u validated\n", (unsigned)KL_FIRMWARE_BUILD);
    /* Каскад: обновившийся узел сам раздаёт свой образ соседям того же чипа и варианта. */
    kl_ota_manifest_t m;
    if (cfg_.role != KL_ROLE_GATEWAY && kl_ota_esp32_load_manifest(&m) && kl_ota_manifest_is_full(&m) &&
        m.target_build == (uint16_t)KL_FIRMWARE_BUILD && ota_.start_source(m, KL_OTA_SRC_RUNNING)) {
      ota_relay_until_ = now + 2400000u; /* полный образ раздаётся долго */
      Serial.printf("[ota] relaying build %u to neighbours (ifc mask=0x%02x)\n", (unsigned)m.target_build,
                    (unsigned)m.ifc_mask);
    }
    return;
  }
  if (now - last_log > 30000u) {
    last_log = now;
    Serial.printf("[ota] validating: espnow_rx=%lu lora_rx=%lu hub=%lu\n", (unsigned long)router_.last_rx_ms(KL_IFACE_ESPNOW),
                  (unsigned long)router_.last_rx_ms(KL_IFACE_LORA), (unsigned long)g_kl_hub_ok_ms);
  }
  if (now > 600000u) kl_ota_esp32_rollback_now("no cluster link after update");
}

void KlintoNode::clientTaskEntry(void *arg) {
  KlintoNode *self = (KlintoNode *)arg;
  for (;;) {
#if KL_HAS_BLE
    if (self->ble_.renamePending()) self->ble_.applyPendingRename();
#endif
    self->bridge_.loop(kl_uptime_ms());
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

void KlintoNode::gatewayTaskEntry(void *arg) {
  KlintoNode *self = (KlintoNode *)arg;
  uint32_t next_ota_check = 0;
  uint32_t source_started = 0;
  /* Полный образ (~1.5 МБ) по ESP-NOW раздаётся ~10–15 минут: даём 40, патч — 6. */
  uint32_t source_limit = KL_OTA_SOURCE_ROTATE_MS;
  for (;;) {
    const uint32_t now = kl_uptime_ms();
    self->gateway_.loop(now);

    /* Раздача одного образа не должна длиться вечно: ротация по чипам/вариантам кластера. */
    if (self->ota_.source_active() && source_started && now - source_started > source_limit) {
      self->ota_.stop_source();
      kl_ota_esp32_remote_clear();
      source_started = 0;
      next_ota_check = 0;
    }
    /* Окно чужого образа с Hub (HTTP Range) — только из этой задачи: она не держит радио. */
    kl_ota_esp32_remote_service();

    if (!self->ota_.source_active() && !self->ota_pending_ &&
        (next_ota_check == 0 || now >= next_ota_check)) {
      next_ota_check = now + 120000u;
      const char *url = strncmp(self->cfg_.hub_url, "http", 4) == 0 ? self->cfg_.hub_url
                                                                     : "https://hub.kintoapp.xyz";
      char token[80] = {0};
      if (self->cfg_.module_token[0]) {
        strncpy(token, self->cfg_.module_token, sizeof(token) - 1);
      } else if (self->cfg_.has_temp_key) {
        kl_hex_encode(self->cfg_.temp_mesh_key, 32, token, sizeof(token), false);
      }
      if (token[0]) {
        const uint8_t my_arch = (uint8_t)KL_CHIP_ARCH;
        const char *my_chip = my_arch == 2 ? "esp32c3" : my_arch == 3 ? "esp32s3" : my_arch == 4 ? "esp32c6"
                              : my_arch == 6 ? "esp32c5" : "esp32";
        kl_ota_manifest_t m;
        char path[128];
        bool full = false;
        /* 1) Сначала обновляется сам шлюз (админ включил раздачу для его кластера). */
        if (kl_ota_esp32_query(url, token, my_chip, my_arch, 1, (uint16_t)KL_FIRMWARE_BUILD,
                               self->cfg_.node_id, true, &m, path, sizeof(path), &full) &&
            full && m.target_build > (uint16_t)KL_FIRMWARE_BUILD && m.target_build != kl_ota_esp32_bad_build()) {
          Serial.printf("[ota] gateway self-update %u -> %u (%lu bytes)\n", (unsigned)KL_FIRMWARE_BUILD,
                        (unsigned)m.target_build, (unsigned long)m.patch_size);
          uint8_t need = 0;
          for (uint8_t i = 0; i < KL_IFACE_COUNT; ++i) {
            const uint32_t t = self->router_.last_rx_ms(i);
            if (t && now - t < 600000u) need |= (uint8_t)(1u << i);
          }
          kl_ota_esp32_set_need_ifc(need);
          kl_config_save_nvs(&self->cfg_);
          if (!kl_ota_esp32_install_full(url, token, path, &m)) Serial.println("[ota] gateway self-update failed");
        } else {
          /* 2) Затем узлы кластера: какие (чип, вариант, сборка) нужно обновить. */
          char plan[512];
          if (kl_ota_esp32_plan(url, token, self->cfg_.node_id, plan, sizeof(plan)) > 0) {
            char *save = nullptr;
            for (char *line = strtok_r(plan, "\r\n", &save); line; line = strtok_r(nullptr, "\r\n", &save)) {
              char chip[16] = {0};
              unsigned variant = 0, base = 0;
              if (sscanf(line, "%15[^:]:%u:%u", chip, &variant, &base) != 3 || !base) continue;
              const uint8_t arch = !strcmp(chip, "esp32c3") ? 2 : !strcmp(chip, "esp32s3") ? 3
                                   : !strcmp(chip, "esp32c6") ? 4 : !strcmp(chip, "esp32c5") ? 6
                                   : !strcmp(chip, "esp32") ? 1 : 0;
              if (!arch) continue;
              if (!kl_ota_esp32_query(url, token, chip, arch, (uint8_t)variant, (uint16_t)base, self->cfg_.node_id,
                                      false, &m, path, sizeof(path), &full)) {
                continue;
              }
              bool started = false;
              if (full) {
                kl_ota_esp32_remote_set(url, token, path, m.patch_size);
                started = self->ota_.start_source(m, KL_OTA_SRC_REMOTE);
              } else if (kl_ota_esp32_fetch_patch(url, token, path, m.patch_size)) {
                started = self->ota_.start_source(m, KL_OTA_SRC_FILE);
              }
              if (started) {
                source_started = now;
                source_limit = full ? 2400000u : KL_OTA_SOURCE_ROTATE_MS;
                Serial.printf("[ota] gateway sources %s v%u %u -> %u (%s, %lu bytes, ifc=0x%02x)\n", chip, variant,
                              base, (unsigned)m.target_build, full ? "full" : "patch",
                              (unsigned long)m.patch_size, (unsigned)m.ifc_mask);
                break;
              }
            }
          }
        }
      }
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

#endif  // ESP32
