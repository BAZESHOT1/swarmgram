#include "klinto_ble_link.h"

#if defined(ESP32)
#include <Arduino.h>
#endif

#if defined(ESP32) && KL_HAS_BLE

/* BLE на NimBLE-Arduino для всех плат ESP32.
 * Bluedroid из ядра Arduino на классическом ESP32 вместе с Wi-Fi/ESP-NOW съедал
 * всю кучу (после BLE оставалось 4 КБ) и роняла модуль в btu_hcif; NimBLE
 * требует в разы меньше памяти и одинаково ведёт себя на C3/C5/C6/S3/ESP32. */
#include <Arduino.h>
#include <NimBLEDevice.h>
#include <esp_bt.h>
#include <esp_coexist.h>
#include <string.h>

#define KL_BLE_SERVICE "0000a5c0-0000-1000-8000-00805f9b34fb"
#define KL_BLE_TX "0000a5c1-0000-1000-8000-00805f9b34fb"
#define KL_BLE_RX "0000a5c2-0000-1000-8000-00805f9b34fb"
#define KL_BLE_STATUS "0000a5c3-0000-1000-8000-00805f9b34fb"

namespace {

class KlintoBleServerCallbacks : public NimBLEServerCallbacks {
 public:
  explicit KlintoBleServerCallbacks(BleClientLink *owner) : owner_(owner) {}
  void onConnect(NimBLEServer *server, NimBLEConnInfo &info) override {
    /* Как в BitChatRelay: единственное соединение, реклама на время подключения выключена
     * (меньше борьбы за эфир), интервал 20..50 мс, latency 0, supervision 5 с. Разрыв через
     * ~5 с после подключения давали скачки Wi-Fi по каналам при поиске шлюза — теперь их нет. */
    NimBLEDevice::getAdvertising()->stop();
    server->updateConnParams(info.getConnHandle(), 16, 40, 0, 500);
    owner_->onConnected(info.getConnHandle(), info.getMTU());
  }
  void onDisconnect(NimBLEServer *server, NimBLEConnInfo &info, int reason) override {
    (void)server;
    (void)info;
    Serial.printf("[ble] disconnect reason=%d (0x%02X)\n", reason, (unsigned)(reason & 0xFF));
    owner_->onDisconnected();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo &info) override {
    (void)info;
    owner_->onMtu(mtu);
    Serial.printf("[ble] mtu=%u\n", (unsigned)mtu);
  }

 private:
  BleClientLink *owner_;
};

class KlintoBleCharCallbacks : public NimBLECharacteristicCallbacks {
 public:
  explicit KlintoBleCharCallbacks(BleClientLink *owner) : owner_(owner) {}
  void onWrite(NimBLECharacteristic *characteristic, NimBLEConnInfo &info) override {
    (void)info;
    const NimBLEAttValue &value = characteristic->getValue();
    if (value.length()) owner_->onWrite(value.data(), value.length());
  }
  void onSubscribe(NimBLECharacteristic *characteristic, NimBLEConnInfo &info,
                   uint16_t subValue) override {
    (void)info;
    owner_->onSubscribe(characteristic == owner_->txCharacteristic(), subValue);
  }

 private:
  BleClientLink *owner_;
};

}  // namespace

BleClientLink::BleClientLink()
    : cb_(nullptr),
      cb_ctx_(nullptr),
      connected_(false),
      mtu_(23),
      conn_id_(0),
      hook_(nullptr),
      hook_ctx_(nullptr),
      server_(nullptr),
      tx_(nullptr),
      rx_(nullptr),
      status_(nullptr) {}

