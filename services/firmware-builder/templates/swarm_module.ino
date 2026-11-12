/* =======================================================================
 *  Kinto module firmware — ESP32 / ESP32-C3 / ESP32-S3.
 *
 *  Единая глобальная mesh-сеть аккаунта. Роли:
 *    wearable  — BLE GATT + USB CDC мост между телефоном/ПК и mesh.
 *    repeater  — только mesh (Wi-Fi и/или LoRa), пересылка пакетов.
 *    gateway   — root Wi-Fi mesh + STA к роутеру + Hub (uplink/downlink).
 *
 *  Шаблон самодостаточен: build-сервис копирует только этот .ino и
 *  сгенерированный config.h. Все параметры из config.h; отсутствующие
 *  макросы закрыты #ifndef-дефолтами, чтобы сборка не падала.
 *
 *  Протокол:
 *    - BLE/USB кадр: A5 5A | ver | type | len u16 LE | payload | crc16.
 *    - Mesh пакет:   24-байтный заголовок + payload (см. MeshHeader).
 *    - LoRa payload  <= 180 байт, Wi-Fi payload <= 1024 байта.
 *
 *  Wi-Fi транспорт:
 *    - по умолчанию используется компилируемый fallback: скрытый AP
 *      (SG_MESH_SSID/PASS) + STA + UDP-флудинг с тем же mesh-заголовком;
 *    - полноценный ESP-WIFI-MESH доступен при SG_USE_ESP_MESH=1
 *      (Arduino core 2.0.17 + esp_mesh.h), по умолчанию выключен, чтобы
 *      гарантировать сборку на всех платах builder-а.
 * ======================================================================= */

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <SPI.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <time.h>
#include <esp_system.h>
#include <esp_random.h>

// config.h должен идти до условных include: в нём роль, транспорт, LoRa.
#include "config.h"

/* ------------------------------------------------------- дефолты конфига -- */

#ifndef SG_FIRMWARE_VERSION
#define SG_FIRMWARE_VERSION "1.0.0"
#endif
#ifndef SG_BOARD
#define SG_BOARD "esp32"
#endif
#ifndef SG_ROLE
#define SG_ROLE "gateway"
#endif
#ifndef SG_CONNECTIVITY
#define SG_CONNECTIVITY "wifi"
#endif
#ifndef SG_WIFI_SSID
#define SG_WIFI_SSID ""
#endif
#ifndef SG_WIFI_PASS
#define SG_WIFI_PASS ""
#endif
#ifndef SG_MESH_SSID
#define SG_MESH_SSID ""
#endif
#ifndef SG_MESH_PASS
#define SG_MESH_PASS ""
#endif
#ifndef SG_MESH_ID
#define SG_MESH_ID ""
#endif
#ifndef SG_MESH_HIDDEN
#define SG_MESH_HIDDEN 1
#endif
#ifndef SG_HUB_URL
#define SG_HUB_URL ""
#endif
#ifndef SG_MODULE_TOKEN
#define SG_MODULE_TOKEN ""
#endif
#ifndef SG_CLAIM_TOKEN
#define SG_CLAIM_TOKEN ""
#endif
#ifndef SG_OTA
#define SG_OTA 0
#endif
#ifndef SG_DEEP_SLEEP
#define SG_DEEP_SLEEP 0
#endif
// Если сервер не выставил SG_USE_LORA, но пины LoRa в config.h есть — включаем.
#if !defined(SG_USE_LORA) && defined(SG_LORA_CS)
#define SG_USE_LORA 1
#endif
#ifndef SG_USE_LORA
#define SG_USE_LORA 0
#endif
#ifndef SG_LORA_CHIP_SX1262
#define SG_LORA_CHIP_SX1262 0
#endif
#ifndef SG_LORA_CHIP
#define SG_LORA_CHIP "sx1278"
#endif

// Жёсткие параметры сети (config.h может их переопределить).
#define SG_DEFAULT_MESH_SSID "SG-MESH"
#define SG_DEFAULT_MESH_PASS "sgmesh-2026-11-11-a7f3c9d2e6b14580"
#define SG_DEFAULT_HUB_URL "http://150.251.143.212:8080"

#ifndef SG_MESH_CHANNEL
#define SG_MESH_CHANNEL 11
#endif
#ifndef SG_LORA_FREQ
#define SG_LORA_FREQ 869.525
#endif
#ifndef SG_LORA_SF
#define SG_LORA_SF 9
#endif
#ifndef SG_LORA_BW
#define SG_LORA_BW 125.0
#endif
#ifndef SG_LORA_CR
#define SG_LORA_CR 5
#endif
#ifndef SG_LORA_SYNC
#define SG_LORA_SYNC 0x12
#endif
#ifndef SG_LORA_POWER
#define SG_LORA_POWER 17
#endif
#ifndef SG_WIFI_MAX_HOPS
#define SG_WIFI_MAX_HOPS 14
#endif
#ifndef SG_LORA_MAX_HOPS
#define SG_LORA_MAX_HOPS 12
#endif

#ifndef SG_LORA_SCK
#define SG_LORA_SCK 4
#endif
#ifndef SG_LORA_MISO
#define SG_LORA_MISO 5
#endif
#ifndef SG_LORA_MOSI
#define SG_LORA_MOSI 6
#endif
#ifndef SG_LORA_CS
#define SG_LORA_CS 7
#endif
#ifndef SG_LORA_RST
#define SG_LORA_RST 3
#endif
#ifndef SG_LORA_DIO0
#define SG_LORA_DIO0 2
#endif
#ifndef SG_LORA_BUSY
#define SG_LORA_BUSY -1
#endif

#ifndef SG_BATT_ENABLED
#define SG_BATT_ENABLED 0
#endif
#ifndef SG_BATT_PIN
#define SG_BATT_PIN 0
#endif
#ifndef SG_BATT_RATIO
#define SG_BATT_RATIO 2.0
#endif
#ifndef SG_BATT_INTERVAL
#define SG_BATT_INTERVAL 300
#endif

// ESP-WIFI-MESH включается только явно (см. шапку файла).
#ifndef SG_USE_ESP_MESH
#define SG_USE_ESP_MESH 0
#endif
#ifndef SG_BLE_ENABLED
#define SG_BLE_ENABLED 1
#endif

/* --------------------------------------------------------- include opt --- */

#if SG_OTA
#include <ArduinoOTA.h>
#include <Update.h>
#include <mbedtls/sha256.h>
#endif

/* --- Mesh v2 core: кластеры, гибридный роутинг, классификатор трафика --- */
#ifndef SG_MESH_V2
#define SG_MESH_V2 1
#endif
#if SG_MESH_V2
#include "beacon_format.h"
#include "cluster_manager.h"
#include "hybrid_router.h"
#include "traffic_classifier.h"
#endif

#if SG_USE_LORA
// Обе библиотеки: чип определяется автоматически при старте.
#include <RadioLib.h>
#include <LoRa.h>
#endif

#if SG_BLE_ENABLED
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#endif

#if SG_USE_ESP_MESH
#include <esp_mesh.h>
#include <esp_wifi.h>
#include <esp_event.h>
#include <esp_netif.h>
#include <nvs_flash.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#else
#include <WiFiUdp.h>
#endif

/* ----------------------------------------------------------- константы --- */

static const uint16_t SG_MESH_UDP_PORT = 45678;
static const uint16_t SG_MAX_PAYLOAD = 1024;       // общий предел payload
static const uint16_t SG_LORA_MAX_PAYLOAD = 180;   // предел LoRa payload
static const size_t   SG_QUEUE_MAX = 200;          // записей в /queue.log
static const uint32_t SG_QUEUE_TTL_SEC = 72UL * 3600UL;
static const uint8_t  SG_BLE_CHUNK = 12;           // 8 байт кадра + 12 = 20 (MTU 23)
static const uint16_t SG_USB_CHUNK = SG_MAX_PAYLOAD;   // USB может принять кадр целиком

static const uint8_t F_MAGIC0 = 0xA5;
static const uint8_t F_MAGIC1 = 0x5A;
static const uint8_t F_VER = 1;

enum FrameType {
  FT_HELLO = 1,
  FT_INFO = 2,
  FT_DATA_UP = 3,
  FT_DATA_DOWN = 4,
  FT_ACK = 5,
  FT_PING = 6,
  FT_PONG = 7,
  FT_STATUS = 8,
  FT_PAIR = 9,
  FT_SET_CONFIG = 10,
};

enum MeshType {
  MT_ADVERT = 1,
  MT_DATA = 2,
  MT_ACK = 3,
  MT_ROUTE_REQ = 4,
  MT_ROUTE_REP = 5,
  MT_PRESENCE = 6,
  MT_FRAG = 7,
};

// LoRa-фрагментация: 150 байт данных × до 16 фрагментов.
static const uint16_t SG_LORA_FRAG_DATA = 150;
static const uint8_t  SG_MAX_FRAGMENTS = 16;
static const uint16_t SG_FRAG_MAX_TOTAL = 24 + SG_MAX_PAYLOAD; // MeshHeader(24) + payload

static const uint32_t MESH_BROADCAST = 0xFFFFFFFFUL;

#pragma pack(push, 1)
struct MeshHeader {
  uint8_t  magic0;
  uint8_t  magic1;
  uint8_t  ver;
  uint8_t  type;
  uint8_t  flags;
  uint8_t  ttl;
  uint8_t  hop;
  uint8_t  reserved;      // выравнивание: заголовок ровно 24 байта
  uint16_t payloadLen;    // LE
  uint32_t src;           // LE
  uint32_t dst;           // LE
  uint32_t packetId;      // LE
  uint16_t crc;           // LE, CRC16-CCITT по заголовку (crc=0) + payload
};
#pragma pack(pop)

static_assert(sizeof(MeshHeader) == 24, "MeshHeader must be 24 bytes");

/* ------------------------------------------------- типы (до функций!) ---- */
// Arduino preprocessor вставляет прототипы функций в начало файла, поэтому
// все типы, встречающиеся в сигнатурах, объявлены до первой функции.

enum QueueKind { QK_MESH = 0, QK_HUB = 1 };

struct QueueEntry {
  uint32_t id;
  uint32_t created;   // epoch sec; старший бит — uptime-маркер
  uint32_t lastTryMs;
  uint8_t  kind;
  uint8_t  tries;
  uint16_t len;
  uint8_t *data;
};

struct NeighborInfo {
  uint32_t id;
  int16_t  rssi;
  uint8_t  load;
  uint8_t  batt;
  bool     gateway;
  bool     used;
  uint32_t lastMs;
  char     role[10];
};

struct RouteEntry {
  uint32_t dst;
  uint32_t nextHop;   // 0xFFFFFFFF = flood
  uint32_t updatedMs;
  bool     used;
};

// Сборка чанкованных кадров BLE/USB.
/** Сборка LoRa-фрагментов (2 параллельных пакета). */
struct FragSlot {
  bool active;
  uint32_t origId;
  uint8_t total;
  uint32_t mask;
  uint16_t len;
  uint32_t lastMs;
  uint8_t data[SG_FRAG_MAX_TOTAL];
};
static FragSlot gFragSlots[2];

struct FrameAssembler {
  uint8_t  type;
  uint16_t total;
  uint16_t got;
  bool     active;
  uint8_t  buf[SG_MAX_PAYLOAD];
};

/* ------------------------------------------------------------- глобалы --- */

static Preferences gPrefs;
static uint32_t gBootMs = 0;
static String gHardwareId;
static String gPublicId;
static uint32_t gNodeId = 0;
static bool gLogEnabled = true;

static int gBattery = 0;
// Wi-Fi роутера для шлюза: можно переопределить из приложения через SET_CONFIG.
static String gRouterSsid;
static String gRouterPass;
static uint32_t gLastBattMs = 0;

// Транспорты.
static bool gWifiReady = false;
static bool gLoraReady = false;
static bool gBleStarted = false;
static bool gBleConnected = false;
static bool gBleRestartAdv = false;
static bool gBleWantInfo = false;
static uint16_t gBleMtu = 23;   // согласованный ATT MTU, обновляется callback-ом
static uint8_t gBleRxBuf[SG_MAX_PAYLOAD + 16];
static size_t gBleRxLen = 0;
static bool gUsbSeen = false;
// USB-клиент начал обмен кадрами: текстовые логи глушим, чтобы не мешать
// бинарному протоколу (до подключения клиента они полезны).
static bool gUsbProtoActive = false;
static uint32_t gLastClientActivityMs = 0;
static String gStatusJson;

// Таймеры.
static uint32_t gLastAdvertMs = 0;
static uint32_t gLastPresenceMs = 0;
static uint32_t gLastCleanupMs = 0;

// Hub.
static String gModuleToken;
static String gHubBase;
static bool gHubAuthRejected = false;
static bool gTimeSyncStarted = false;
static uint32_t gLastRegisterMs = 0;
static uint32_t gRegisterRetryMs = 60000UL;
static uint32_t gLastRelayMs = 0;
static uint32_t gLastPendingMs = 0;
static uint32_t gPendingSince = 0;

// LoRa.
static uint32_t gLastLoraTxMs = 0;
#if SG_USE_LORA
static SX1262 *gRadio = nullptr;
static bool gLoraSx1262 = false;
#endif

// BLE.
#if SG_BLE_ENABLED
static BLEServer *pBleServer = nullptr;
static BLECharacteristic *pBleTx = nullptr;
static BLECharacteristic *pBleRx = nullptr;
static BLECharacteristic *pBleStatus = nullptr;
#endif

// Диагностика транспортов: счётчики видны в USB-логе (раз в 30 секунд).
static uint32_t gUdpRxCount = 0;
static uint32_t gUdpTxCount = 0;
static uint32_t gLoraRxCount = 0;
static uint32_t gLoraTxCount = 0;
static uint32_t gTxCount = 0;
static uint32_t gFwdCount = 0;
static uint32_t gLastFwdLogMs = 0;
static uint32_t gLastDiagMs = 0;

