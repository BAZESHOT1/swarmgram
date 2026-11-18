# Прошивка модулей и сборщик

Исходники: `firmware/klinto_core` (`src/`, `include/`, скетч `klinto_module_kmesh_v1.ino`). Версия — файл `VERSION` (1.4), номер сборки — `BUILD` (монотонный, uint16; нужен для анти-отката OTA). Модуль сообщает прошивку как `<VERSION>/<BUILD>`.

## Роли и платы

| Роль | Что делает |
| --- | --- |
| **wearable** (носимый) | BLE-мост к телефону + радио (ESP-NOW и/или LoRa); телефон подключается к нему по BLE/USB |
| **repeater** | Ретранслирует пакеты, BLE для настройки |
| **gateway** | Подключается к Wi‑Fi роутеру, выходит в Hub (HTTP), раздаёт кластер |

Платы: ESP32 (Lite), ESP32‑C3, C5, C6, S3. Интерфейсы: ESP-NOW (Wi‑Fi LR), LoRa, либо оба с мостом между ними.

## Слои прошивки (`src`)

| Файл | Назначение |
| --- | --- |
| `klinto_runtime.cpp` | Жизненный цикл узла: конфиг, NVS, инициализация интерфейсов, радио-счётчики, имя модуля (`KL_MODULE_NAME`, NVS `name`) |
| `klinto_ble_link.cpp` | BLE (NimBLE-Arduino 2.5.2): GATT-сервис, кольцевой буфер RX, подписка, параметры соединения |
| `klinto_bridge.cpp` | Мост клиент↔сеть: кадры `KMesh_v1` (magic `0x53 0x47`, версия 3), INFO (имя, соседи `nb`), RPC_UP/RPC_DOWN |
| `klinto_router.cpp` | Маршрутизация, дедупликация, маяки, GW_PROBE, подтверждения (ACK, статус «синхронизировано с Hub») |
| `klinto_cell.cpp` | «Ячейка» — выбор Wi‑Fi канала кластера, зонды, тихий режим при BLE |
| `klinto_espnow.cpp` | ESP-NOW интерфейс |
| `klinto_lora.cpp` | LoRa через RadioLib 8 (SX1262, SX1278, SX1276, LR2021), CAD + CSMA, учёт airtime; SPI-пины из конфигурации |
| `klinto_gateway.cpp`, `klinto_http_gateway.cpp` | Шлюз: presence, relay, архив, опрос downlink у Hub |
| `klinto_ota*.cpp` | OTA: подписанные образы, патчи, откат |
| `klinto_crypto.cpp`, `klinto_owner.cpp` | Крипто-примитивы и подтверждение владельца (claim token) |
| `klinto_config.cpp` | Структура конфигурации и JSON-разбор |

## Конфигурация

Параметры (плата, роль, пины LoRa, делитель батареи, имя, LoRa-чип, Wi‑Fi шлюза) попадают в `config.h`, который генерирует сборщик; часть можно менять на лету командой CONFIG по BLE/USB (например, `name`, Wi‑Fi шлюза). Пины и чип LoRa задаются при сборке (плановая замена — удалённая настройка, этап 4).

## Сборщик (`services/firmware-builder`)

HTTP-сервис в контейнере `klinto-firmware` (порт 8090):

1. Принимает JSON-конфиг от Hub (`POST /build`), генерирует `config.h` (`generateConfigHeader`) и временный скетч.
2. Копирует `src/`/`include/` из `/app/klinto_core` (на хосте — `/opt/swarmgram/firmware/klinto_core`, том только для чтения).
3. Запускает `arduino-cli compile` (ядро ESP32 3.3.12; для классического ESP32 — большой слот OTA).
4. Библиотеки ставит `entrypoint.sh`: LoRa 0.8.0, ArduinoJson 7.4.3, NimBLE-Arduino 2.5.2, RadioLib 8.0.0.
5. Возвращает `bin` (и merged-образ для прошивки с адреса 0), версию и `firmwareBuild`.

Важно: сборка использует **файлы на хосте**, а `server.mjs` — копию в контейнере; при обновлении нужно обновить и то и другое (`docker cp` + перезапуск), иначе сервис отдаст старую версию.

## Отладка

`/health` сборщика показывает `firmwareVersion` и `firmwareBuild`. Логи модуля — Serial 115200; в приложении — «О приложении → Журнал» (теги `[ble]`, `[kmesh]`). Подробности — `ref-module-debug.md`.
