# SwarmGram firmware builder

Отдельный build-сервис, который собирает прошивки ESP32 по JSON-конфигурации
из визарда клиента. Внутри — `arduino-cli`, шаблон скетча и HTTP-обёртка без
внешних npm-зависимостей.

## Возможности

- `POST /build` — принимает `FirmwareConfig`, генерирует `config.h` и
  `swarm_module.ino`, запускает `arduino-cli compile`, возвращает `.bin`
  в base64.
- Кэш по `sha256(config)` в `/data/cache` (TTL 7 дней).
- Очередь: одновременно выполняется один билд, остальные ждут.
- Таймаут компиляции — 300 с.
- Платы: `esp32c3` → `esp32:esp32:esp32c3`, `esp32` → `esp32:esp32:esp32`,
  `esp32s3` → `esp32:esp32:esp32s3`; схема разделов `min_spiffs`
  (1.9 МБ app + OTA — прошивка с BLE/LoRa/mesh ~1.8 МБ).
- LoRa: глобальный профиль 869.525 МГц / SF9 / BW125 / CR4/5 / sync 0x12,
  SX1278/SX1276 через `LoRa`, SX1262 через `RadioLib`.
- Единая сеть `SG-MESH` (скрытая, канал 11), 8-значный publicId из MAC,
  роли wearable/repeater/gateway, BLE GATT + USB CDC, очередь LittleFS,
  LoRa mesh с TTL/hops (14 Wi-Fi / 12 LoRa).
- Wi-Fi и LoRa работают одновременно: узел с обеими средами пересылает
  пакеты между ними (bridge), дедуп по `packetId` общий.
- LoRa-фрагментация: крупные конверты режутся на 150 Б × до 16 фрагментов
  (тип `MT_FRAG`), сборка по `packetId`, ACK на исходный пакет.
- Смена Wi-Fi роутера шлюза из приложения кадром `SET_CONFIG` (USB/BLE),
  сохраняется в NVS и применяется без перепрошивки.
- По умолчанию выбрана **C3**; для ESP32 Lite/S3 добавьте плату в
  `ESP32_BOARDS` — на текущем сервере не хватает диска на все тулчейны.
- ESP32 core 3.x поддерживается параметром `ESP32_CORE_VERSION`, но на
  этом VPS не помещается (нужно >2.5–3 ГБ свободно). Сейчас 2.0.17.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|------------|--------------|------------|
| `PORT` | `8090` | HTTP-порт сервиса |
| `DATA_DIR` | `/data` | Том: ядро Arduino, кэш, временные сборки |
| `ESP32_CORE_VERSION` | `2.0.17` | Версия ядра `esp32:esp32` (2.0.17 компактнее и стабильнее для LoRa/RadioLib) |
| `ESP32_BOARDS` | `esp32c3` | Платы через запятую: `esp32c3`, `esp32`, `esp32s3`. Для каждой ставится только её gcc-тулчейн; полный набор не влезает на диск 10 ГБ |
| `MIN_FREE_MB` | `2200` | Минимум свободного места для установки (C3-only: пик ~1.5–2 ГБ) |
| `MIN_BUILD_FREE_MB` | `300` | Минимум свободного места во время сборки |
| `SKIP_CORE_INSTALL` | `0` | `1` — не ставить ядро при старте (офлайн/отладка) |

Сборщик ставит только нужные тулчейны: индекс ESP32 урезается на лету
(esptool, mkspiffs/mklittlefs + gcc выбранных плат). Библиотеки пинятся:
`LoRa@0.8.0`, `ArduinoJson@7.4.3`, `RadioLib@6.6.0` (8.x ломает API SX1262).
В образ добавлены `python3`, `python3-serial`, `cryptography`, `ecdsa` — без
них esptool не запускается.

Arduino-окружение задаётся в entrypoint:

- `ARDUINO_DIRECTORIES_DATA=$DATA_DIR/arduino`
- `ARDUINO_DIRECTORIES_USER=$DATA_DIR/arduino-user`

## Сборка и запуск

Сервис вынесен в профиль `firmware` и **не запускается** обычным
`docker compose up`. По умолчанию ставится только `esp32c3` (~1.5–2 ГБ);
каждая дополнительная плата добавляет ~500 МБ распакованного тулчейна.
На сервере с 10 ГБ диска держите одну плату, иначе установка заполнит диск.

```bash
# из корня репозитория
docker compose -f docker-compose.hub.yml --profile firmware up -d --build firmware-builder
```

Проверить, что ядро готово:

```bash
docker compose -f docker-compose.hub.yml --profile firmware exec firmware-builder \
  curl -s http://localhost:8090/health
# {"ok":true,"core":true,"freeMb":...,"coreVersion":"2.0.17"}
```

При **первом** старте entrypoint скачивает индекс ESP32, ставит core
`esp32:esp32@<версия>` и библиотеки `LoRa`, `ArduinoJson`, `RadioLib`. Это
занимает несколько минут. Последующие запуски используют том
`firmware_data`.

Если на диске меньше `MIN_FREE_MB`, установка пропускается, контейнер
**остаётся запущенным**, `/health` отвечает `core:false`, а `POST /build`
возвращает `503 esp32_core_missing` с объяснением. Hub в этом случае
отвечает `503 service_unavailable` до создания записи сборки.