// Wi-Fi UDP fallback.
#if !SG_USE_ESP_MESH
static WiFiUDP gUdp;
static bool gUdpStarted = false;
static uint32_t gLastWifiAttemptMs = 0;
static uint32_t gLastUdpRetryMs = 0;
static bool gStaWasConnected = false;
static uint8_t gApChannel = 0;
static uint32_t gStaDownSinceMs = 0;
static uint32_t gLastScanMs = 0;

// Недавние собеседники: unicast-дубли надёжнее broadcast между STA и AP-хостом
// (broadcast 255.255.255.255 у ESP32 уходит только в STA-интерфейс).
struct PeerIp {
  IPAddress ip;
  uint32_t lastMs;
  bool used;
};
static PeerIp gPeerIps[4];
#endif

/* --------------------------------------------------------- утилиты/лог --- */

static void sgLog(const char *fmt, ...) {
  if (!gLogEnabled) return;
  // На wearable USB CDC несёт бинарные кадры. Логи полезны до подключения
  // клиента; после первого кадра замолкаем, чтобы не мешать протоколу.
  if (gUsbProtoActive && strcmp(SG_ROLE, "wearable") == 0) return;
  char buf[224];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  Serial.println(buf);
}

static bool roleIs(const char *role) {
  return strcmp(SG_ROLE, role) == 0;
}
static bool isWearable() { return roleIs("wearable"); }
static bool isRepeater() { return roleIs("repeater"); }
static bool isGateway()  { return roleIs("gateway"); }

static bool connHas(const char *needle) {
  return strstr(SG_CONNECTIVITY, needle) != nullptr;
}

static bool wifiTransportEnabled() {
  // wifi и wifi_lora -> Wi-Fi; чистый lora -> только радио.
  return strcmp(SG_CONNECTIVITY, "lora") != 0;
}
static bool loraTransportEnabled() {
#if SG_USE_LORA
  // Реагируем на "wifi_lora", "lora", "Wi-Fi + LoRa" и т.п.
  return connHas("lora") || strcmp(SG_CONNECTIVITY, "wifi") != 0;
#else
  return false;
#endif
}

static const char *meshSsid() {
  return strlen(SG_MESH_SSID) ? SG_MESH_SSID : SG_DEFAULT_MESH_SSID;
}
static const char *meshPass() {
  return strlen(SG_MESH_PASS) ? SG_MESH_PASS : SG_DEFAULT_MESH_PASS;
}
static const char *meshIdText() {
  return strlen(SG_MESH_ID) ? SG_MESH_ID : SG_DEFAULT_MESH_SSID;
}
static const char *hubBase() {
  return strlen(SG_HUB_URL) ? SG_HUB_URL : SG_DEFAULT_HUB_URL;
}
static String normalizedHubBase() {
  String base = String(hubBase());
  while (base.endsWith("/")) base.remove(base.length() - 1);
  if (!base.length()) base = SG_DEFAULT_HUB_URL;
  return base;
}

static bool gatewayUp() {
  return isGateway() && WiFi.status() == WL_CONNECTED;
}

static bool attached() {
  return gBleConnected || gUsbSeen;
}

// FNV-1a 32: nodeId и publicId.
static uint32_t fnv1a32(const char *s) {
  uint32_t h = 2166136261UL;
  while (*s) {
    h ^= (uint8_t)(*s++);
    h *= 16777619UL;
  }
  return h;
}

static void initIdentity() {
  // ESP.getEfuseMac() стабилен при перепрошивке и не требует WiFi init.
  uint64_t mac = ESP.getEfuseMac() & 0xFFFFFFFFFFFFULL;
  char buf[32];
  snprintf(buf, sizeof(buf), "esp32-%04lx%08lx",
           (unsigned long)((mac >> 32) & 0xFFFFUL),
           (unsigned long)(mac & 0xFFFFFFFFUL));
  gHardwareId = String(buf);
  gNodeId = fnv1a32(gHardwareId.c_str());
  char pub[12];
  snprintf(pub, sizeof(pub), "%08lu", (unsigned long)(gNodeId % 100000000UL));
  gPublicId = String(pub);
}

static String publicIdForNode(uint32_t id) {
  char pub[12];
  snprintf(pub, sizeof(pub), "%08lu", (unsigned long)(id % 100000000UL));
  return String(pub);
}

static String jsonEsc(const String &s) {
  String out;
  out.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); i++) {
    const char c = s[i];
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (c == '\n') {
      out += "\\n";
    } else if (c == '\r') {
      out += "\\r";
    } else if (c == '\t') {
      out += "\\t";
    } else if ((uint8_t)c >= 0x20) {
      out += c;
    }
  }
  return out;
}

// Простое чтение поля из нашего JSON без парсера (payload не всегда
// null-terminated и может быть большим для LoRa).
static String jsonGetString(const String &src, const char *key) {
  String pat = String("\"") + key + "\":";
  int p = src.indexOf(pat);
  if (p < 0) return String();
  p += pat.length();
  while (p < (int)src.length() && (src[p] == ' ' || src[p] == '\t')) p++;
  if (p >= (int)src.length()) return String();
  if (src[p] == '"') {
    p++;
    String out;
    while (p < (int)src.length()) {
      char c = src[p++];
      if (c == '\\' && p < (int)src.length()) {
        char n = src[p++];
        if (n == 'n') out += '\n';
        else if (n == 'r') out += '\r';
        else if (n == 't') out += '\t';
        else out += n;
      } else if (c == '"') {
        break;
      } else {
        out += c;
      }
    }
    return out;
  }
  int start = p;
  while (p < (int)src.length() && src[p] != ',' && src[p] != '}') p++;
  String out = src.substring(start, p);
  out.trim();
  return out;
}

static long jsonGetInt(const String &src, const char *key) {
  String v = jsonGetString(src, key);
  if (!v.length()) return 0;
  return strtol(v.c_str(), NULL, 10);
}

// Для id/timestamp: unsigned 32-bit, чтобы не терять значения > 2^31.
static uint32_t jsonGetU32(const String &src, const char *key) {
  String v = jsonGetString(src, key);
  if (!v.length()) return 0;
  return (uint32_t)strtoul(v.c_str(), NULL, 10);
}

static String payloadToString(const uint8_t *data, uint16_t len) {
  String s;
  s.reserve(len + 1);
  for (uint16_t i = 0; i < len; i++) s += (char)data[i];
  return s;
}

static uint32_t readLe32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
         ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static void writeLe32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)(v & 0xFF);
  p[1] = (uint8_t)((v >> 8) & 0xFF);
  p[2] = (uint8_t)((v >> 16) & 0xFF);
  p[3] = (uint8_t)((v >> 24) & 0xFF);
}

static uint32_t nextPacketId() {
  uint32_t id = esp_random();
  if (id == 0) id = 1;
  return id;
}

/* ------------------------------------------------------------- CRC16 ----- */

static uint16_t crc16Update(uint16_t crc, const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
  }
  return crc;
}
static uint16_t crc16Ccitt(const uint8_t *data, size_t len) {
  return crc16Update(0xFFFF, data, len);
}

/* ------------------------------------------------------------ очередь ---- */

static QueueEntry gQueue[SG_QUEUE_MAX];
static size_t gQueueCount = 0;
static bool gQueueDirty = false;
static uint32_t gQueueDirtyMs = 0;
static bool gFsReady = false;
static const char *SG_QUEUE_FILE = "/queue.log";
static const char *SG_QUEUE_TMP  = "/queue.tmp";

static bool clockValid() {
  return time(NULL) > 1600000000L;
}
static uint32_t nowEpoch() {
  time_t t = time(NULL);
  return (t > 1600000000L) ? (uint32_t)t : 0;
}
// Если часы не синхронизированы, храним возраст в секундах uptime
// со старшим битом-маркером. После перезагрузки такие записи считаем
// свежими (uptime обнулился).
static uint32_t queueNowStamp() {
  uint32_t e = nowEpoch();
  if (e) return e;
  return 0x80000000UL | (millis() / 1000UL);
}

static void queueMarkDirty() {
  gQueueDirty = true;
  gQueueDirtyMs = millis();
}

static char hexDigit(uint8_t v) {
  return (char)(v < 10 ? ('0' + v) : ('a' + (v - 10)));
}
static int8_t hexVal(char c) {
  if (c >= '0' && c <= '9') return (int8_t)(c - '0');
  if (c >= 'a' && c <= 'f') return (int8_t)(c - 'a' + 10);
  if (c >= 'A' && c <= 'F') return (int8_t)(c - 'A' + 10);
  return -1;
}

// Формат строки: JSON-объект с hex-полем data (JSON lines).
static void queueSave() {
  if (!gFsReady) return;
  File f = LittleFS.open(SG_QUEUE_TMP, "w");
  if (!f) {
    sgLog("[queue] open tmp failed");
    return;
  }
  for (size_t i = 0; i < gQueueCount; i++) {
    QueueEntry &e = gQueue[i];
    f.printf("{\"id\":%lu,\"ts\":%lu,\"kind\":%u,\"tries\":%u,\"len\":%u,\"data\":\"",
             (unsigned long)e.id, (unsigned long)e.created,
             (unsigned)e.kind, (unsigned)e.tries, (unsigned)e.len);
    char hexBuf[66];
    size_t h = 0;
    for (uint16_t j = 0; j < e.len; j++) {
      if (h + 2 >= sizeof(hexBuf)) {
        hexBuf[h] = 0;
        f.print(hexBuf);
        h = 0;
      }
      hexBuf[h++] = hexDigit((uint8_t)(e.data[j] >> 4));
      hexBuf[h++] = hexDigit((uint8_t)(e.data[j] & 0x0F));
    }
    if (h) {
      hexBuf[h] = 0;
      f.print(hexBuf);
    }
    f.print("\"}\n");
  }
  f.close();
  LittleFS.remove(SG_QUEUE_FILE);
  if (!LittleFS.rename(SG_QUEUE_TMP, SG_QUEUE_FILE)) {
    sgLog("[queue] rename failed");
  }
  gQueueDirty = false;
}

static void queueLoad() {
  if (!gFsReady) return;
  File f = LittleFS.open(SG_QUEUE_FILE, "r");
  if (!f) return;
  while (f.available() && gQueueCount < SG_QUEUE_MAX) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (line.length() < 16) continue;

    uint32_t id = jsonGetU32(line, "id");
    uint32_t created = jsonGetU32(line, "ts");
    uint8_t kind = (uint8_t)jsonGetInt(line, "kind");
    uint8_t tries = (uint8_t)jsonGetInt(line, "tries");
    uint16_t len = (uint16_t)jsonGetInt(line, "len");
    if (len > SG_MAX_PAYLOAD) continue;

    String hex = jsonGetString(line, "data");
    if ((size_t)hex.length() < (size_t)len * 2) continue;
    uint8_t *buf = (uint8_t *)malloc(len ? len : 1);
    if (!buf) continue;
    bool ok = true;
    for (uint16_t j = 0; j < len; j++) {
      int8_t hi = hexVal(hex[j * 2]);
      int8_t lo = hexVal(hex[j * 2 + 1]);
      if (hi < 0 || lo < 0) { ok = false; break; }
      buf[j] = (uint8_t)((hi << 4) | lo);
    }
    if (!ok) {
      free(buf);
      continue;
    }
    gQueue[gQueueCount].id = id;
    gQueue[gQueueCount].created = (created & 0x80000000UL)
        ? (0x80000000UL | (millis() / 1000UL))
        : created;
    gQueue[gQueueCount].lastTryMs = 0;
    gQueue[gQueueCount].kind = kind;
    gQueue[gQueueCount].tries = tries;
    gQueue[gQueueCount].len = len;
    gQueue[gQueueCount].data = buf;
    gQueueCount++;
  }
  f.close();
  sgLog("[queue] loaded %u entries", (unsigned)gQueueCount);
}

static void queueRemoveAt(size_t idx) {
  if (idx >= gQueueCount) return;
  free(gQueue[idx].data);
  for (size_t i = idx; i + 1 < gQueueCount; i++) gQueue[i] = gQueue[i + 1];
  gQueueCount--;
  queueMarkDirty();
}

static bool queueRemove(uint32_t id) {
  for (size_t i = 0; i < gQueueCount; i++) {
    if (gQueue[i].id == id) {
      queueRemoveAt(i);
      return true;
    }
  }
  return false;
}

// forcedId != 0 используется для DATA, чтобы ACK мог удалить запись.
static uint32_t queueAdd(const uint8_t *data, uint16_t len, uint8_t kind, uint32_t forcedId) {
  if (len > SG_MAX_PAYLOAD) {
    sgLog("[queue] drop oversized %u", (unsigned)len);
    return 0;
  }
  if (gQueueCount >= SG_QUEUE_MAX) {
    // Переполнение: освобождаем самую старую запись.
    queueRemoveAt(0);
  }
  uint8_t *buf = (uint8_t *)malloc(len ? len : 1);
  if (!buf) {
    sgLog("[queue] oom");
    return 0;
  }
  if (len) memcpy(buf, data, len);
  QueueEntry &e = gQueue[gQueueCount++];
  e.id = forcedId ? forcedId : nextPacketId();
  e.created = queueNowStamp();
  e.lastTryMs = 0;
  e.kind = kind;
  e.tries = 0;
  e.len = len;
  e.data = buf;
  queueMarkDirty();
  return e.id;
}

static QueueEntry *queueFind(uint32_t id) {
  for (size_t i = 0; i < gQueueCount; i++) {
    if (gQueue[i].id == id) return &gQueue[i];
  }
  return NULL;
}

