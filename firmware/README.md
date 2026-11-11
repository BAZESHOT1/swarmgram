#!/usr/bin/env python3
"""
Прошивка-референс ESP32-модуля SwarmGram (Arduino/PlatformIO-совместимый файл).
Хранится как reference: залить можно Arduino IDE 1.8+/esptool.

Режимы работы (единая прошивка):
  1) Базовый модуль: WiFi + BLE  (kind: wifi)
  2) LoRa-модуль:      WiFi + BLE + LoRa SX1276 (kind: lora)

Библиотеки:
  WiFi.h, HTTPClient.h, NimBLE-Arduino (или BLE-совместимая), Async HTTPS.
  Для LoRa: Sandeep Mistry arduino-LoRa.

Поля основного JSON в /v1/modules/checkin:
  {
    "battery": 76,
    "firmware": "1.0.0",
    "gateway": true,
    "neighbors": [{"uuid":"esp32-xxx","rssi":-58,"channel":"ble","hasGateway":false}]
  }

Аутентификация Hub: Bearer <module_token> в Header `Authorization`.
Токен выдаётся при привязке из клиентского приложения по BLE.
"""