Локально без Docker (нужен установленный `arduino-cli` и core esp32):

```bash
cd services/firmware-builder
DATA_DIR=./.data PORT=8090 node server.mjs
```

Затем укажите Hub на этот сборщик (в `docker-compose.hub.yml` или `.env`):

```yaml
FIRMWARE_BUILDER_URL: http://host.docker.internal:8090
```

или через переменную окружения при запуске Hub. Так сборка может жить на
мощной машине, а Hub — на слабом сервере.

## API

### `GET /health`

```json
{ "ok": true, "core": true, "freeMb": 4200, "coreVersion": "2.0.17" }
```

`core: false` означает, что ядро ESP32 не установлено/недоступно —
сборки вернут `503 esp32_core_missing`.

### `POST /build`

Тело — сам `FirmwareConfig` (без обёртки):

```json
{
  "board": "esp32c3",
  "role": "gateway",
  "connectivity": "wifi_lora",
  "wifi": { "ssid": "home", "password": "secret" },
  "hubUrl": "http://hub:8080",
  "moduleToken": "<jwt>",
  "lora": {
    "chip": "sx1278",
    "frequencyMhz": 868,
    "spreadingFactor": 9,
    "bandwidthKhz": 125,
    "syncWord": 18,
    "pins": { "sck": 4, "miso": 5, "mosi": 6, "cs": 7, "rst": 3, "dio0": 2 }
  },
  "battery": { "enabled": true, "pin": 0, "ratio": 2, "intervalSec": 300 },
  "ota": true
}
```

Успех (`200`):

```json
{ "ok": true, "binBase64": "...", "size": 812345, "sha256": "...", "version": "1.0.0-ab12cd34", "log": "..." }
```

Ошибка (`422`):

```json
{ "ok": false, "error": "binary_not_found", "log": "..." }
```

Префлайт-ошибки (`503`):

| `error` | Причина |
|---------|---------|
| `esp32_core_missing` | Ядро ESP32 не установлено (обычно не хватило диска) |
| `insufficient_disk_space` | Свободно меньше `MIN_BUILD_FREE_MB` во время сборки |

## Рекомендуемые пины

| Плата | SCK | MISO | MOSI | CS | RST | DIO0 | BUSY | Battery |
|-------|-----|------|------|----|-----|------|------|---------|
| esp32c3 | 4 | 5 | 6 | 7 | 3 | 2 | 10 | ADC0 (0) |
| esp32 | 18 | 19 | 23 | 5 | 14 | 26 | 27 | 34 |
| esp32s3 | 12 | 13 | 11 | 10 | 9 | 8 | 7 | 1 |

Сервер пины не валидирует — это ответственность визарда.

## Проверка сборки вручную

Сервис не публикует порт наружу (доступен только внутри сети `swarm`),
поэтому проверяем изнутри контейнера:

```bash
docker compose -f docker-compose.hub.yml --profile firmware exec firmware-builder curl -s http://localhost:8090/health

docker compose -f docker-compose.hub.yml --profile firmware exec firmware-builder \
  curl -s -X POST http://localhost:8090/build \
  -H 'content-type: application/json' \
  -d '{"board":"esp32c3","role":"gateway","connectivity":"wifi","wifi":{"ssid":"test","password":"test"},"hubUrl":"http://hub:8080","ota":true}' \
  | head -c 300
```

Если сервис запущен локально (`node server.mjs`), используйте
`http://localhost:8090` напрямую.

Проверка через Hub API (нужен access token):

```bash
curl -s -X POST http://localhost:8080/v1/firmware/build \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"config":{"board":"esp32c3","role":"gateway","connectivity":"wifi","wifi":{"ssid":"test","password":"test"},"hubUrl":"http://hub:8080","ota":true}}'

curl -s http://localhost:8080/v1/firmware/builds -H "authorization: Bearer $TOKEN"
```

## Ограничения

- Один параллельный билд: при наплыве запросы ждут в очереди (таймаут
  компиляции — 300 с; SX1262/RadioLib на 1 vCPU собирается ~150 с).
- Первая сборка после старта контейнера дольше (компиляция ядра/библиотек
  из кэша arduino-cli).
- Том `firmware_data` быстро растёт при установке ядра; кэш бинарников
  хранится 7 дней и не чистится автоматически (чистите по cron при
  необходимости).
- Образ намеренно **без** ESP32 core — это ускоряет docker build, но первый
  запуск контейнера долгий. Ядро версионируется через `ESP32_CORE_VERSION`
  (по умолчанию `2.0.17`), чтобы не тянуть лишние ~0.5–1 ГБ, как у 3.x.
- Сборщик выключен по умолчанию (compose-профиль `firmware`). На хосте с
  < 4 ГБ свободного диска используйте локальный сборщик и
  `FIRMWARE_BUILDER_URL`.
- Для SX1262 библиотека RadioLib требует корректный BUSY-пин; если
  `busy` не задан, используется `-1` и инициализация может не пройти.
- Очередь не ограничена по длине: несколько одновременных запросов ждут
  друг друга, а Hub таймаутит запрос через 190 с.