static void queueCleanup() {
  const uint32_t nowS = millis() / 1000UL;
  const uint32_t epoch = nowEpoch();
  for (size_t i = 0; i < gQueueCount;) {
    const uint32_t c = gQueue[i].created;
    bool expired = false;
    if (c & 0x80000000UL) {
      const uint32_t born = c & 0x7FFFFFFFUL;
      if (nowS > born && nowS - born > SG_QUEUE_TTL_SEC) expired = true;
    } else if (c && epoch && epoch > c + SG_QUEUE_TTL_SEC) {
      expired = true;
    }
    if (expired) {
      queueRemoveAt(i);
    } else {
      i++;
    }
  }
}

static uint16_t queueLoadValue() {
  return (uint16_t)gQueueCount;
}

/* --------------------------------------------------------- dedup/маршруты - */

static uint32_t gSeenIds[64];
static uint8_t gSeenIdx = 0;

static bool seenBefore(uint32_t id) {
  for (size_t i = 0; i < 64; i++) {
    if (gSeenIds[i] == id) return true;
  }
  gSeenIds[gSeenIdx] = id;
  gSeenIdx = (uint8_t)((gSeenIdx + 1) % 64);
  return false;
}

static NeighborInfo gNeighbors[8];

static void neighborTouch(uint32_t id, int16_t rssi) {
  if (!id || id == gNodeId) return;
  int slot = -1;
  for (int i = 0; i < 8; i++) {
    if (gNeighbors[i].used && gNeighbors[i].id == id) { slot = i; break; }
    if (!gNeighbors[i].used && slot < 0) slot = i;
  }
  if (slot < 0) slot = 0;   // все заняты — вытесняем первый
  if (!gNeighbors[slot].used || gNeighbors[slot].id != id) {
    memset(&gNeighbors[slot], 0, sizeof(NeighborInfo));
    gNeighbors[slot].used = true;
    gNeighbors[slot].id = id;
    snprintf(gNeighbors[slot].role, sizeof(gNeighbors[slot].role), "%s", "node");
  }
  gNeighbors[slot].rssi = rssi;
  gNeighbors[slot].lastMs = millis();
}

static void neighborUpdateAdvert(uint32_t id, int16_t rssi, const String &json) {
  neighborTouch(id, rssi);
  for (int i = 0; i < 8; i++) {
    if (gNeighbors[i].used && gNeighbors[i].id == id) {
      gNeighbors[i].load = (uint8_t)jsonGetInt(json, "q");
      gNeighbors[i].batt = (uint8_t)jsonGetInt(json, "batt");
      gNeighbors[i].gateway = jsonGetInt(json, "gw") != 0;
      String r = jsonGetString(json, "role");
      if (r.length()) snprintf(gNeighbors[i].role, sizeof(gNeighbors[i].role), "%s", r.c_str());
      break;
    }
  }
  // Диагностика: факт видимости шлюза через mesh (не чаще раза в 5 минут).
  static uint32_t lastGwLogMs = 0;
  if (jsonGetInt(json, "gw") != 0 && millis() - lastGwLogMs > 300000UL) {
    lastGwLogMs = millis();
    sgLog("[mesh] gateway visible id=%08lx rssi=%d", (unsigned long)id, (int)rssi);
  }
}

static uint8_t neighborCount() {
  uint8_t n = 0;
  for (int i = 0; i < 8; i++) {
    if (gNeighbors[i].used && millis() - gNeighbors[i].lastMs < 10UL * 60UL * 1000UL) n++;
  }
  return n;
}

static RouteEntry gRoutes[8];

static void routeLearn(uint32_t dst, uint32_t nextHop) {
  if (!dst || dst == gNodeId) return;
  int slot = -1;
  int oldest = 0;
  for (int i = 0; i < 8; i++) {
    if (gRoutes[i].used && gRoutes[i].dst == dst) { slot = i; break; }
    if (!gRoutes[i].used && slot < 0) slot = i;
    if (gRoutes[i].used && gRoutes[i].updatedMs < gRoutes[oldest].updatedMs) oldest = i;
  }
  if (slot < 0) slot = oldest;
  gRoutes[slot].dst = dst;
  gRoutes[slot].nextHop = nextHop;
  gRoutes[slot].updatedMs = millis();
  gRoutes[slot].used = true;
}

static uint32_t routeLookup(uint32_t dst) {
  for (int i = 0; i < 8; i++) {
    if (gRoutes[i].used && gRoutes[i].dst == dst) {
      // TTL таблицы — 10 минут.
      if (millis() - gRoutes[i].updatedMs > 10UL * 60UL * 1000UL) {
        gRoutes[i].used = false;
        return 0;
      }
      return gRoutes[i].nextHop;
    }
  }
  return 0;
}

/* ----------------------------------------------------------- mesh сборка - */

static size_t meshBuild(uint8_t *out, size_t cap, uint8_t type, uint32_t dst,
                        uint32_t packetId, uint8_t ttl, uint8_t hop,
                        const uint8_t *payload, uint16_t len) {
  if (!out || cap < sizeof(MeshHeader) + (size_t)len || len > SG_MAX_PAYLOAD) return 0;
  MeshHeader h;
  memset(&h, 0, sizeof(h));
  h.magic0 = 0x53;
  h.magic1 = 0x47;
  h.ver = 1;
  h.type = type;
  h.flags = 0;
  h.ttl = ttl;
  h.hop = hop;
  h.reserved = 0;
  h.payloadLen = len;
  h.src = gNodeId;
  h.dst = dst;
  h.packetId = packetId;
  h.crc = 0;
  memcpy(out, &h, sizeof(h));
  if (len) memcpy(out + sizeof(h), payload, len);
  uint16_t crc = crc16Ccitt(out, sizeof(h) + len);
  h.crc = crc;
  memcpy(out, &h, sizeof(h));
  return sizeof(h) + len;
}

static bool meshParse(const uint8_t *buf, size_t n, MeshHeader &h, const uint8_t *&payload) {
  if (n < sizeof(MeshHeader)) return false;
  memcpy(&h, buf, sizeof(h));
  if (h.magic0 != 0x53 || h.magic1 != 0x47 || h.ver != 1) return false;
  if (h.payloadLen > SG_MAX_PAYLOAD) return false;
  if (n < sizeof(MeshHeader) + (size_t)h.payloadLen) return false;

  uint8_t hdr[sizeof(MeshHeader)];
  memcpy(hdr, buf, sizeof(hdr));
  const size_t crcOff = offsetof(MeshHeader, crc);
  hdr[crcOff] = 0;
  hdr[crcOff + 1] = 0;
  uint16_t crc = crc16Ccitt(hdr, sizeof(hdr));
  crc = crc16Update(crc, buf + sizeof(hdr), h.payloadLen);
  if (crc != h.crc) return false;

  payload = buf + sizeof(MeshHeader);
  return true;
}

/* --------------------------------------------------------- transport TX -- */

// Объявления транспортов: transmitPacket может вызываться до их определения.
static bool wifiSendRaw(const uint8_t *buf, size_t len);

#if !SG_USE_ESP_MESH
static bool wifiStartUdp() {
  gUdpStarted = gUdp.begin(SG_MESH_UDP_PORT);
  if (gUdpStarted) {
    sgLog("[udp] listen :%u", (unsigned)SG_MESH_UDP_PORT);
  } else {
    sgLog("[udp] begin :%u failed", (unsigned)SG_MESH_UDP_PORT);
  }
  gLastUdpRetryMs = millis();
  return gUdpStarted;
}

static bool wifiSameIp(const IPAddress &a, const IPAddress &b) {
  return a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3];
}

static void wifiNotePeer(const IPAddress &ip) {
  if (ip[0] == 0) return;
  if (wifiSameIp(ip, WiFi.softAPIP()) || wifiSameIp(ip, WiFi.localIP())) return;

  int freeSlot = -1;
  int oldest = 0;
  for (int i = 0; i < 4; i++) {
    if (gPeerIps[i].used && wifiSameIp(gPeerIps[i].ip, ip)) {
      gPeerIps[i].lastMs = millis();
      return;
    }
    if (!gPeerIps[i].used && freeSlot < 0) freeSlot = i;
    if (gPeerIps[i].used && gPeerIps[i].lastMs < gPeerIps[oldest].lastMs) oldest = i;
  }
  const int slot = (freeSlot >= 0) ? freeSlot : oldest;
  const bool fresh = !gPeerIps[slot].used;
  gPeerIps[slot].ip = ip;
  gPeerIps[slot].lastMs = millis();
  gPeerIps[slot].used = true;
  if (fresh) sgLog("[udp] peer %s", ip.toString().c_str());
}

static bool wifiSendOne(const IPAddress &dst, const uint8_t *buf, size_t len) {
  if (!gUdp.beginPacket(dst, SG_MESH_UDP_PORT)) return false;
  if (gUdp.write(buf, len) != len) {
    gUdp.endPacket();
    return false;
  }
  return gUdp.endPacket() == 1;
}

static bool wifiSendRaw(const uint8_t *buf, size_t len) {
  if (!gWifiReady || !gUdpStarted) return false;

  uint8_t copies = 0;
  const IPAddress bcast(255, 255, 255, 255);
  if (wifiSendOne(bcast, buf, len)) copies++;

  // Broadcast подсети SoftAP: гарантированно уходит в AP-интерфейс
  // (глобальный 255.255.255.255 маршрутизируется только через STA).
  const IPAddress ap = WiFi.softAPIP();
  if (ap[0]) {
    const IPAddress apBcast(ap[0], ap[1], ap[2], 255);
    if (!wifiSameIp(apBcast, bcast) && wifiSendOne(apBcast, buf, len)) copies++;
  }

  // STA-клиент -> хост AP: дублируем unicast на адрес шлюза по STA.
  // Для самого gateway это адрес роутера, поэтому ему unicast не нужен.
  const IPAddress gw = WiFi.gatewayIP();
  if (!isGateway() && gw[0] && !wifiSameIp(gw, WiFi.localIP())) {
    if (wifiSendOne(gw, buf, len)) copies++;
  }

  // Fallback-unicast для собеседников: broadcast между STA и AP-хостом
  // доходит не на всех ядрах, поэтому дублируем unicast (не больше двух
  // адресов, чтобы не плодить трафик).
  const uint32_t now = millis();
  uint8_t unicasts = 0;
  for (int i = 0; i < 4 && unicasts < 2; i++) {
    if (!gPeerIps[i].used) continue;
    if (now - gPeerIps[i].lastMs > 10UL * 60UL * 1000UL) {
      gPeerIps[i].used = false;
      continue;
    }
    const IPAddress peer = gPeerIps[i].ip;
    if (wifiSameIp(peer, bcast)) continue;
    if (gw[0] && wifiSameIp(peer, gw)) continue;   // уже отправлено
    if (wifiSendOne(peer, buf, len)) copies++;
    unicasts++;
  }

  if (copies) {
    gUdpTxCount++;
    return true;
  }
  return false;
}
#endif

#if SG_USE_LORA
static bool loraSendRaw(const uint8_t *buf, size_t len) {
  if (!gLoraReady) return false;
  if (len > (size_t)(sizeof(MeshHeader) + SG_LORA_MAX_PAYLOAD)) return false;
  if (gLoraSx1262) {
    int st = gRadio->transmit((uint8_t *)buf, len);
    if (st != RADIOLIB_ERR_NONE) {
      sgLog("[lora] tx err %d", st);
      return false;
    }
  } else {
    LoRa.beginPacket();
    LoRa.write(buf, len);
    if (LoRa.endPacket() != 1) return false;
  }
  gLoraTxCount++;
  gLastLoraTxMs = millis();
  return true;
}
#endif

static bool transportCanCarry(uint16_t len) {
  if (wifiTransportEnabled() && gWifiReady && len <= SG_MAX_PAYLOAD) return true;
  if (loraTransportEnabled() && gLoraReady && len <= SG_LORA_MAX_PAYLOAD) return true;
  return false;
}

static void handleMeshPacket(const uint8_t *buf, size_t n, bool fromLora, int16_t rssi);

/**
 * Крупный пакет режется на LoRa-фрагменты: [origId u32][index][total][150 Б].
 * WiFi при этом получает пакет целиком; узлы-мосты собирают обе копии.
 */
#if SG_USE_LORA
static bool loraSendFragments(const uint8_t *buf, size_t len) {
  if (len > SG_FRAG_MAX_TOTAL) return false;
  const uint8_t total = (uint8_t)((len + SG_LORA_FRAG_DATA - 1) / SG_LORA_FRAG_DATA);
  if (total == 0 || total > SG_MAX_FRAGMENTS) return false;

  uint32_t origId = 0;
  uint32_t dst = MESH_BROADCAST;
  if (len >= sizeof(MeshHeader)) {
    memcpy(&origId, buf + 18, 4);
    memcpy(&dst, buf + 14, 4);
  }

  for (uint8_t i = 0; i < total; i++) {
    const size_t off = (size_t)i * SG_LORA_FRAG_DATA;
    const uint16_t chunk = (uint16_t)min((size_t)SG_LORA_FRAG_DATA, len - off);
    uint8_t pl[6 + SG_LORA_FRAG_DATA];
    writeLe32(pl, origId);
    pl[4] = i;
    pl[5] = total;
    memcpy(pl + 6, buf + off, chunk);
    uint8_t frag[sizeof(MeshHeader) + sizeof(pl)];
    const uint32_t fragId = origId ^ ((uint32_t)(i + 1) << 24);
    const size_t fn = meshBuild(frag, sizeof(frag), MT_FRAG, dst, fragId,
                                SG_LORA_MAX_HOPS, 0, pl, (uint16_t)(6 + chunk));
    if (!fn || !loraSendRaw(frag, fn)) return false;
  }
  sgLog("[lora] fragmented %u bytes into %u", (unsigned)len, (unsigned)total);
  return true;
}
#endif

