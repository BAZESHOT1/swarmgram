#include "klinto_ble_link.h"

#if defined(ESP32)

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <string.h>

#define KL_BLE_SERVICE "0000a5c0-0000-1000-8000-00805f9b34fb"
#define KL_BLE_TX "0000a5c1-0000-1000-8000-00805f9b34fb"
#define KL_BLE_RX "0000a5c2-0000-1000-8000-00805f9b34fb"
#define KL_BLE_STATUS "0000a5c3-0000-1000-8000-00805f9b34fb"

namespace {

class KlintoBleServerCallbacks : public BLEServerCallbacks {
 public:
  explicit KlintoBleServerCallbacks(BleClientLink *owner) : owner_(owner) {}
  void onConnect(BLEServer *server) override {
    owner_->onConnected(0, server->getPeerMTU(0));
  }
  void onDisconnect(BLEServer *server) override {
    (void)server;
    owner_->onDisconnected();
  }

 private:
  BleClientLink *owner_;
};

class KlintoBleRxCallbacks : public BLECharacteristicCallbacks {
 public:
  explicit KlintoBleRxCallbacks(BleClientLink *owner) : owner_(owner) {}
  void onWrite(BLECharacteristic *characteristic) override {
    String value = characteristic->getValue();
    if (value.length()) {
      owner_->onWrite((const uint8_t *)value.c_str(), value.length());
    }
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
  BLEDevice::init(deviceName ? deviceName : "Klinto");
  BLEDevice::setMTU(247);
  server_ = BLEDevice::createServer();
  server_->setCallbacks(new KlintoBleServerCallbacks(this));

  BLEService *service = server_->createService(KL_BLE_SERVICE);
  tx_ = service->createCharacteristic(KL_BLE_TX, BLECharacteristic::PROPERTY_NOTIFY);
  rx_ = service->createCharacteristic(
      KL_BLE_RX, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  status_ = service->createCharacteristic(KL_BLE_STATUS, BLECharacteristic::PROPERTY_NOTIFY);
#if defined(CONFIG_BLUEDROID_ENABLED)
  tx_->addDescriptor(new BLE2902());
  status_->addDescriptor(new BLE2902());
#endif
  rx_->setCallbacks(new KlintoBleRxCallbacks(this));
  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(KL_BLE_SERVICE);
  advertising->setScanResponse(true);
  advertising->setMinPreferred(0x06);
  advertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  return true;
}

void BleClientLink::end() {
  connected_ = false;
  BLEDevice::stopAdvertising();
}

bool BleClientLink::send(const uint8_t *data, size_t len) {
  if (!connected_ || !tx_ || !data || !len) return false;
  size_t chunk = (mtu_ > 3 ? mtu_ - 3 : 20);
  if (chunk > 244) chunk = 244;
  size_t offset = 0;
  while (offset < len) {
    const size_t take = (len - offset) > chunk ? chunk : (len - offset);
    tx_->setValue((uint8_t *)(data + offset), take);
    tx_->notify();
    offset += take;
    if (offset < len) delay(4); /* let the controller drain */
  }
  return true;
}

uint16_t BleClientLink::mtu() const {
  uint16_t value = mtu_;
  if (server_) {
    const uint16_t peer = server_->getPeerMTU(conn_id_);
    if (peer > value) value = peer;
  }
  return value < 23 ? 23 : value;
}

void BleClientLink::poll(uint32_t now_ms) { (void)now_ms; }

void BleClientLink::notifyStatus(const char *text) {
  if (!connected_ || !status_ || !text) return;
  status_->setValue((uint8_t *)text, strlen(text));
  status_->notify();
}

void BleClientLink::onConnected(uint16_t conn_id, uint16_t mtu) {
  conn_id_ = conn_id;
  mtu_ = mtu < 23 ? 23 : mtu;
  connected_ = true;
  if (hook_) hook_(hook_ctx_, true);
}

void BleClientLink::onDisconnected() {
  connected_ = false;
  conn_id_ = 0;
  if (hook_) hook_(hook_ctx_, false);
  BLEDevice::startAdvertising();
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

#else

BleClientLink::BleClientLink()
    : cb_(nullptr), cb_ctx_(nullptr), connected_(false), mtu_(23), conn_id_(0), hook_(nullptr),
      hook_ctx_(nullptr) {}
bool BleClientLink::begin(const char *) { return false; }
void BleClientLink::end() {}
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
