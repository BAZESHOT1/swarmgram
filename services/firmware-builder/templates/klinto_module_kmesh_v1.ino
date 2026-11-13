/**
 * Прошивка Klinto KMesh_v1 — точка входа.
 *
 * Сетевой стек живёт в klinto_core (портируемый C++); скетч только передаёт
 * значения по умолчанию из config.h в KlintoNode и обслуживает периферию
 * платы (телеметрия батареи).
 */
#include <Arduino.h>

#include "config.h"
#include "klinto_runtime.h"

#if defined(KL_BATT_ENABLED) && KL_BATT_ENABLED
#ifndef KL_BATT_CHARGING_PIN
#define KL_BATT_CHARGING_PIN -1
#endif
static uint32_t g_lastBatteryMs = 0;

static uint8_t readBatteryPercent() {
  const int raw = analogRead(KL_BATT_PIN);
  const float voltage = (raw / 4095.0f) * 3.3f * KL_BATT_RATIO;
  /* 3.3 В = 0%, 4.2 В = 100% для одного Li-ion элемента. */
  if (voltage >= 4.20f) return 100;
  if (voltage <= 3.30f) return 0;
  return (uint8_t)(((voltage - 3.30f) / 0.90f) * 100.0f);
}

static bool readCharging() {
  if (KL_BATT_CHARGING_PIN < 0) return false;
  return digitalRead(KL_BATT_CHARGING_PIN) == HIGH;
}
#endif

void setup() {
  KlintoNode::instance().begin();
#if defined(KL_BATT_ENABLED) && KL_BATT_ENABLED
  analogReadResolution(12);
  pinMode(KL_BATT_PIN, INPUT);
  if (KL_BATT_CHARGING_PIN >= 0) pinMode(KL_BATT_CHARGING_PIN, INPUT_PULLUP);
#endif
}

void loop() {
  KlintoNode::instance().loop();
#if defined(KL_BATT_ENABLED) && KL_BATT_ENABLED
  const uint32_t now = millis();
  if (now - g_lastBatteryMs > 30000UL) {
    g_lastBatteryMs = now;
    KlintoNode::instance().setBattery(readBatteryPercent(), readCharging());
  }
#endif
}