/** Приём фрагмента; при полном наборе — обычная обработка пакета. */
static void fragmentFeed(const MeshHeader &h, const uint8_t *payload, int16_t rssi) {
  if (h.payloadLen < 7) return;
  const uint32_t origId = readLe32(payload);
  const uint8_t index = payload[4];
  const uint8_t total = payload[5];
  const uint16_t chunk = (uint16_t)(h.payloadLen - 6);
  if (total == 0 || total > SG_MAX_FRAGMENTS || index >= total) return;

  FragSlot *slot = nullptr;
  for (auto &s : gFragSlots) {
    if (s.active && s.origId == origId) { slot = &s; break; }
  }
  if (!slot) {
    for (auto &s : gFragSlots) {
      if (!s.active) { slot = &s; break; }
    }
    if (!slot) {
      slot = &gFragSlots[0];
      for (auto &s : gFragSlots) {
        if (s.active && s.lastMs < slot->lastMs) slot = &s;
      }
    }
    slot->active = true;
    slot->origId = origId;
    slot->total = total;
    slot->mask = 0;
    slot->len = 0;
    slot->lastMs = millis();
  }
  if (slot->total != total) return;

  const size_t off = (size_t)index * SG_LORA_FRAG_DATA;
  if (off + chunk > sizeof(slot->data)) return;
  memcpy(slot->data + off, payload + 6, chunk);
  if (off + chunk > slot->len) slot->len = (uint16_t)(off + chunk);
  slot->mask |= (uint32_t)1 << index;
  slot->lastMs = millis();

  const uint32_t full = (1UL << total) - 1UL;
  if ((slot->mask & full) == full) {
    uint8_t assembled[SG_FRAG_MAX_TOTAL];
    const uint16_t n = slot->len;
    memcpy(assembled, slot->data, n);
    slot->active = false;
    sgLog("[lora] reassembled %u bytes id=%08lx -> mesh", (unsigned)n,
          (unsigned long)origId);
    // Собранный пакет проходит обычный путь: локальная обработка + ретрансляция
    // в Wi-Fi (и обратно в LoRa, если TTL позволяет).
    handleMeshPacket(assembled, n, true, rssi);
  } else if (slot->mask == ((uint32_t)1 << index)) {
    sgLog("[lora] frag %u/%u id=%08lx %uB", (unsigned)(index + 1),
          (unsigned)total, (unsigned long)origId, (unsigned)chunk);
  }
}


// Отправка готового пакета во все доступные транспорты (bridge).
static bool transmitPacket(const uint8_t *buf, size_t len) {
  bool ok = false;
  bool viaWifi = false;
  bool viaLora = false;
  if (wifiTransportEnabled() && gWifiReady) {
    if (wifiSendRaw(buf, len)) { ok = true; viaWifi = true; }
  }
#if SG_USE_LORA
  if (loraTransportEnabled() && gLoraReady) {
    if (len <= (size_t)(sizeof(MeshHeader) + SG_LORA_MAX_PAYLOAD)) {
      if (loraSendRaw(buf, len)) { ok = true; viaLora = true; }
    } else {
      // Крупный пакет: WiFi уже получил целиком, LoRa — фрагментами.
      if (loraSendFragments(buf, len)) { ok = true; viaLora = true; }
    }
  }
#endif
  if (ok) {
    gTxCount++;
    // Не спамим лог: первые пакеты и далее каждый 50-й.
    if (gTxCount <= 5 || gTxCount % 50 == 0) {
      sgLog("[tx] #%lu %uB wifi=%d lora=%d", (unsigned long)gTxCount,
            (unsigned)len, viaWifi ? 1 : 0, viaLora ? 1 : 0);
    }
  }
  return ok;
}

static bool meshTransmit(uint8_t type, uint32_t dst, const uint8_t *payload,
                         uint16_t len, uint8_t ttl) {
  if (len > SG_MAX_PAYLOAD) return false;
  uint8_t buf[sizeof(MeshHeader) + SG_MAX_PAYLOAD];
  uint32_t id = nextPacketId();
  size_t n = meshBuild(buf, sizeof(buf), type, dst, id, ttl, 0, payload, len);
  if (!n) return false;
  seenBefore(id);   // собственный пакет не должен обрабатываться повторно
  return transmitPacket(buf, n);
}

/* --------------------------------------------------------- локальная обр. */

static void deliverToClients(uint8_t frameType, const uint8_t *payload, uint16_t len);
static void clientFeedFrame(uint8_t type, const uint8_t *payload, uint16_t len);
static bool wifiSendRaw(const uint8_t *buf, size_t len);

static void sendAckTo(uint32_t dst, uint32_t originalId) {
  uint8_t pl[4];
  writeLe32(pl, originalId);
  meshTransmit(MT_ACK, dst, pl, 4, SG_LORA_MAX_HOPS);
}

static String advertPayload() {
  String p = String("{\"id\":") + String((unsigned long)gNodeId) +
             ",\"role\":\"" + SG_ROLE + "\"" +
             ",\"gw\":" + (isGateway() && WiFi.status() == WL_CONNECTED ? 1 : 0) +
             ",\"batt\":" + String(gBattery) +
             ",\"q\":" + String((unsigned)queueLoadValue()) +
             ",\"n\":" + String((unsigned)neighborCount()) + "}";
  return p;
}

static void sendAdvert() {
  String p = advertPayload();
  meshTransmit(MT_ADVERT, MESH_BROADCAST, (const uint8_t *)p.c_str(),
               (uint16_t)p.length(), SG_LORA_MAX_HOPS);
}

static void sendPresence() {
  // Congestion: при load > 120 presence/typing не отправляем.
  if (queueLoadValue() > 120) return;
  String p = String("{\"id\":") + String((unsigned long)gNodeId) +
             ",\"batt\":" + String(gBattery) + "}";
  meshTransmit(MT_PRESENCE, MESH_BROADCAST, (const uint8_t *)p.c_str(),
               (uint16_t)p.length(), 2);
}

static void sendRouteReq(uint32_t dst) {
  uint8_t pl[4];
  writeLe32(pl, dst);
  meshTransmit(MT_ROUTE_REQ, MESH_BROADCAST, pl, 4, SG_LORA_MAX_HOPS);
}

static int hubPostJson(const String &path, const String &body, String &resp, bool auth);

/** API-туннель: шлюз пересылает зашифрованный запрос в Hub и отвечает src. */
static void handleHttpRelay(const String &raw, uint32_t src) {
  if (!isGateway() || !gatewayUp()) return;
  JsonDocument doc;
  if (deserializeJson(doc, raw) != DeserializationError::Ok) return;
  JsonObject env = doc["envelope"].as<JsonObject>();
  if (env.isNull()) return;
  const char *uid = env["userId"] | "";
  const char *did = env["deviceId"] | "";
  const char *blob = env["blob"] | "";
  const char *reqId = env["id"] | "";
  if (!strlen(uid) || !strlen(did) || !strlen(blob)) return;

  String body = String("{\"userId\":\"") + jsonEsc(String(uid)) +
                "\",\"deviceId\":\"" + jsonEsc(String(did)) +
                "\",\"blob\":\"" + jsonEsc(String(blob)) + "\"}";
  String resp;
  int code = hubPostJson("/v1/modules/http", body, resp, true);
  if (code < 200 || code >= 300) {
    sgLog("[http] relay failed %d", code);
    return;
  }
  JsonDocument rd;
  if (deserializeJson(rd, resp) != DeserializationError::Ok) return;
  const char *rblob = rd["blob"] | "";
  if (!strlen(rblob)) return;

  String out = String("{\"chatId\":\"__http__\",\"envelope\":{\"kind\":\"http_resp\",\"id\":\"") +
               jsonEsc(String(reqId)) + "\",\"blob\":\"" + rblob + "\"}}";
  meshTransmit(MT_DATA, src, (const uint8_t *)out.c_str(), (uint16_t)out.length(), SG_LORA_MAX_HOPS);
  sgLog("[http] relay ok %u bytes", (unsigned)out.length());
}

static void handleMeshLocal(const MeshHeader &h, const uint8_t *payload, int16_t rssi) {
  switch (h.type) {
    case MT_DATA: {
      // Специальный канал: зашифрованный API-запрос через шлюз.
      if (h.payloadLen > 8) {
        String raw = payloadToString(payload, h.payloadLen);
        if (raw.indexOf("\"__http__\"") >= 0 && raw.indexOf("\"kind\":\"http\"") >= 0) {
          handleHttpRelay(raw, h.src);
        }
      }
      if (isWearable()) {
        deliverToClients(FT_DATA_DOWN, payload, h.payloadLen);
      }
      if (isGateway() && !isWearable()) {
        // Uplink на Hub. Если интернета нет — запись ждёт в LittleFS.
        queueAdd(payload, h.payloadLen, QK_HUB, h.packetId);
      }
      // ACK: unicast-адресату всегда, broadcast — только при локальной доставке.
      if (h.dst == gNodeId || (h.dst == MESH_BROADCAST && isWearable() && attached())) {
        sendAckTo(h.src, h.packetId);
      }
      break;
    }
    case MT_ACK: {
      if (h.payloadLen >= 4) {
        uint32_t ackId = readLe32(payload);
        if (queueRemove(ackId)) sgLog("[mesh] ack removes %lu", (unsigned long)ackId);
      }
      break;
    }
    case MT_ADVERT: {
      String j = payloadToString(payload, h.payloadLen);
      neighborUpdateAdvert(h.src, rssi, j);
      break;
    }
    case MT_PRESENCE: {
      neighborTouch(h.src, rssi);
      break;
    }
    case MT_ROUTE_REQ: {
      if (h.payloadLen >= 4) {
        uint32_t target = readLe32(payload);
        if (target == gNodeId || routeLookup(target)) {
          uint8_t rep[4];
          writeLe32(rep, target);
          meshTransmit(MT_ROUTE_REP, h.src, rep, 4, SG_LORA_MAX_HOPS);
        }
      }
      break;
    }
    case MT_ROUTE_REP: {
      if (h.payloadLen >= 4) {
        uint32_t target = readLe32(payload);
        routeLearn(target, h.src);
      }
      break;
    }
    default:
      break;
  }
}

static void handleMeshPacket(const uint8_t *buf, size_t n, bool fromLora, int16_t rssi) {
  MeshHeader h;
  const uint8_t *payload = NULL;
  if (!meshParse(buf, n, h, payload)) {
    sgLog("[mesh] bad packet %uB via %s", (unsigned)n, fromLora ? "lora" : "wifi");
    return;
  }
  if (seenBefore(h.packetId)) return;

  neighborTouch(h.src, rssi);
  routeLearn(h.src, MESH_BROADCAST);   // src достижим через flood

  // Первый хоп от соседа: по этим строкам видно, работает ли транспорт.
  if (h.hop == 0 && h.type != MT_PRESENCE) {
    sgLog("[mesh] rx %s type=%u src=%08lx dst=%s len=%u ttl=%u",
          fromLora ? "lora" : "wifi", (unsigned)h.type, (unsigned long)h.src,
          h.dst == MESH_BROADCAST ? "bcast" : "uni", (unsigned)h.payloadLen,
          (unsigned)h.ttl);
  }

  // LoRa-фрагменты: собрать; дальнейшая обработка произойдёт после сборки.
  if (h.type == MT_FRAG) {
    fragmentFeed(h, payload, rssi);
  }

  const bool forMe = (h.dst == gNodeId) || (h.dst == MESH_BROADCAST);
  if (forMe && h.type != MT_FRAG) handleMeshLocal(h, payload, rssi);

  // Ретранслируем broadcast и чужие unicast-пакеты, пока жив TTL.
  // transmitPacket дублирует пакет в WiFi и LoRa — это и есть мост сред.
  if (h.ttl > 0 && (h.dst == MESH_BROADCAST || h.dst != gNodeId)) {
    if (h.dst != MESH_BROADCAST && !routeLookup(h.dst) && h.hop == 0) {
      sendRouteReq(h.dst);
    }
    uint8_t fwd[sizeof(MeshHeader) + SG_MAX_PAYLOAD];
    size_t fn = meshBuild(fwd, sizeof(fwd), h.type, h.dst, h.packetId,
                          (uint8_t)(h.ttl - 1), (uint8_t)(h.hop + 1),
                          payload, h.payloadLen);
    if (fn) {
      gFwdCount++;
      if (millis() - gLastFwdLogMs > 2000UL) {
        gLastFwdLogMs = millis();
        sgLog("[mesh] fwd %s->all type=%u hop=%u ttl=%u (n=%lu)",
              fromLora ? "lora" : "wifi", (unsigned)h.type,
              (unsigned)(h.hop + 1), (unsigned)(h.ttl - 1),
              (unsigned long)gFwdCount);
      }
      transmitPacket(fwd, fn);
    }
  }
}

/* --------------------------------------------------------- очередь pump -- */

static void sendQueuedEntry(QueueEntry &e);

static void meshPumpQueue() {
  if (!gQueueCount) return;
  const uint32_t now = millis();
  uint8_t sent = 0;
  size_t i = 0;
  while (i < gQueueCount && sent < 2) {
    QueueEntry &e = gQueue[i];
    if (e.kind != QK_MESH) {
      i++;
      continue;
    }
    // Broadcast без ACK (wearable не в сети) не должен жить в очереди вечно.
    if (e.tries >= 120) {
      sgLog("[mesh] queue drop id=%08lx tries=%u (no ack)", (unsigned long)e.id, (unsigned)e.tries);
      queueRemoveAt(i);
      continue;
    }
    if (e.tries && now - e.lastTryMs < 4000UL) {
      i++;
      continue;
    }
    if (!transportCanCarry(e.len)) {
      i++;
      continue;
    }
    sendQueuedEntry(e);
    e.lastTryMs = now;
    if (e.tries < 255) e.tries++;
    sent++;
    i++;
  }
}