bool BleClientLink::begin(const char *deviceName) {
#if defined(CONFIG_IDF_TARGET_ESP32)
  /* Классический ESP32: Classic BT модулю не нужен — отдаём его память куче. */
  esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
#endif
  const char *name = deviceName ? deviceName : "Klinto";
  NimBLEDevice::init(name);
  NimBLEDevice::setMTU(247);
  NimBLEDevice::setPower(9); /* максимум BLE TX (как в BitChatRelay) */
  server_ = NimBLEDevice::createServer();
  server_->setCallbacks(new KlintoBleServerCallbacks(this));
  server_->advertiseOnDisconnect(true);

  NimBLEService *service = server_->createService(KL_BLE_SERVICE);
  KlintoBleCharCallbacks *chars = new KlintoBleCharCallbacks(this);
  tx_ = service->createCharacteristic(
      KL_BLE_TX, NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  rx_ = service->createCharacteristic(
      KL_BLE_RX, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::NOTIFY);
  status_ = service->createCharacteristic(KL_BLE_STATUS, NIMBLE_PROPERTY::NOTIFY);
  tx_->setCallbacks(chars);
  rx_->setCallbacks(chars);
  service->start();

  NimBLEAdvertising *advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(KL_BLE_SERVICE);
  advertising->setName(name);
  advertising->enableScanResponse(true);
  advertising->start();
  Serial.printf("[ble] advertising name=%s\n", name);
  return true;
}

void BleClientLink::end() {
  connected_ = false;
  NimBLEDevice::getAdvertising()->stop();
}

void BleClientLink::rename(const char *deviceName) {
  if (!deviceName) return;
  strncpy(pending_name_, deviceName, sizeof(pending_name_) - 1);
  pending_name_[sizeof(pending_name_) - 1] = '\0';
  pending_rename_ = true;
  /* deinit при активном клиенте рвёт соединение: применяем после disconnect. */
  if (!connected_) applyPendingRename();
}

void BleClientLink::applyPendingRename() {
  if (!pending_rename_ || connected_ || !pending_name_[0]) return;
  pending_rename_ = false;
  end();
  NimBLEDevice::deinit(true);
  server_ = nullptr;
  tx_ = nullptr;
  rx_ = nullptr;
  status_ = nullptr;
  tx_subscribed_ = false;
  rx_subscribed_ = false;
  begin(pending_name_);
}

bool BleClientLink::send(const uint8_t *data, size_t len) {
  if (!connected_ || !tx_ || !data || !len) return false;
  /* Размер пакета — по согласованному MTU (mtu() спрашивает стек), а не по
   * значению на момент connect (там всегда 23). */
  const uint16_t cur_mtu = mtu();
  size_t chunk = (cur_mtu > 3 ? cur_mtu - 3 : 20);
  if (chunk > 244) chunk = 244;
  if (chunk < 20) chunk = 20;
  /* Клиент подписан на a5c1 (tx_). Если подписки ещё нет — notify уйдёт в
   * пустоту, поэтому шлём в ту характеристику, на которую подписались
   * (старые клиенты слушают a5c2). */
  NimBLECharacteristic *target = tx_;
  if (!tx_subscribed_ && rx_subscribed_) target = rx_;
  size_t offset = 0;
  while (offset < len) {
    const size_t take = (len - offset) > chunk ? chunk : (len - offset);
    bool ok = false;
    /* notify() возвращает false, когда очередь mbuf контроллера полна:
     * ждём и повторяем, а не теряем кусок кадра. */
    for (int attempt = 0; attempt < 60 && !ok && connected_; ++attempt) {
      ok = target->notify(data + offset, take, conn_id_);
      if (!ok) delay(5);
    }
    if (!ok) return false;
    offset += take;
    if (offset < len) delay(3);
  }
  return true;
}

uint16_t BleClientLink::mtu() const {
  uint16_t value = mtu_;
  if (server_ && connected_) {
    const uint16_t peer = server_->getPeerMTU(conn_id_);
    if (peer > value) value = peer;
  }
  return value < 23 ? 23 : value;
}

void BleClientLink::poll(uint32_t now_ms) { (void)now_ms; }

void BleClientLink::notifyStatus(const char *text) {
  if (!connected_ || !status_ || !text) return;
  status_->notify((const uint8_t *)text, strlen(text), conn_id_);
}

void BleClientLink::onConnected(uint16_t conn_id, uint16_t mtu) {
  conn_id_ = conn_id;
  mtu_ = mtu < 23 ? 23 : mtu;
  connected_ = true;
  tx_subscribed_ = false;
  rx_subscribed_ = false;
  /* Пока телефон подключён, эфир приоритетнее отдаём BLE. */
  esp_coex_preference_set(ESP_COEX_PREFER_BT);
  Serial.printf("[ble] connected handle=%u mtu=%u\n", (unsigned)conn_id, (unsigned)mtu_);
  if (hook_) hook_(hook_ctx_, true);
}

void BleClientLink::onDisconnected() {
  connected_ = false;
  conn_id_ = 0;
  tx_subscribed_ = false;
  rx_subscribed_ = false;
  esp_coex_preference_set(ESP_COEX_PREFER_BALANCE);
  Serial.println("[ble] disconnected");
  if (hook_) hook_(hook_ctx_, false);
}

void BleClientLink::onSubscribe(bool is_tx, uint16_t sub_value) {
  const bool on = (sub_value & 0x03) != 0;
  if (is_tx) tx_subscribed_ = on;
  else rx_subscribed_ = on;
  Serial.printf("[ble] subscribe %s=%u\n", is_tx ? "a5c1" : "a5c2", (unsigned)sub_value);
}

void BleClientLink::onWrite(const uint8_t *data, size_t len) {
  if (cb_) cb_(cb_ctx_, data, len, 0, 0xFF);
}

/* --------------------------------------------------------------- serial -- */

SerialClientLink::SerialClientLink() : cb_(nullptr), cb_ctx_(nullptr), last_rx_ms_(0) {}

void SerialClientLink::begin(unsigned long baud) { Serial.begin(baud); }

bool SerialClientLink::send(const uint8_t *data, size_t len) {
  if (!data || !len) return false;
  return Serial.write(data, len) == len;
}

void SerialClientLink::poll(uint32_t now_ms) {
  (void)now_ms;
  uint8_t buf[256];
  int budget = 4;
  while (budget-- > 0 && Serial.available() > 0) {
    const int n = Serial.readBytes(buf, sizeof(buf));
    if (n <= 0) break;
    last_rx_ms_ = millis();
    if (cb_) cb_(cb_ctx_, buf, (size_t)n, 0, 0xFF);
  }
}

#elif defined(ESP32)

/* Стационарный узел без BLE-моста: BLE-стек не линкуется. */
BleClientLink::BleClientLink()
    : cb_(nullptr), cb_ctx_(nullptr), connected_(false), mtu_(23), conn_id_(0), hook_(nullptr),
      hook_ctx_(nullptr), server_(nullptr), tx_(nullptr), rx_(nullptr), status_(nullptr) {}
bool BleClientLink::begin(const char *) { return false; }
void BleClientLink::end() {}
void BleClientLink::rename(const char *) {}
bool BleClientLink::send(const uint8_t *, size_t) { return false; }
uint16_t BleClientLink::mtu() const { return 23; }
void BleClientLink::poll(uint32_t) {}
void BleClientLink::notifyStatus(const char *) {}
void BleClientLink::onConnected(uint16_t, uint16_t) {}
void BleClientLink::onDisconnected() {}
void BleClientLink::onWrite(const uint8_t *, size_t) {}

SerialClientLink::SerialClientLink() : cb_(nullptr), cb_ctx_(nullptr), last_rx_ms_(0) {}
void SerialClientLink::begin(unsigned long baud) { Serial.begin(baud); }
bool SerialClientLink::send(const uint8_t *data, size_t len) {
  if (!data || !len) return false;
  return Serial.write(data, len) == len;
}
void SerialClientLink::poll(uint32_t now_ms) {
  (void)now_ms;
  uint8_t buf[256];
  int budget = 4;
  while (budget-- > 0 && Serial.available() > 0) {
    const int n = Serial.readBytes(buf, sizeof(buf));
    if (n <= 0) break;
    last_rx_ms_ = millis();
    if (cb_) cb_(cb_ctx_, buf, (size_t)n, 0, 0xFF);
  }
}

#else

BleClientLink::BleClientLink()
    : cb_(nullptr), cb_ctx_(nullptr), connected_(false), mtu_(23), conn_id_(0), hook_(nullptr),
      hook_ctx_(nullptr) {}
bool BleClientLink::begin(const char *) { return false; }
void BleClientLink::end() {}
void BleClientLink::rename(const char *) {}
bool BleClientLink::send(const uint8_t *, size_t) { return false; }
uint16_t BleClientLink::mtu() const { return 23; }
void BleClientLink::poll(uint32_t) {}
void BleClientLink::notifyStatus(const char *) {}
void BleClientLink::onConnected(uint16_t, uint16_t) {}
void BleClientLink::onDisconnected() {}
void BleClientLink::onWrite(const uint8_t *, size_t) {}

SerialClientLink::SerialClientLink() : cb_(nullptr), cb_ctx_(nullptr), last_rx_ms_(0) {}
void SerialClientLink::begin(unsigned long) {}
bool SerialClientLink::send(const uint8_t *, size_t) { return false; }
void SerialClientLink::poll(uint32_t) {}

#endif  // ESP32
