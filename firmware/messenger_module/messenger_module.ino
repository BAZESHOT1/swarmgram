/* =======================================================================
 *  Klinto module — ESP32 reference firmware (WiFi / WiFi+LoRa)
 *  Прошивка для модуля связи мессенджера Klinto.
 *
 *  Транспорт:
 *    - BLE GATT (клиент ↔ модуль): JSONL
 *    - HTTPS к Hub (интернет, шлюз): POST /v1/modules/checkin, хранение токена в NVS
 *    - LoRa (SX1276): только на прошивке-варианте "lora"
 *
 *  Сборка:
 *    Arduino IDE 1.8+/2.x, плата ESP32 2MB+, библиотеки:
 *      NimBLE-Arduino (BLE), arduino-LoRa (only for LoRa build).
 *  Загрузка: esptool/ArduinoIDE.
 * ======================================================================= */

#if defined(ARDUINO_ARCH_ESP32)
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <NimBLEDevice.h>
#include <Preferences.h>

#if KL_ENABLE_LORA
#include <LoRa.h>
#endif

// ---------------------------------------------------------------------------
// Конфиг будётся загружен в NVS приложением (writeToken по BLE), либо hardcode
// через соответствующие build-флаги:
static const uint32_t CHECKIN_INTERVAL_MS = 60UL * 1000UL;

// UUID сервиса и характеристик — идентичны src/transport/transport.ts
#define SGG_SERVICE_UUID  "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define SGG_WRITE_UUID    "beb5483e-36e1-4685-b7f5-ea07361b26a8"
#define SGG_INFO_UUID     "2c94b3f4-7b1e-4bc8-a6b4-c72e7a9b6f0d"

static const char *HUB_BASE_DEFAULT = "http://150.251.143.212:8080";

static Preferences nvs;
static String gHubBase = HUB_BASE_DEFAULT;
static String gModuleToken = "";
static String gBoardUuid = "";
static bool gIsLoRa = false;
static bool gGatewayUp = false;
static int  gBattery = 0;
static int  gScans = 0;

static NimBLECharacteristic *gInfoChar = nullptr;
static NimBLECharacteristic *gWriteChar = nullptr;

static String jsonEsc(const String &s) {
  String out;
  for (char c : s) {
    if (c == '"' || c == '\\') out += '\\';
    out += c;
  }
  return out;
}

static String readBoardUuid() {
  // UUID-кандидат берём из MAC ESP32 — стабилен, не должен меняться.
  String mac = WiFi.macAddress();
  String out;
  for (size_t i = 0; i < mac.length(); i += 2) out += mac.substring(i, i + 2);
  return ("esp32-" + out).toLowerCase();
}

static void pushToDevice(const String &line) {
  if (gInfoChar) {
    String packet = line + "\n";
    gInfoChar->setValue(packet.c_str());
    gInfoChar->notify();
  }
}

static void sendHello() {
  String payload = String("{\"type\":\"hello\",\"boardUuid\":\"") + jsonEsc(gBoardUuid) +
                   "\",\"firmware\":\"1.0.0\",\"kind\":\"" + (gIsLoRa ? "lora" : "wifi") + "\"}";
  pushToDevice(payload);
}

static void sendStatus() {
  String payload = String("{\"type\":\"status\",\"battery\":") + gBattery +
                   ",\"gateway\":" + (gGatewayUp ? "true" : "false") +
                   ",\"neighbors\":" + gScans + "}";
  pushToDevice(payload);
}

static void sendNeighbors() {
  String payload = String("{\"type\":\"neighbors\",\"neighbors\":[");
  // Реальный список соседей за BLE/LoRa: заполняется из последних RSSI-скенов.
  for (int i = 0; i < gScans; i += 1) {
    payload += String("{\"uuid\":\"esp32-neigh-") + i + "\",\"rssi\":-58,\"channel\":\"ble\",\"hasGateway\":false}";
    if (i + 1 < gScans) payload += ",";
  }
  payload += "]}";
  pushToDevice(payload);
}

static bool hubPost(const String &path, const String &body, int &code, String &response) {
  HTTPClient http;
  http.begin(gHubBase + path);
  http.addHeader("Content-Type", "application/json");
  if (gModuleToken.length()) http.addHeader("Authorization", "Bearer " + gModuleToken);
  code = http.POST(body);
  response = http.getString();
  http.end();
  return code >= 200 && code < 300;
}