static void sendQueuedEntry(QueueEntry &e) {
  uint8_t buf[sizeof(MeshHeader) + SG_MAX_PAYLOAD];
  // Downlink обязан быть broadcast: у wearable может ещё не быть маршрута
  // до gateway, и unicast-пакет с чужим dst он не примет.
  size_t n = meshBuild(buf, sizeof(buf), MT_DATA, MESH_BROADCAST, e.id,
                       SG_LORA_MAX_HOPS, 0, e.data, e.len);
  if (!n) return;
  seenBefore(e.id);   // не обрабатывать собственный пакет при эхе
  const bool ok = transmitPacket(buf, n);
  if (e.tries == 0 || e.tries == 3 || e.tries % 10 == 0) {
    sgLog("[mesh] queue tx id=%08lx kind=%u len=%u try=%u dst=bcast %s",
          (unsigned long)e.id, (unsigned)e.kind, (unsigned)e.len,
          (unsigned)e.tries, ok ? "ok" : "pending");
  }
}

/* ------------------------------------------------------------ BLE GATT --- */

// Сборка чанкованных кадров. Используется и BLE, и USB.
static FrameAssembler gBleAsm;
static FrameAssembler gUsbAsm;

static void asmReset(FrameAssembler &a) {
  a.active = false;
  a.got = 0;
  a.total = 0;
}

// BLE-колбэк работает в отдельной задаче: готовый кадр складываем в inbox,
// а разбираем в loop(), чтобы не трогать очередь из BLE-стека.
static uint8_t gBleInboxBuf[SG_MAX_PAYLOAD];
static volatile uint16_t gBleInboxLen = 0;
static volatile uint8_t gBleInboxType = 0;
static volatile bool gBleInboxReady = false;
static volatile bool gBleInboxBusy = false;

static void asmFeed(FrameAssembler &a, uint8_t type, const uint8_t *payload,
                    uint16_t len, bool defer) {
  if (!a.active) {
    a.active = true;
    a.type = type;
    a.total = len;
    a.got = 0;
  }
  if (a.total > SG_MAX_PAYLOAD || a.got + len > SG_MAX_PAYLOAD) {
    asmReset(a);
    return;
  }
  if (len) memcpy(a.buf + a.got, payload, len);
  a.got = (uint16_t)(a.got + len);
  if (a.got >= a.total) {
    if (defer) {
      if (!gBleInboxReady && !gBleInboxBusy) {
        gBleInboxLen = a.got;
        gBleInboxType = a.type;
        if (a.got) memcpy(gBleInboxBuf, a.buf, a.got);
        gBleInboxReady = true;
      }
    } else {
      clientFeedFrame(a.type, a.buf, a.got);
    }
    asmReset(a);
  }
}

static void clientInboxPoll() {
  if (!gBleInboxReady) return;
  gBleInboxBusy = true;
  gBleInboxReady = false;
  uint8_t type = gBleInboxType;
  uint16_t len = gBleInboxLen;
  clientFeedFrame(type, gBleInboxBuf, len);
  gBleInboxBusy = false;
}

#if SG_BLE_ENABLED

// JIT-буфер для нарезки кадра. len — полная длина payload (повторяется
// в каждом чанке, чтобы принимающая сторона знала общий размер).
static size_t buildFrame(uint8_t *out, size_t cap, uint8_t type,
                         const uint8_t *payload, uint16_t totalLen,
                         uint16_t offset, uint16_t chunk) {
  // Если кадр не влезает в один notification — шлём фрагменты с явным
  // смещением и полной длиной: [offset u16][total u16][chunk...].
  // Старший бит типа помечает фрагмент, чтобы клиент собрал payload.
  const bool frag = offset != 0 || chunk != totalLen;
  const uint16_t plen = frag ? (uint16_t)(chunk + 4) : chunk;
  size_t need = 6 + (size_t)plen + 2;
  if (cap < need) return 0;
  out[0] = F_MAGIC0;
  out[1] = F_MAGIC1;
  out[2] = F_VER;
  out[3] = frag ? (uint8_t)(type | 0x80) : type;
  out[4] = (uint8_t)(plen & 0xFF);
  out[5] = (uint8_t)((plen >> 8) & 0xFF);
  if (frag) {
    out[6] = (uint8_t)(offset & 0xFF);
    out[7] = (uint8_t)((offset >> 8) & 0xFF);
    out[8] = (uint8_t)(totalLen & 0xFF);
    out[9] = (uint8_t)((totalLen >> 8) & 0xFF);
    if (chunk) memcpy(out + 10, payload + offset, chunk);
  } else if (chunk) {
    memcpy(out + 6, payload + offset, chunk);
  }
  uint16_t crc = crc16Ccitt(out + 2, 4 + plen);
  out[6 + plen] = (uint8_t)(crc & 0xFF);
  out[7 + plen] = (uint8_t)((crc >> 8) & 0xFF);
  return need;
}

static void bleSendFrame(uint8_t type, const uint8_t *payload, uint16_t len) {
  if (!gBleConnected || !pBleRx) return;
  uint8_t frame[6 + SG_MAX_PAYLOAD + 8];
  // В фрагменте 4 байта служебного заголовка; notification ≤ MTU-3.
  uint16_t chunkMax = 8;
  if (gBleMtu > 23) {
    uint16_t c = (uint16_t)(gBleMtu - 3 - 6 - 4 - 2);
    if (c > chunkMax) chunkMax = c;
    if (chunkMax > SG_BLE_CHUNK) chunkMax = SG_BLE_CHUNK;
  }
  uint16_t off = 0;
  do {
    uint16_t chunk = (uint16_t)(len - off);
    if (chunk > chunkMax) chunk = chunkMax;
    size_t n = buildFrame(frame, sizeof(frame), type, payload, len, off, chunk);
    if (!n) break;
    pBleRx->setValue(frame, n);
    pBleRx->notify();
    off = (uint16_t)(off + chunk);
    delay(4);   // небольшой зазор между notifications
  } while (off < len);
}

class SgBleWriteCb : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *ch) {
    // BLE-стек отдаёт запись кусками (20 байт при MTU 23), поэтому кадр
    // нельзя парсить внутри одного onWrite — копим поток и режем по magic.
    // Важно: getValue() возвращает String с бинарными данными; копируем
    // объект целиком, а не через c_str() — иначе кадр обрежется на 0x00.
    String raw = ch->getValue();
    if (!raw.length()) return;
    const uint8_t *p = (const uint8_t *)raw.c_str();
    size_t n = raw.length();
    for (size_t i = 0; i < n; i++) {
      if (gBleRxLen < sizeof(gBleRxBuf)) {
        gBleRxBuf[gBleRxLen++] = p[i];
      } else {
        gBleRxLen = 0;   // переполнение — сброс
      }
    }

    size_t pos = 0;
    while (gBleRxLen - pos >= 8) {
      if (gBleRxBuf[pos] != F_MAGIC0 || gBleRxBuf[pos + 1] != F_MAGIC1) { pos++; continue; }
      uint16_t len = (uint16_t)gBleRxBuf[pos + 4] | ((uint16_t)gBleRxBuf[pos + 5] << 8);
      if (len > SG_MAX_PAYLOAD) { pos += 2; continue; }
      size_t need = 6 + (size_t)len + 2;
      if (gBleRxLen - pos < need) break;
      uint16_t crc = crc16Ccitt(gBleRxBuf + pos + 2, 4 + len);
      uint16_t got = (uint16_t)gBleRxBuf[pos + 6 + len] | ((uint16_t)gBleRxBuf[pos + 7 + len] << 8);
      if (crc == got) {
        asmFeed(gBleAsm, gBleRxBuf[pos + 3], gBleRxBuf + pos + 6, len, true);
        pos += need;
      } else {
        pos++;
      }
    }
    if (pos) {
      memmove(gBleRxBuf, gBleRxBuf + pos, gBleRxLen - pos);
      gBleRxLen -= pos;
    }
    gLastClientActivityMs = millis();
  }
};

class SgBleServerCb : public BLEServerCallbacks {
  void onConnect(BLEServer *srv) {
    (void)srv;
    gBleConnected = true;
    gBleWantInfo = true;
    gLastClientActivityMs = millis();
    sgLog("[ble] client connected");
  }
  void onDisconnect(BLEServer *srv) {
    (void)srv;
    gBleConnected = false;
    gBleRestartAdv = true;
    gBleMtu = 23;
    sgLog("[ble] client disconnected");
  }
  // MTU не переопределяем: API onMtuChanged отличается между ESP32/C3/S3.
  // Работаем с безопасным MTU 23 и чанками 12 байт; телефон может поднять MTU,
  // но прошивка продолжит слать совместимыми чанками.
};

static void setupBle() {
  if (!isWearable()) return;
  String name = String("SG-") + gPublicId;
  BLEDevice::init(name.c_str());
  BLEDevice::setMTU(247);   // клиент может запросить больший MTU
  pBleServer = BLEDevice::createServer();
  pBleServer->setCallbacks(new SgBleServerCb());

  BLEService *svc = pBleServer->createService(BLEUUID("a5c0"));

  pBleTx = svc->createCharacteristic(
      BLEUUID("a5c1"),
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  pBleTx->setCallbacks(new SgBleWriteCb());

  pBleRx = svc->createCharacteristic(
      BLEUUID("a5c2"),
      BLECharacteristic::PROPERTY_NOTIFY);
  pBleRx->addDescriptor(new BLE2902());

  pBleStatus = svc->createCharacteristic(
      BLEUUID("a5c3"),
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  pBleStatus->addDescriptor(new BLE2902());
  pBleStatus->setValue("{}");

  svc->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLEUUID("a5c0"));
  adv->setScanResponse(true);
  adv->start();

  gBleStarted = true;
  sgLog("[ble] gatt started as %s", name.c_str());
}

static void bleLoop() {
  if (!gBleStarted) return;
  if (gBleRestartAdv) {
    gBleRestartAdv = false;
    delay(200);
    BLEDevice::startAdvertising();
  }
  if (gBleWantInfo && gBleConnected && pBleStatus) {
    gBleWantInfo = false;
    pBleStatus->setValue(gStatusJson.c_str());
    pBleStatus->notify();
  }
}
#else
static void setupBle() {}
static void bleLoop() {}
static void bleSendFrame(uint8_t, const uint8_t *, uint16_t) {}
#endif

/* ------------------------------------------------------------- USB CDC --- */

static void usbSendFrame(uint8_t type, const uint8_t *payload, uint16_t len) {
  if (!isWearable()) return;
  uint8_t frame[6 + SG_MAX_PAYLOAD + 2];
  uint16_t off = 0;
  do {
    uint16_t chunk = (uint16_t)(len - off);
    if (chunk > SG_USB_CHUNK) chunk = SG_USB_CHUNK;
    size_t n;
    {
      size_t need = 6 + (size_t)chunk + 2;
      if (need > sizeof(frame)) break;
      frame[0] = F_MAGIC0;
      frame[1] = F_MAGIC1;
      frame[2] = F_VER;
      frame[3] = type;
      frame[4] = (uint8_t)(len & 0xFF);
      frame[5] = (uint8_t)((len >> 8) & 0xFF);
      if (chunk) memcpy(frame + 6, payload + off, chunk);
      uint16_t crc = crc16Ccitt(frame + 2, 4 + chunk);
      frame[6 + chunk] = (uint8_t)(crc & 0xFF);
      frame[7 + chunk] = (uint8_t)((crc >> 8) & 0xFF);
      n = need;
    }
    Serial.write(frame, n);
    off = (uint16_t)(off + chunk);
  } while (off < len);
}

static void deliverToClients(uint8_t frameType, const uint8_t *payload, uint16_t len) {
  if (!isWearable()) return;
  bleSendFrame(frameType, payload, len);
  usbSendFrame(frameType, payload, len);
  gLastClientActivityMs = millis();
}

// USB-парсер: байтовый поток, ресинхронизация по magic.
static uint8_t gUsbBuf[SG_MAX_PAYLOAD + 16];
static size_t gUsbLen = 0;

static void usbPoll() {
  if (!isWearable()) return;
  while (Serial.available() > 0) {
    int c = Serial.read();
    if (c < 0) break;
    if (gUsbLen < sizeof(gUsbBuf)) {
      gUsbBuf[gUsbLen++] = (uint8_t)c;
    } else {
      gUsbLen = 0;   // переполнение — сброс
    }
  }

  size_t pos = 0;
  while (gUsbLen - pos >= 8) {
    if (gUsbBuf[pos] != F_MAGIC0 || gUsbBuf[pos + 1] != F_MAGIC1) {
      pos++;
      continue;
    }
    uint16_t len = (uint16_t)gUsbBuf[pos + 4] | ((uint16_t)gUsbBuf[pos + 5] << 8);
    if (len > SG_MAX_PAYLOAD) {
      pos += 2;
      continue;
    }
    size_t need = 6 + (size_t)len + 2;
    if (gUsbLen - pos < need) break;
    uint16_t crc = crc16Ccitt(gUsbBuf + pos + 2, 4 + len);
    uint16_t got = (uint16_t)gUsbBuf[pos + 6 + len] | ((uint16_t)gUsbBuf[pos + 7 + len] << 8);
    if (crc == got) {
      if (!gUsbProtoActive) {
        sgLog("[usb] client frame -> serial logs muted");
        gUsbProtoActive = true;
      }
      gUsbSeen = true;
      gLastClientActivityMs = millis();
      asmFeed(gUsbAsm, gUsbBuf[pos + 3], gUsbBuf + pos + 6, len, false);
      pos += need;
    } else {
      pos++;
    }
  }
  if (pos) {
    memmove(gUsbBuf, gUsbBuf + pos, gUsbLen - pos);
    gUsbLen -= pos;
  }
}

/* -------------------------------------------------------- client frames -- */

static bool anyGatewayNeighbor() {
  for (int i = 0; i < 8; i++) {
    if (!gNeighbors[i].used || !gNeighbors[i].gateway) continue;
    if (millis() - gNeighbors[i].lastMs < 10UL * 60UL * 1000UL) return true;
  }
  return false;
}

static String buildInfoJson() {
  const bool gw = (isGateway() && WiFi.status() == WL_CONNECTED) || anyGatewayNeighbor();
  String j = String("{\"hardwareId\":\"") + gHardwareId +
             "\",\"publicId\":\"" + gPublicId +
             "\",\"role\":\"" + SG_ROLE +
             "\",\"firmware\":\"" SG_FIRMWARE_VERSION
             "\",\"battery\":" + String(gBattery) +
             ",\"attached\":" + String(attached() ? 1 : 0) +
             ",\"gateway\":" + String(gw ? 1 : 0) +
             ",\"queue\":" + String((unsigned)queueLoadValue()) +
             ",\"rssi\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0) + "}";
  return j;
}

