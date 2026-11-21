/**
 * Прошивка Klinto KMesh_v1 — точка входа.
 *
 * Сетевой стек живёт в klinto_core (портируемый C++); скетч только передаёт
 * значения по умолчанию из config.h в KlintoNode и обслуживает периферию
 * платы (телеметрия батареи). Пин и коэффициент делителя берутся из рантайм-конфига
 * (NVS «hw», удалённая настройка владельцем); пин -1 — батареи нет.
 */
#include <Arduino.h>

#include "config.h"
#include "klinto_runtime.h"
#include "klinto_ota_esp32.h"

#ifndef KL_BATT_CHARGING_PIN
#define KL_BATT_CHARGING_PIN -1
#endif
static uint32_t g_lastBatteryMs = 0;
static int g_battPin = -1;
static float g_battRatio = 2.0f;

static uint8_t readBatteryPercent() {
  const int raw = analogRead(g_battPin);
  const float voltage = (raw / 4095.0f) * 3.3f * g_battRatio;
  /* 3.3 В = 0%, 4.2 В = 100% для одного Li-ion элемента. */
  if (voltage >= 4.20f) return 100;
  if (voltage <= 3.30f) return 0;
  return (uint8_t)(((voltage - 3.30f) / 0.90f) * 100.0f);
}

static bool readCharging() {
  if (KL_BATT_CHARGING_PIN < 0) return false;
  return digitalRead(KL_BATT_CHARGING_PIN) == HIGH;
}

void setup() {
  Serial.begin(115200);
  delay(50);
  kl_ota_esp32_early_guard();
  KlintoNode::instance().begin();
  g_battPin = KlintoNode::instance().hwBattPin();
  g_battRatio = KlintoNode::instance().hwBattRatio();
  if (g_battPin >= 0) {
    analogReadResolution(12);
    pinMode(g_battPin, INPUT);
    if (KL_BATT_CHARGING_PIN >= 0) pinMode(KL_BATT_CHARGING_PIN, INPUT_PULLUP);
  }
}

void loop() {
  KlintoNode::instance().loop();
  if (g_battPin >= 0) {
    const uint32_t now = millis();
    if (now - g_lastBatteryMs > 30000UL) {
      g_lastBatteryMs = now;
      KlintoNode::instance().setBattery(readBatteryPercent(), readCharging());
    }
  }
}