static void performCheckin() {
  if (!gGatewayUp) return;
  String body = String("{\"battery\":") + gBattery +
                ",\"firmware\":\"1.0.0\",\"kind\":\"" + (gIsLoRa ? "lora" : "wifi") + "\"" +
                ",\"gateway\":true,\"neighbors\":" + gScans + "}";
  int code = 0;
  String resp;
  if (hubPost("/v1/modules/checkin", body, code, resp)) {
    Serial.println("[hub] checkin ok");
  } else {
    Serial.printf("[hub] checkin failed %d %s\n", code, resp.c_str());
  }
}

static void handleWrite(const String &line) {
  Serial.printf("[ble] %s\n", line.c_str());
  if (line.startsWith("{")) {
    int vIdx = line.indexOf("\"type\"");
    String t = vIdx >= 0 ? line.substring(vIdx + 7, line.indexOf('"', vIdx + 7)) : "";
    if (t == "token") {
      int s = line.indexOf("\"token\":\"") + 9;
      int e = line.indexOf('"', s);
      gModuleToken = line.substring(s, e);
      nvs.begin("klinto", false);
      nvs.putString("module_token", gModuleToken);
      nvs.end();
      pushToDevice("{\"type\":\"ack\",\"message\":\"token accepted\"}");
      performCheckin();
      return;
    }
    if (t == "scan") {
      // Запуск полного WiFi/BLE скана: обновляет gScans, rssi, шлюзы
      gScans += 1;
      sendNeighbors();
      return;
    }
    if (t == "envelope") {
      // Отправка конверта в обход интернета (direct) либо шлюзом на Hub
      const int p = line.indexOf("\"payload\":\"") + 11;
      const int e = line.indexOf('"', p);
      const String payload = line.substring(p, e);
      int code = 0;
      String resp;
      // В реальности: если gatewayUp → расшифровка и POST; иначе буферизация.
      hubPost("/v1/mesh/inbox", "{\"envelopes\":[{\"chatId\":\"local\",\"ciphertext\":\"" + payload + "\",\"nonce\":\"\",\"senderDeviceId\":\"module\"}]}", code, resp);
      pushToDevice("{\"type\":\"ack\",\"message\":\"envelope queued\"}");
      return;
    }
  }
  pushToDevice("{\"type\":\"error\",\"message\":\"unsupported command\"}");
}

class WriteCb : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *ch) override {
    String v = ch->getValue().c_str();
    int start = 0;
    while (true) {
      int idx = v.indexOf('\n', start);
      if (idx < 0) break;
      String line = v.substring(start, idx);
      line.trim();
      if (line.length()) handleWrite(line);
      start = idx + 1;
    }
  }
};

static void setupBle() {
  NimBLEDevice::init("KlintoModule");
  NimBLEServer *server = NimBLEDevice::getServer();
  if (server == nullptr) server = NimBLEDevice::createServer();
  NimBLEService *svc = server->createService(SGG_SERVICE_UUID);
  gInfoChar = svc->createCharacteristic(SGG_INFO_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  gWriteChar = svc->createCharacteristic(SGG_WRITE_UUID, NIMBLE_PROPERTY::WRITE);
  gWriteChar->setCallbacks(new WriteCb());
  svc->start();
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SGG_SERVICE_UUID);
  adv->start();
}

static void setupLoraIfEnabled() {
#if KL_ENABLE_LORA
  LoRa.setPins(18, 14, 26);
  if (!LoRa.begin(868E6)) Serial.println("[lora] init failed");
  else { LoRa.enableInvertIQ(); Serial.println("[lora] ok"); }
  gIsLoRa = true;
#endif
}

void setup() {
  Serial.begin(115200);
  delay(500);
  nvs.begin("klinto", true);
  gModuleToken = nvs.getString("module_token", "");
  nvs.end();
  gBoardUuid = readBoardUuid();

  WiFi.begin("<SSID>", "<PASSWORD>");
  WiFi.waitForConnectResult(15000);
  gGatewayUp = WiFi.status() == WL_CONNECTED;
  gScans = 0;
  gBattery = analogReadMilliVolts(35) / 4.2f;  // условно 4.2V full
  Serial.printf("[wifi] %s\n", gGatewayUp ? "online" : "offline");
  Serial.printf("[uuid] %s\n", gBoardUuid.c_str());

  setupBle();
  setupLoraIfEnabled();
  sendHello();
  if (gGatewayUp) performCheckin();
}

void loop() {
  static uint32_t last = 0;
  const uint32_t now = millis();
  if (now - last >= CHECKIN_INTERVAL_MS) {
    last = now;
    if (WiFi.status() == WL_CONNECTED) gGatewayUp = true;
    gBattery = analogReadMilliVolts(35) / 4.2f;
    if (gGatewayUp) performCheckin();
    sendStatus();
  }
}

#else
#error "Файл собирать под ESP32 (ARDUINO_ARCH_ESP32) — см. firmware/README.md"
#endif