static void sendInfoToClient() {
  String j = buildInfoJson();
  gStatusJson = j;
#if SG_BLE_ENABLED
  if (pBleStatus) pBleStatus->setValue(gStatusJson.c_str());
#endif
  deliverToClients(FT_INFO, (const uint8_t *)j.c_str(), (uint16_t)j.length());
  sgLog("[client] INFO sent");
}

static void handleClientDataUp(const uint8_t *payload, uint16_t len) {
  if (!len) return;

  // Congestion: при load > 170 пропускаем только крупные (медиа) пакеты.
  if (queueLoadValue() > 170 && len > 200) {
    const char *err = "{\"error\":\"busy\"}";
    deliverToClients(FT_STATUS, (const uint8_t *)err, (uint16_t)strlen(err));
    return;
  }
  if (!transportCanCarry(len)) {
    sgLog("[client] payload %u cannot be carried", (unsigned)len);
    const char *err = "{\"error\":\"too_large\"}";
    deliverToClients(FT_STATUS, (const uint8_t *)err, (uint16_t)strlen(err));
    return;
  }

  uint32_t id = queueAdd(payload, len, QK_MESH, 0);
  if (!id) return;

  QueueEntry *e = queueFind(id);
  if (e) {
    sendQueuedEntry(*e);
    e->lastTryMs = millis();
    if (e->tries < 255) e->tries++;
  }

  uint8_t ack[4];
  writeLe32(ack, id);
  deliverToClients(FT_ACK, ack, 4);
}

static void clientFeedFrame(uint8_t type, const uint8_t *payload, uint16_t len) {
  gLastClientActivityMs = millis();
  switch (type) {
    case FT_HELLO:
    case FT_INFO:
    case FT_STATUS:
      sendInfoToClient();
      break;
    case FT_DATA_UP:
      handleClientDataUp(payload, len);
      break;
    case FT_PING: {
      uint8_t pong[4] = {0, 0, 0, 0};
      deliverToClients(FT_PONG, pong, 4);
      break;
    }
    case FT_PAIR: {
      const char *ok = "{\"ok\":true}";
      deliverToClients(FT_ACK, (const uint8_t *)ok, (uint16_t)strlen(ok));
      break;
    }
    case FT_SET_CONFIG: {
      // {v:1,kind:"config",wifiSsid:"...",wifiPassword:"..."}
      String j = payloadToString(payload, len);
      String ssid = jsonGetString(j, "wifiSsid");
      String pass = jsonGetString(j, "wifiPassword");
      if (!ssid.length()) {
        const char *err = "{\"ok\":false,\"error\":\"ssid_required\"}";
        deliverToClients(FT_ACK, (const uint8_t *)err, (uint16_t)strlen(err));
        break;
      }
      gRouterSsid = ssid;
      gRouterPass = pass;
      gPrefs.begin("swarm", false);
      gPrefs.putString("wifi_ssid", gRouterSsid);
      gPrefs.putString("wifi_pass", gRouterPass);
      gPrefs.end();
      sgLog("[config] router ssid=%s", gRouterSsid.c_str());
      if (isGateway()) {
        WiFi.disconnect(false, false);
        delay(50);
        WiFi.begin(gRouterSsid.c_str(), gRouterPass.c_str());
      }
      const char *ok = "{\"ok\":true}";
      deliverToClients(FT_ACK, (const uint8_t *)ok, (uint16_t)strlen(ok));
      break;
    }
    case FT_ACK:
      // ACK от клиента: подтверждение получения DATA_DOWN.
      break;
    default:
      break;
  }
}

/* --------------------------------------------------------------- LoRa ---- */

#if SG_USE_LORA
static bool loraTrySx1262() {
  SPI.begin(SG_LORA_SCK, SG_LORA_MISO, SG_LORA_MOSI, SG_LORA_CS);
#if SG_LORA_BUSY >= 0
  gRadio = new SX1262(new Module(SG_LORA_CS, SG_LORA_DIO0, SG_LORA_RST, SG_LORA_BUSY));
#else
  gRadio = new SX1262(new Module(SG_LORA_CS, SG_LORA_DIO0, SG_LORA_RST));
#endif
  int state = gRadio->begin((float)SG_LORA_FREQ, (float)SG_LORA_BW,
                            (int)SG_LORA_SF, (int)SG_LORA_CR,
                            (uint8_t)SG_LORA_SYNC, (int)SG_LORA_POWER, 8);
  if (state != RADIOLIB_ERR_NONE) {
    sgLog("[lora] SX1262 init failed %d", state);
    delete gRadio;
    gRadio = nullptr;
    return false;
  }
  gLoraSx1262 = true;
  return true;
}

static bool loraTrySx127x() {
  LoRa.setPins(SG_LORA_CS, SG_LORA_RST, SG_LORA_DIO0);
  if (!LoRa.begin((long)((double)SG_LORA_FREQ * 1000000.0))) {
    sgLog("[lora] SX127x init failed");
    return false;
  }
  LoRa.setSpreadingFactor((int)SG_LORA_SF);
  LoRa.setSignalBandwidth((long)((double)SG_LORA_BW * 1000.0));
  LoRa.setCodingRate4((int)SG_LORA_CR);
  LoRa.setSyncWord((uint8_t)SG_LORA_SYNC);
  LoRa.setTxPower((int)SG_LORA_POWER);
  gLoraSx1262 = false;
  return true;
}
#endif

static void setupLora() {
#if SG_USE_LORA
  if (!loraTransportEnabled()) {
    sgLog("[lora] disabled (conn=%s)", SG_CONNECTIVITY);
    return;
  }
#if SG_LORA_CHIP_SX1262
  bool ok = loraTrySx1262() || loraTrySx127x();
#else
  bool ok = loraTrySx127x() || loraTrySx1262();
#endif
  if (!ok) {
    sgLog("[lora] no radio detected (pins cs=%d rst=%d dio0=%d)", SG_LORA_CS, SG_LORA_RST, SG_LORA_DIO0);
    return;
  }
  gLoraReady = true;
  sgLog("[lora] %s ready %0.3f MHz SF%d", gLoraSx1262 ? "SX1262" : "SX127x",
        (double)SG_LORA_FREQ, (int)SG_LORA_SF);
#endif
}

static void loraPoll() {
#if SG_USE_LORA
  if (!gLoraReady) return;
  if (gLoraSx1262) {
  size_t avail = gRadio->available();
  if (avail > 0) {
    uint8_t buf[sizeof(MeshHeader) + SG_MAX_PAYLOAD];
    if (avail > sizeof(buf)) avail = sizeof(buf);
    int st = gRadio->readData(buf, avail);
    if (st == RADIOLIB_ERR_NONE) {
      int16_t rssi = (int16_t)gRadio->getRSSI();
      gLoraRxCount++;
      sgLog("[lora] rx #%lu %uB rssi=%d", (unsigned long)gLoraRxCount,
            (unsigned)avail, (int)rssi);
      handleMeshPacket(buf, avail, true, rssi);
    } else {
      sgLog("[lora] rx err %d", st);
    }
  }
  } else {
  int packetSize = LoRa.parsePacket();
  if (packetSize > 0) {
    uint8_t buf[sizeof(MeshHeader) + SG_MAX_PAYLOAD];
    size_t n = 0;
    while (LoRa.available() && n < sizeof(buf)) buf[n++] = (uint8_t)LoRa.read();
    const int16_t rssi = (int16_t)LoRa.packetRssi();
    gLoraRxCount++;
    if (gLoraRxCount <= 5 || gLoraRxCount % 20 == 0) {
      sgLog("[lora] rx #%lu %uB rssi=%d", (unsigned long)gLoraRxCount,
            (unsigned)n, (int)rssi);
    }
    handleMeshPacket(buf, n, true, rssi);
  }
  }
#endif
#endif
}

/* ---------------------------------------------------- Wi-Fi mesh (UDP) --- */

#if !SG_USE_ESP_MESH
// SoftAP не должен «теряться» в режиме AP_STA: если режим сбросился,
// поднимаем точку доступа заново на текущем канале.
static void wifiEnsureAp() {
  const wifi_mode_t mode = (wifi_mode_t)WiFi.getMode();
  const IPAddress apip = WiFi.softAPIP();
  if ((mode & WIFI_AP) && apip[0] != 0) return;
  // Не дёргаем softAP в первые 15 секунд: DHCP/netif могут ещё подниматься.
  if (millis() - gBootMs < 15000UL) return;
  const uint8_t ch = gApChannel ? gApChannel : (uint8_t)SG_MESH_CHANNEL;
  sgLog("[wifi] softAP not running (mode=%d ip=%s) -> restart ch%u",
        (int)mode, apip.toString().c_str(), (unsigned)ch);
  WiFi.mode(WIFI_AP_STA);
  if (!WiFi.softAP(meshSsid(), meshPass(), ch, SG_MESH_HIDDEN ? 1 : 0, 4)) {
    sgLog("[wifi] softAP restart failed");
  }
}

static void ensureWifiLink() {
  const uint32_t now = millis();

  // UDP-сокет мог не открыться на старте (netif ещё не готов) — пробуем снова.
  if (!gUdpStarted && now - gLastUdpRetryMs > 5000UL) wifiStartUdp();

  wifiEnsureAp();

  if (WiFi.status() == WL_CONNECTED) {
    gStaDownSinceMs = 0;
    const uint8_t ch = (uint8_t)WiFi.channel();
    if (!gStaWasConnected) {
      gStaWasConnected = true;
      gApChannel = ch;
      sgLog("[wifi] sta connected ip=%s gw=%s ch=%u rssi=%d",
            WiFi.localIP().toString().c_str(),
            WiFi.gatewayIP().toString().c_str(), (unsigned)ch, (int)WiFi.RSSI());
      if (isGateway() && !gTimeSyncStarted) {
        configTime(0, 0, "pool.ntp.org");
        gTimeSyncStarted = true;
      }
      // Диагностика: если подсеть AP совпала с подсетью роутера, AP-клиенты
      // будут недостижимы (конфликт маршрутов). Прошивка это не «лечит»,
      // но строка делает причину очевидной.
      {
        const IPAddress lip = WiFi.localIP();
        const IPAddress apip = WiFi.softAPIP();
        if (lip[0] && apip[0] && lip[0] == apip[0] && lip[1] == apip[1] &&
            lip[2] == apip[2]) {
          sgLog("[wifi] WARN subnet collision sta=%s ap=%s",
                lip.toString().c_str(), apip.toString().c_str());
        }
      }
      gLastRegisterMs = millis() - 60000UL;   // сразу checkin после появления сети
      // После подключения к роутеру канал AP мог измениться — сразу
      // объявляемся, чтобы клиенты mesh нашли шлюз на новом канале.
      sendAdvert();
      gLastAdvertMs = millis();
    } else if (ch && ch != gApChannel) {
      // В AP+STA канал AP следует за STA; mesh-клиенты переподключаются сами.
      sgLog("[wifi] channel %u -> %u (AP follows STA), clients=%d",
            (unsigned)gApChannel, (unsigned)ch, (int)WiFi.softAPgetStationNum());
      gApChannel = ch;
      sendAdvert();
      gLastAdvertMs = millis();
    }
    return;
  }

  if (gStaWasConnected) {
    gStaWasConnected = false;
    sgLog("[wifi] sta disconnected (ap clients=%d)", (int)WiFi.softAPgetStationNum());
  }
  if (!gStaDownSinceMs) gStaDownSinceMs = now;
  if (now - gLastWifiAttemptMs < 15000UL) return;
  gLastWifiAttemptMs = now;

  // Долго не можем подключиться к mesh: сканируем эфир (включая скрытые AP)
  // и цепляемся к самому сильному узлу по BSSID+каналу. Спасает, когда
  // скрытый SSID и/или канал AP не совпадают с ожидаемым.
  if (!isGateway() && now - gStaDownSinceMs > 60000UL &&
      now - gLastScanMs > 120000UL) {
    gLastScanMs = now;
    sgLog("[wifi] scan for hidden mesh AP...");
    const int found = WiFi.scanNetworks(false, true);
    int best = -1;
    int bestRssi = -1000;
    const String ownBssid = WiFi.softAPmacAddress();
    for (int i = 0; i < found; i++) {
      if (WiFi.SSID(i) != String(meshSsid())) continue;
      if (WiFi.BSSIDstr(i).equalsIgnoreCase(ownBssid)) continue;   // свой AP
      if (WiFi.RSSI(i) > bestRssi) {
        bestRssi = WiFi.RSSI(i);
        best = i;
      }
    }
    if (best >= 0) {
      uint8_t bssid[6];
      memcpy(bssid, WiFi.BSSID(best), 6);
      const int ch = WiFi.channel(best);
      sgLog("[wifi] scan: mesh ap %s ch%d rssi=%d", WiFi.BSSIDstr(best).c_str(),
            ch, bestRssi);
      WiFi.begin(meshSsid(), meshPass(), ch, bssid, true);
    } else {
      sgLog("[wifi] scan: mesh ap not found (%d nets)", found);
    }
    WiFi.scanDelete();
    if (best >= 0) return;
  }

  if (isGateway()) {
    if (!gRouterSsid.length()) {
      sgLog("[wifi] no router ssid (SET_CONFIG needed)");
      return;
    }
    sgLog("[wifi] sta -> router %s", gRouterSsid.c_str());
    WiFi.begin(gRouterSsid.c_str(), gRouterPass.c_str());
  } else {
    sgLog("[wifi] sta -> mesh %s", meshSsid());
    WiFi.begin(meshSsid(), meshPass());
  }
}

