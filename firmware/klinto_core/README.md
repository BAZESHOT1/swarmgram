# Ядро Klinto KMesh_v1

Портируемое ядро на C++11, общее для прошивки ESP32, host-тестов и
документации протокола. Заголовки Arduino/ESP-IDF используются только в
файлах под `#if defined(ESP32)`.

```
include/
  klinto_config.h        конфигурация, роли, пины LoRa из NVS
  klinto_packet.h        единый заголовок MeshPacket (35 байт)
  klinto_codec.h         бинарные RPC + Unishox2
  klinto_crypto.h        ChaCha20 + HMAC-SHA256 и постоянная подпись
  klinto_dedup.h         кольцо дедупликации на 512 записей
  klinto_router.h        AODV + градиент шлюзов + RSSI-подавление
  klinto_net.h           INetInterface и RX-кольцо
  klinto_flash_queue.h   энергонезависимое кольцо на 100 слотов
  klinto_gateway.h       транслятор в MQTT/HTTP
  klinto_bridge.h        BLE/Serial-кадрирование и фрагментация
  klinto_espnow.h        ESP-NOW только через broadcast
  klinto_lora.h          RadioLib + CAD/CSMA + приоритеты
  klinto_mqtt.h          минимальный MQTT 3.1.1 поверх TLS
  klinto_ble_link.h      GATT-транспорт a5c0
  klinto_channel_plan.h  частотный план 13 радиосот
  klinto_cell.h          выбор соты и хэндовер
  klinto_platform_esp32.h NVS/LittleFS и платформенные хуки
  klinto_runtime.h       задачи FreeRTOS
src/                     реализации + встроенный unishox2.c
test/                    host-тесты и векторы C↔TS
```

## Host-тесты

```bash
# Linux/macOS
make test

# Windows (zig, Visual Studio не нужен)
powershell -File run_tests.ps1
```

Проверяются SHA-256/HMAC, поток ChaCha20 по RFC 8439, сериализация пакета
и CRC, Unishox2 для русского и английского, обнаружение подмены, кольцо
дедупликации, AODV, RSSI-подавление маяков, LittleFS-кольцо, сквозной путь
BLE-моста, транслятор шлюза, частотный план и хэндовер между сотами.

## Инварианты

- Один заголовок, один CRC, никакой пересборки между ESP-NOW ↔ LoRa ↔ интернет.
- ESP-NOW использует **один broadcast peer**; фильтр — `next_hop_id`.
- Сжатие всегда выполняется до шифрования.
- В горячем пути нет `String`, `new` и `malloc`; все очереди фиксированные.
- Радиоколлбэки только копируют байты; разбор — в задаче роутера.
- ID узлов 0, 1 и `0xFFFFFFFF` зарезервированы.