static void setupWifi() {
  if (!wifiTransportEnabled()) {
    sgLog("[wifi] disabled (conn=%s)", SG_CONNECTIVITY);
    return;
  }
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);

  const bool apOk = WiFi.softAP(meshSsid(), meshPass(), SG_MESH_CHANNEL,
                                SG_MESH_HIDDEN ? 1 : 0, 4);
  if (apOk) {
    gApChannel = (uint8_t)SG_MESH_CHANNEL;
    sgLog("[wifi] softAP %s ch%d hidden=%d ip=%s",
          meshSsid(), (int)SG_MESH_CHANNEL, SG_MESH_HIDDEN ? 1 : 0,
          WiFi.softAPIP().toString().c_str());
  } else {
    sgLog("[wifi] softAP failed, mode=%d", (int)WiFi.getMode());
  }

  if (!wifiStartUdp()) {
    // Всё равно попробуем позже из ensureWifiLink().
    sgLog("[wifi] udp not started yet");
  }
  gWifiReady = apOk || gUdpStarted;
  gLastWifiAttemptMs = millis() - 20000UL;   // первая попытка сразу
  ensureWifiLink();
}

static void wifiPoll() {
  if (!gUdpStarted) return;
  int guard = 0;
  int sz = gUdp.parsePacket();
  while (sz > 0 && guard++ < 32) {
    uint8_t buf[sizeof(MeshHeader) + SG_MAX_PAYLOAD];
    const IPAddress from = gUdp.remoteIP();
    int n = gUdp.read(buf, sizeof(buf));
    if (n > 0) {
      wifiNotePeer(from);
      gUdpRxCount++;
      const IPAddress ap = WiFi.softAPIP();
      const bool viaAp = ap[0] && from[0] == ap[0] && from[1] == ap[1] &&
                         from[2] == ap[2];
      if (gUdpRxCount <= 5 || gUdpRxCount % 20 == 0) {
        sgLog("[udp] rx #%lu %dB from %s if=%s", (unsigned long)gUdpRxCount,
              (unsigned)n, from.toString().c_str(), viaAp ? "ap" : "sta");
      }
      handleMeshPacket(buf, (size_t)n, false, (int16_t)WiFi.RSSI());
    }
    sz = gUdp.parsePacket();
  }
  if (guard >= 32) sgLog("[udp] rx burst cap hit");
}
#else
/* Полноценный ESP-WIFI-MESH. Включается SG_USE_ESP_MESH=1.
 * Примечание: в Arduino core 2.0.17 API доступен, но требует аккуратной
 * настройки mesh_cfg_t и совместимости с WiFi-стеком. По умолчанию
 * используется UDP fallback выше, чтобы сборка гарантированно проходила. */
static bool gMeshStarted = false;

static void espMeshRxTask(void *arg) {
  (void)arg;
  mesh_data_t d;
  uint8_t buf[sizeof(MeshHeader) + SG_MAX_PAYLOAD];
  for (;;) {
    mesh_addr_t from;
    d.data = buf;
    d.size = sizeof(buf);
    d.proto = 0;
    if (esp_mesh_recv(&from, &d, portMAX_DELAY, 0, NULL, 0) == ESP_OK) {
      handleMeshPacket(buf, d.size, false, (int16_t)WiFi.RSSI());
    }
  }
}

static void setupWifi() {
  if (!wifiTransportEnabled()) return;
  nvs_flash_init();
  esp_netif_init();
  esp_event_loop_create_default();
  esp_netif_create_default_wifi_mesh_netif();

  wifi_init_config_t ic = WIFI_INIT_CONFIG_DEFAULT();
  esp_wifi_init(&ic);
  esp_mesh_init();

  esp_mesh_set_max_layer(SG_WIFI_MAX_HOPS);
  esp_mesh_set_self_organized(true, true);
  esp_mesh_set_ap_authmode(WIFI_AUTH_WPA2_PSK);
  esp_mesh_set_ap_password((const uint8_t *)meshPass(), (int)strlen(meshPass()));
  esp_mesh_set_ap_assoc_expire(60);

  mesh_cfg_t cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.channel = SG_MESH_CHANNEL;
  for (int i = 0; i < 6; i++) {
    cfg.mesh_id[i] = (uint8_t)(gNodeId >> (8 * i));
  }
  const char *mid = meshIdText();
  for (int i = 0; i < 6 && mid[i]; i++) cfg.mesh_id[i] = (uint8_t)mid[i];
  cfg.mesh_ap.max_connection = 6;
  cfg.mesh_ap.authmode = WIFI_AUTH_WPA2_PSK;
  snprintf((char *)cfg.mesh_ap.password, sizeof(cfg.mesh_ap.password), "%s", meshPass());
  snprintf((char *)cfg.mesh_ap.ssid, sizeof(cfg.mesh_ap.ssid), "%s", meshSsid());

  if (isGateway() && strlen(SG_WIFI_SSID)) {
    cfg.router.ssid_len = (uint8_t)strlen(SG_WIFI_SSID);
    snprintf((char *)cfg.router.ssid, sizeof(cfg.router.ssid), "%s", SG_WIFI_SSID);
    snprintf((char *)cfg.router.password, sizeof(cfg.router.password), "%s", SG_WIFI_PASS);
    cfg.router.authmode = WIFI_AUTH_WPA2_PSK;
    cfg.router.allow_router_switch = true;
  }

  if (esp_mesh_set_config(&cfg) != ESP_OK) {
    sgLog("[mesh] set_config failed");
    return;
  }
  esp_mesh_set_type(isGateway() ? MESH_ROOT : MESH_NODE);
  if (esp_mesh_start() != ESP_OK) {
    sgLog("[mesh] start failed");
    return;
  }
  gMeshStarted = true;
  gWifiReady = true;
  xTaskCreate(espMeshRxTask, "sg_mesh_rx", 4096, NULL, 5, NULL);
  sgLog("[mesh] esp-wifi-mesh started role=%s", SG_ROLE);
}

static bool wifiSendRaw(const uint8_t *buf, size_t len) {
  if (!gMeshStarted) return false;
  mesh_data_t d;
  d.data = (uint8_t *)buf;
  d.size = len;
  d.proto = 0;
  return esp_mesh_send(NULL, &d, MESH_DATA_P2P, NULL, 0) == ESP_OK;
}

static void wifiPoll() {}
static void ensureWifiLink() {
  static uint32_t last = 0;
  if (isGateway() && strlen(SG_WIFI_SSID) && millis() - last > 30000UL) {
    last = millis();
    if (WiFi.status() != WL_CONNECTED) {
      // ESP-WIFI-MESH сам держит root→router; ручной reconnect не обязателен.
    }
  }
}
#endif

/* ----------------------------------------------------------- диагностика -- */

// Периодическая сводка по транспортам: по USB-логу видно, где рвётся связь.
static void diagPoll() {
  const uint32_t now = millis();
  if (now - gLastDiagMs < 30000UL) return;
  gLastDiagMs = now;
  const int ch = (int)WiFi.channel();
  sgLog("[diag] role=%s conn=%s wifi=%d lora=%d sta=%d ch=%d apClients=%d "
        "udp rx=%lu tx=%lu lora rx=%lu tx=%lu tx=%lu fwd=%lu q=%u",
        SG_ROLE, SG_CONNECTIVITY, gWifiReady ? 1 : 0, gLoraReady ? 1 : 0,
        WiFi.status() == WL_CONNECTED ? 1 : 0, ch,
        (int)WiFi.softAPgetStationNum(), (unsigned long)gUdpRxCount,
        (unsigned long)gUdpTxCount, (unsigned long)gLoraRxCount,
        (unsigned long)gLoraTxCount, (unsigned long)gTxCount,
        (unsigned long)gFwdCount, (unsigned)queueLoadValue());
}

/* ---------------------------------------------------------------- Hub ---- */

static int hubPostJson(const String &path, const String &body, String &resp, bool auth) {
  if (!gatewayUp()) return -1;
  HTTPClient http;
  String url = gHubBase + path;
  if (!http.begin(url)) return -1;
  http.setTimeout(7000);
  http.addHeader("Content-Type", "application/json");
  if (auth && gModuleToken.length()) {
    http.addHeader("Authorization", String("Bearer ") + gModuleToken);
    http.addHeader("x-module-token", gModuleToken);
  }
  int code = http.POST(body);
  if (code > 0) resp = http.getString();
  http.end();
  return code;
}

static int hubGetJson(const String &path, String &resp, bool auth) {
  if (!gatewayUp()) return -1;
  HTTPClient http;
  String url = gHubBase + path;
  if (!http.begin(url)) return -1;
  http.setTimeout(7000);
  if (auth && gModuleToken.length()) {
    http.addHeader("Authorization", String("Bearer ") + gModuleToken);
    http.addHeader("x-module-token", gModuleToken);
  }
  int code = http.GET();
  if (code > 0) resp = http.getString();
  http.end();
  return code;
}

/* ------------------------------------------------------------- OTA (Wi-Fi) */

static String gOtaDoneJob;
static uint32_t gLastOtaPollMs = 0;

#if SG_OTA
static void hubOtaReport(const String &jobId, const char *status, int progress, const String &err) {
  if (!jobId.length() || !gModuleToken.length()) return;
  String body = String("{\"jobId\":\"") + jobId + "\",\"status\":\"" + status +
                "\",\"progress\":" + String(progress);
  if (err.length()) body += ",\"error\":\"" + err + "\"";
  body += "}";
  String resp;
  hubPostJson("/v1/modules/ota/status", body, resp, true);
}

/** Скачивает app-only образ и пишет его в OTA-раздел. */
static bool hubOtaApply(const String &jobId, const String &url, long size, const String &sha) {
  if (!url.length() || size <= 0) return false;
  sgLog("[ota] begin %ldB %s", size, jobId.c_str());
  hubOtaReport(jobId, "downloading", 1, "");

  HTTPClient http;
  String full = url.startsWith("http") ? url : (gHubBase + url);
  if (!http.begin(full)) return false;
  http.setTimeout(20000);
  if (gModuleToken.length()) {
    http.addHeader("Authorization", String("Bearer ") + gModuleToken);
    http.addHeader("x-module-token", gModuleToken);
  }
  int code = http.GET();
  if (code != 200) {
    sgLog("[ota] http %d", code);
    http.end();
    hubOtaReport(jobId, "failed", 0, String("http_") + code);
    return false;
  }

  const int total = http.getSize() > 0 ? http.getSize() : (int)size;
  if (!Update.begin((size_t)total, U_FLASH)) {
    sgLog("[ota] begin failed: %s", Update.errorString());
    http.end();
    hubOtaReport(jobId, "failed", 0, Update.errorString());
    return false;
  }

  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);

  WiFiClient *stream = http.getStreamPtr();
  uint8_t buf[1024];
  int written = 0;
  int lastPct = -1;
  while (written < total) {
    size_t avail = stream ? stream->available() : 0;
    if (!avail) {
      if (!http.connected()) break;
      delay(2);
      continue;
    }
    int n = stream->readBytes(buf, avail > sizeof(buf) ? sizeof(buf) : avail);
    if (n <= 0) break;
    if (Update.write(buf, n) != (size_t)n) {
      sgLog("[ota] write failed: %s", Update.errorString());
      Update.abort();
      http.end();
      hubOtaReport(jobId, "failed", 0, Update.errorString());
      return false;
    }
    mbedtls_sha256_update(&ctx, buf, n);
    written += n;
    int pct = total > 0 ? (written * 100) / total : 0;
    if (pct >= lastPct + 10) {
      lastPct = pct;
      sgLog("[ota] %d%%", pct);
      hubOtaReport(jobId, "installing", pct, "");
    }
  }
  http.end();

  uint8_t digest[32];
  mbedtls_sha256_finish(&ctx, digest);
  mbedtls_sha256_free(&ctx);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", digest[i]);
  hex[64] = 0;

  if (written != total || (sha.length() && sha != String(hex))) {
    sgLog("[ota] verify failed %d/%d", written, total);
    Update.abort();
    hubOtaReport(jobId, "failed", 0, "sha_mismatch");
    return false;
  }
  if (!Update.end(true)) {
    sgLog("[ota] end failed: %s", Update.errorString());
    hubOtaReport(jobId, "failed", 0, Update.errorString());
    return false;
  }
  sgLog("[ota] installed");
  hubOtaReport(jobId, "installed", 100, "");
  delay(500);
  ESP.restart();
  return true;
}
#else
static void hubOtaReport(const String &, const char *, int, const String &) {}
static bool hubOtaApply(const String &, const String &, long, const String &) { return false; }
#endif

static void hubOtaTick() {
#if SG_OTA
  if (!isGateway() || WiFi.status() != WL_CONNECTED || !gModuleToken.length()) return;
  const uint32_t now = millis();
  if (now - gLastOtaPollMs < 60000UL) return;
  gLastOtaPollMs = now;
  String resp;
  int code = hubGetJson("/v1/modules/ota/job", resp, true);
  if (code < 200 || code >= 300) return;
  String jobId = jsonGetString(resp, "id");
  String url = jsonGetString(resp, "url");
  String sha = jsonGetString(resp, "sha256");
  long size = jsonGetInt(resp, "sizeBytes");
  if (!jobId.length() || !url.length() || jobId == gOtaDoneJob) return;
  gOtaDoneJob = jobId;
  hubOtaApply(jobId, url, size, sha);
#endif
}

static void hubSaveToken(const String &token) {
  if (!token.length() || token == gModuleToken) return;
  gModuleToken = token;
  gPrefs.begin("swarm", false);
  gPrefs.putString("module_token", gModuleToken);
  gPrefs.end();
  sgLog("[hub] module token stored");
}

static String neighborsJson() {
  String out = "[";
  bool first = true;
  for (int i = 0; i < 8; i++) {
    if (!gNeighbors[i].used) continue;
    if (millis() - gNeighbors[i].lastMs > 10UL * 60UL * 1000UL) continue;
    if (!first) out += ",";
    first = false;
    out += String("{\"publicId\":\"") + publicIdForNode(gNeighbors[i].id) +
           "\",\"rssi\":" + String(gNeighbors[i].rssi) + "}";
  }
  out += "]";
  return out;
}

static void hubRegister() {
  if (!gatewayUp() || gHubAuthRejected) return;

  String body = String("{\"hardwareId\":\"") + gHardwareId +
                "\",\"publicId\":\"" + gPublicId +
                "\",\"role\":\"gateway\",\"battery\":" + String(gBattery) +
                ",\"firmware\":\"" SG_FIRMWARE_VERSION
                "\",\"gateway\":true,\"neighbors\":" + neighborsJson() +
                ",\"rssi\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0) +
                ",\"uptime\":" + String((unsigned long)(millis() / 1000UL)) +
                ",\"claimToken\":\"" SG_CLAIM_TOKEN "\"}";

  String resp;
  int code = hubPostJson("/v1/modules/register", body, resp, false);
  // Старые сборки могли быть скомпилированы с нерабочим доменом: один раз
  // переключаемся на прямой адрес Hub и повторяем.
  if ((code <= 0 || code == 301 || code == 302 || code == 404) && gHubBase != String(SG_DEFAULT_HUB_URL)) {
    gHubBase = String(SG_DEFAULT_HUB_URL);
    sgLog("[hub] fallback -> %s", gHubBase.c_str());
    code = hubPostJson("/v1/modules/register", body, resp, false);
  }
  if (code == 404) {
    // Совместимость с существующим Hub.
    code = hubPostJson("/v1/modules/checkin", body, resp, gModuleToken.length() > 0);
  }
  if (code == 401) {
    gHubAuthRejected = true;
    sgLog("[hub] register 401: auth disabled, no retries");
    return;
  }
  if (code >= 200 && code < 300) {
    String token = jsonGetString(resp, "moduleToken");
    if (!token.length()) token = jsonGetString(resp, "token");
    if (!token.length()) token = jsonGetString(resp, "accessToken");
    hubSaveToken(token);
    gRegisterRetryMs = 60000UL;
    sgLog("[hub] register ok %d", code);
  } else {
    // 3xx/4xx/5xx и таймауты: плавный backoff, чтобы не спамить Hub.
    if (gRegisterRetryMs < 900000UL) gRegisterRetryMs = min(gRegisterRetryMs * 2UL, 900000UL);
    sgLog("[hub] register failed %d (retry %lus)", code, (unsigned long)(gRegisterRetryMs / 1000UL));
  }
}

static void hubRelayQueue() {
  if (!gatewayUp() || gHubAuthRejected || !gModuleToken.length()) return;

  uint32_t ids[4];
  uint8_t found = 0;
  for (size_t i = 0; i < gQueueCount && found < 4; i++) {
    if (gQueue[i].kind == QK_HUB) ids[found++] = gQueue[i].id;
  }
  if (!found) return;

  String body = "{\"envelopes\":[";
  for (uint8_t k = 0; k < found; k++) {
    QueueEntry *e = queueFind(ids[k]);
    if (!e) continue;
    String raw = payloadToString(e->data, e->len);
    String chatId = jsonGetString(raw, "chatId");
    if (chatId == "__presence__") {
      queueRemove(ids[k]);
      continue;
    }
    String envelope = jsonGetString(raw, "envelope");
    if (!envelope.length()) envelope = raw;   // raw bytes тоже поддерживаем
    if (k) body += ",";
    body += String("{\"chatId\":\"") + jsonEsc(chatId) +
            "\",\"packetId\":" + String((unsigned long)e->id) +
            ",\"envelope\":\"" + jsonEsc(envelope) + "\"}";
  }
  body += "]}";

  String resp;
  int code = hubPostJson("/v1/modules/relay", body, resp, true);
  if (code == 401) {
    gHubAuthRejected = true;
    sgLog("[hub] relay 401: auth disabled");
    return;
  }
  if (code >= 200 && code < 300) {
    for (uint8_t k = 0; k < found; k++) queueRemove(ids[k]);
    sgLog("[hub] relay ok %u", (unsigned)found);
  } else {
    sgLog("[hub] relay failed %d", code);
  }
}

static void hubPollDownlink() {
  if (!gatewayUp() || gHubAuthRejected || !gModuleToken.length()) return;

  String resp;
  String path = String("/v1/modules/relay/pending?since=") + String((unsigned long)gPendingSince);
  int code = hubGetJson(path, resp, true);
  if (code != 200) return;
  if (!resp.length()) return;

#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  DynamicJsonDocument doc(8192);
#endif
  DeserializationError err = deserializeJson(doc, resp);
  if (err) return;

  JsonArray arr;
  if (doc.is<JsonArray>()) {
    arr = doc.as<JsonArray>();
  } else if (doc["envelopes"].is<JsonArray>()) {
    arr = doc["envelopes"].as<JsonArray>();
  } else if (doc["items"].is<JsonArray>()) {
    arr = doc["items"].as<JsonArray>();
  }

  uint8_t sent = 0;
  for (JsonVariant v : arr) {
    if (sent >= 3) break;
    String chatId;
    JsonVariant cv = v["chatId"];
    if (cv.is<const char *>()) chatId = cv.as<const char *>();
    else if (!cv.isNull()) serializeJson(cv, chatId);
    String env;
    if (v["envelope"].is<const char *>()) {
      env = v["envelope"].as<const char *>();
    } else {
      serializeJson(v["envelope"], env);
    }
    if (!env.length()) continue;
    String payload = String("{\"chatId\":\"") + jsonEsc(chatId) +
                     "\",\"envelope\":\"" + jsonEsc(env) + "\"}";
    queueAdd((const uint8_t *)payload.c_str(), (uint16_t)payload.length(), QK_MESH, 0);
    sent++;
  }

  long next = 0;
  if (doc["nextSince"].is<long>()) next = doc["nextSince"].as<long>();
  else if (doc["since"].is<long>()) next = doc["since"].as<long>();
  if (next > 0) gPendingSince = (uint32_t)next;
  else gPendingSince += sent;

  if (sent) {
    sgLog("[hub] downlink queued %u", (unsigned)sent);
    meshPumpQueue();
  }
}

static void hubLoop() {
  if (!isGateway()) return;
  const uint32_t now = millis();
  if (now - gLastRegisterMs >= gRegisterRetryMs) {
    gLastRegisterMs = now;
    hubRegister();
  }
  hubOtaTick();
  if (now - gLastRelayMs >= 5000UL) {
    gLastRelayMs = now;
    hubRelayQueue();
  }
  if (now - gLastPendingMs >= 10000UL) {
    gLastPendingMs = now;    hubPollDownlink();
  }
}

/* ------------------------------------------------------------- батарея --- */

static int readBatteryPercent() {
#if SG_BATT_ENABLED
  uint32_t mv = 0;
  const int samples = 8;
  for (int i = 0; i < samples; i++) {
    mv += analogReadMilliVolts(SG_BATT_PIN);
    delay(2);
  }
  const float pinVolts = (mv / (float)samples) / 1000.0f;
  const float battVolts = pinVolts * (float)SG_BATT_RATIO;
  int pct = (int)((battVolts - 3.3f) / (4.2f - 3.3f) * 100.0f);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
#else
  return 0;
#endif
}

/* --------------------------------------------------------------- OTA ----- */

#if SG_OTA
static bool gOtaStarted = false;

static void setupOta() {
  if (isWearable()) return;   // wearable с deep sleep не обновляется по OTA
  if (WiFi.status() != WL_CONNECTED) return;   // запустим из loop(), когда сеть появится
  static String otaHost;
  otaHost = String("swarm-") + gPublicId;
  ArduinoOTA.setHostname(otaHost.c_str());
  ArduinoOTA.onStart([]() { sgLog("[ota] start"); });
  ArduinoOTA.onEnd([]() { sgLog("[ota] done"); });
  ArduinoOTA.onError([](ota_error_t err) { sgLog("[ota] error %u", (unsigned)err); });
  ArduinoOTA.begin();
  gOtaStarted = true;
  sgLog("[ota] ready");
}
#else
static void setupOta() {}
#endif

/* -------------------------------------------------------- deep sleep ----- */

static void maybeDeepSleep() {
#if SG_DEEP_SLEEP
  if (!isWearable()) return;          // gateway/repeater никогда не спят
  if (gBleConnected) return;          // не спим, пока клиент подключён
  if (gUsbSeen && millis() - gLastClientActivityMs < 45000UL) return;
  if (millis() < 60000UL) return;     // даём 60 c на подключение клиента
  if (millis() - gLastClientActivityMs < 45000UL) return;

  // Перед сном — presence(offline) не шлём: нет времени ждать эфир.
  sgLog("[pm] deep sleep %u s", (unsigned)SG_BATT_INTERVAL);
  Serial.flush();
  delay(50);
  ESP.deepSleep((uint64_t)SG_BATT_INTERVAL * 1000000ULL);
#endif
}

/* ---------------------------------------------------------------- setup -- */

void setup() {
  Serial.begin(115200);
  // Даём USB CDC время на enumeration (для C3/S3); UART всегда готов.
  {
    const uint32_t t0 = millis();
    while (!Serial && millis() - t0 < 1500UL) delay(10);
  }
  delay(150);
  gBootMs = millis();

  initIdentity();
  // Handshake-строка для клиента; ASCII, чтобы не ломать USB-парсер.
  Serial.printf("SG-INFO {\"hardwareId\":\"%s\",\"publicId\":\"%s\",\"role\":\"%s\"}\n",
                gHardwareId.c_str(), gPublicId.c_str(), SG_ROLE);
  if (isWearable()) gLogEnabled = true;   // до первого USB-кадра логи полезны
  sgLog("[boot] firmware=%s board=%s role=%s conn=%s",
        SG_FIRMWARE_VERSION, SG_BOARD, SG_ROLE, SG_CONNECTIVITY);
  if (connHas("lora") && !loraTransportEnabled()) {
    sgLog("[cfg] WARN: conn=%s but SG_USE_LORA=0 — LoRa disabled",
          SG_CONNECTIVITY);
  }

  gPrefs.begin("swarm", true);
  gModuleToken = gPrefs.getString("module_token", "");
  gRouterSsid = gPrefs.getString("wifi_ssid", SG_WIFI_SSID);
  gRouterPass = gPrefs.getString("wifi_pass", SG_WIFI_PASS);
  gPrefs.end();
  if (!gModuleToken.length() && strlen(SG_MODULE_TOKEN)) gModuleToken = SG_MODULE_TOKEN;
  gHubBase = normalizedHubBase();

  // LittleFS: очередь переживает перезагрузку. Форматируем только при сбое.
  gFsReady = LittleFS.begin(true);
  if (gFsReady) {
    queueLoad();
    queueCleanup();
  } else {
    sgLog("[fs] littlefs mount failed");
  }

  gBattery = readBatteryPercent();
  gLastBattMs = millis();

  setupWifi();
  setupLora();
  sgLog("[boot] transports wifi=%d lora=%d (wifiReq=%d loraReq=%d)",
        gWifiReady ? 1 : 0, gLoraReady ? 1 : 0,
        wifiTransportEnabled() ? 1 : 0, loraTransportEnabled() ? 1 : 0);
  setupBle();
  setupOta();

  // Первый ADVERT/presence и INFO клиенту.
  sendAdvert();
  gLastAdvertMs = millis();
  sendPresence();
  gLastPresenceMs = millis();
  sendInfoToClient();

  gLastClientActivityMs = millis();
  sgLog("[boot] ready nodeId=%lu q=%u", (unsigned long)gNodeId, (unsigned)queueLoadValue());
}

/* ----------------------------------------------------------------- loop -- */

void loop() {
  usbPoll();
  clientInboxPoll();
  bleLoop();

#if SG_OTA
  if (!gOtaStarted && !isWearable() && WiFi.status() == WL_CONNECTED) setupOta();
  if (gOtaStarted) ArduinoOTA.handle();
#endif

  ensureWifiLink();
  wifiPoll();
  loraPoll();
  diagPoll();

  meshPumpQueue();
  hubLoop();

  const uint32_t now = millis();

  // Батарея — не чаще SG_BATT_INTERVAL.
  if (now - gLastBattMs >= (uint32_t)SG_BATT_INTERVAL * 1000UL) {
    gLastBattMs = now;
    gBattery = readBatteryPercent();
  }

  // ADVERT раз в 60 c.
  if (now - gLastAdvertMs >= 60000UL) {
    gLastAdvertMs = now;
    sendAdvert();
  }

  // PRESENCE раз в 30 c; при перегрузке sendPresence сам пропустит.
  if (now - gLastPresenceMs >= 30000UL) {
    gLastPresenceMs = now;
    sendPresence();
  }

  // TTL очереди + сброс на диск только при изменении.
  if (now - gLastCleanupMs >= 60000UL) {
    gLastCleanupMs = now;
    queueCleanup();
  }
  if (gQueueDirty && now - gQueueDirtyMs > 1500UL) {
    queueSave();
  }

  maybeDeepSleep();
  delay(3);
}
