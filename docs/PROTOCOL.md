# Протокол Klinto Mesh v2

Протокол обмена между модулями (ESP32) и модуля → Hub. Описывает
фактический формат пакетов прошивки `klinto_module.ino`; архитектура и
выбор транспорта — в `docs/module-mesh-architecture.md`.

Прикладной слой (API телефона через mesh) — **KMT v1**, см. `docs/KMT.md`.

## 1. Адресация

| Идентификатор | Размер | Как получается |
|---|---|---|
| `mesh_addr` | 6 байт | заводской MAC Wi-Fi STA (`esp_read_mac`, `ESP_MAC_WIFI_STA`) |
| `hardwareId` | строка | `esp32-<12 hex>` из того же MAC, кэш в NVS `klinto/hw_id` |
| `nodeId` | u32 | FNV-1a 32 от `hardwareId` |
| `cluster_id` | u32 | CRC32 по отсортированным строкам якорей через `\|`; `0` = кластера нет |
| `packetId` | u32 | случайный (`esp_random`), уникален в пределах отправителя |
| `publicId` | строка | `nodeId % 10^8`, 8 цифр — только для логов/UI |

`mesh_addr` один и тот же для Wi-Fi и LoRa. BLE MAC — алиас, в
маршрутизации не участвует.

Для таблиц маршрутов и поля `addr` в ADVERT используется 8-байтная проекция
`klinto_mesh_addr_from_u32(nodeId)`, а на проводе в `srcMac`/`dstMac` — реальные
6 байт MAC. Это разные представления одного узла, не два разных адреса.

## 2. MeshHeader (36 байт)

```c
#pragma pack(push, 1)
struct MeshHeader {
  uint8_t  magic0;      // 0x53 'S'
  uint8_t  magic1;      // 0x47 'G'
  uint8_t  ver;         // 1
  uint8_t  type;        // MeshType
  uint8_t  flags;       // зарезервировано, сейчас 0
  uint8_t  ttl;         // уменьшается на каждом хопе
  uint8_t  hop;         // счётчик хопов, у отправителя 0
  uint8_t  reserved;    // выравнивание
  uint16_t payloadLen;  // LE, <= 1024
  uint32_t src;         // LE, nodeId отправителя
  uint32_t dst;         // LE, nodeId | MESH_BROADCAST (0xFFFFFFFF)
  uint32_t packetId;    // LE, для ACK и dedup
  uint8_t  srcMac[6];   // mesh_addr отправителя
  uint8_t  dstMac[6];   // mesh_addr получателя, FF..FF = broadcast
  uint16_t crc;         // LE, CRC16-CCITT
};
#pragma pack(pop)
static_assert(sizeof(MeshHeader) == 36);
```

- CRC16-CCITT (poly `0x1021`, init `0xFFFF`) считается по заголовку с
  `crc = 0` плюс payload. Пакет с неверным CRC отбрасывается.
- `dstMac` заполняется по таблице соседей; для неизвестного узла — нули,
  доставка идёт по `dst`.
- Лимиты payload: ESP-NOW v1 кадр ≤ 240 байт, LoRa ≤ 180 байт, общий
  предел `KL_MAX_PAYLOAD = 1024`. Крупное режется `MT_FRAG`.

## 3. Типы пакетов

```c
enum MeshType {
  MT_ADVERT       = 1,
  MT_DATA         = 2,
  MT_ACK          = 3,
  MT_ROUTE_REQ    = 4,
  MT_ROUTE_REP    = 5,
  MT_PRESENCE     = 6,
  MT_FRAG         = 7,
  MT_DISCOVER     = 8,
  MT_DISCOVER_ACK = 9,
  MT_LORA_ADVERT  = 10,
  MT_LORA_DATA    = 11,
};
```

| Type | Имя | Payload | Транспорт |
|---|---|---|---|
| 1 | `MT_ADVERT` | JSON beacon (раздел 4.1) | broadcast, ESP-NOW + LoRa |
| 2 | `MT_DATA` | JSON KMT / handover / HTTP-туннель | unicast или broadcast |
| 3 | `MT_ACK` | `[ackedPacketId u32]` | unicast |
| 4 | `MT_ROUTE_REQ` | `[target u32]` | broadcast |
| 5 | `MT_ROUTE_REP` | `[target u32][nextHop u32][metric u16][hops u8]` | unicast |
| 6 | `MT_PRESENCE` | JSON (раздел 4.2) | broadcast |
| 7 | `MT_FRAG` | `[origId u32][index u8][total u8][chunk ≤150]` | ESP-NOW или LoRa |
| 8 | `MT_DISCOVER` | JSON (раздел 4.3) | broadcast, только ESP-NOW |
| 9 | `MT_DISCOVER_ACK` | `{"ch":N,"cluster_id":N}` | unicast |
| 10 | `MT_LORA_ADVERT` | JSON (раздел 4.4) | broadcast, только LoRa |
| 11 | `MT_LORA_DATA` | произвольный payload | `dst = cluster_id` |

Порядок байт полей payload — little-endian (`readLe32`/`writeLe32`).

### 3.1 MT_FRAG

Фрагментация одинакова для ESP-NOW и LoRa:

```text
payload = origId u32 | index u8 | total u8 | chunk (<= 150 байт)
```

- `total <= 16` (`KL_MAX_FRAGMENTS`), сборка в 2 слотах.
- `packetId` фрагмента = `origId ^ ((index + 1) << 24)`.
- После сборки пакет проходит обычный путь `handleMeshPacket` (локальная
  обработка + пересылка). Лог: `[frag] reassembled …`.

## 4. JSON payload

### 4.1 ADVERT

Отправляется каждые 8 с первые 2 минуты, затем каждые 30 с.

```json
{
  "id": 123456789,
  "role": "gateway",
  "gw": 1,
  "batt": 87,
  "q": 3,
  "n": 5,
  "addr": "a1b2c3d4e5f60718",
  "cluster_id": 305419896,
  "border": 0,
  "hw": "esp32-aabbccddeeff",
  "mesh_addr": "aabbccddeeff",
  "ble_mac": "aa:bb:cc:dd:ee:ff",
  "is_anchor": 1,
  "hues": ["wifi", "lora", "ble"],
  "load": 0.01,
  "neighbor_clusters": [305419897],
  "ch": 6,
  "cap_lora": 1,
  "lora_bridge": 1
}
```

| Поле | Смысл |
|---|---|
| `id` | `nodeId` отправителя |
| `role` | `gateway` / `repeater` / `wearable` |
| `gw` | 1, если есть рабочий uplink в Hub (у шлюза) или виден шлюз |
| `batt` | заряд, % |
| `q` | глубина mesh-очереди, записей |
| `n` | число видимых соседей |
| `addr` | 8-байтный mesh-адрес в hex (проекция `nodeId`) |
| `cluster_id` | текущий кластер |
| `border` | 1 — узел объявил себя border |
| `hw` | канонический `hardwareId` |
| `mesh_addr` | MAC без префикса `esp32-` |
| `ble_mac` | BLE-алиас |
| `is_anchor` | 1 для gateway и repeater (входит в `cluster_id`) |
| `hues` | доступные транспорты |
| `load` | `q / 255`, 0..1 |
| `neighbor_clusters` | до 2 чужих `cluster_id` |
| `ch` | текущий mesh-канал 1..13; по нему работает `channelDiscover` |
| `cap_lora` | 1, если LoRa включён в конфиге **и** радио инициализировано |
| `lora_bridge` | 1, если узел готов пересылать `MT_LORA_DATA` |

### 4.2 PRESENCE

Каждые 15 с; не отправляется при `q > 120`.

```json
{"id":123456789,"batt":87,"addr":"a1b2c3d4e5f60718","cluster_id":305419896,
 "border":0,"hw":"esp32-aabbccddeeff","mesh_addr":"aabbccddeeff",
 "ble_mac":"aa:bb:cc:dd:ee:ff","is_anchor":0,"hues":["wifi","ble"],
 "load":0.0,"neighbor_clusters":[],"ch":6,"cap_lora":0,"lora_bridge":0}
```

Набор полей тот же, что у ADVERT (общая функция `appendBeaconFields`), но без
`role`, `gw`, `q`, `n`.

### 4.3 DISCOVER / DISCOVER_ACK

```json
// MT_DISCOVER (broadcast, от узла)
{"hw":"esp32-aabbccddeeff","role":"wearable","nonce":274839201}

// MT_DISCOVER_ACK (unicast, только от шлюза)
{"ch":6,"cluster_id":305419896}
```

### 4.4 LORA_ADVERT

```json
{"cluster_id":305419896,"gw":1,"ch":6,"hw":"esp32-aabbccddeeff"}
```

### 4.5 Handover

Передаётся как `MT_DATA` с `"kind":"handover"`:

```json
{"kind":"handover","op":"request","from":123456789,"to":987654321,
 "cluster":305419897,"role":"wearable"}
```

| `op` | Кто шлёт | Смысл |
|---|---|---|
| `request` | wearable | просит перевод в `cluster` |
| `accept` | border | подтверждает, временный маршрут через border |
| `complete` | wearable | 3 стабильных beacon, кластер закреплён |
| `retry` | wearable | повтор после 3 с (до 3 попыток) |
| `reject` | узел | не border / чужой кластер |
| `abort` | обе стороны | таймаут 10 с, возврат в исходный кластер |

Параметры и состояния — `docs/module-mesh-architecture.md`, раздел 3.

## 5. channelDiscover

Узел не ассоциируется с Wi-Fi: ему нужен только канал шлюза.

```text
wearable/repeater                     gateway (AP + STA к роутеру)
      |                                        |
      | ch = 1                                 | канал = канал роутера
      |-- MT_DISCOVER (bcast, x2) ------------>|
      |         (140 мс ожидания)              |
      |                                        |
      |<-- MT_DISCOVER_ACK {"ch":6} -----------|
      |    или ADVERT с "ch":6                 |
      |                                        |
   gEspNowChannel = 6                          |
   espNowReinitOnChannel(6)                    |
      |-- ADVERT/PRESENCE -------------------->|
```

Критерии:

| Условие | Значение |
|---|---|
| Диапазон | 1..13 |
| Таймаут на канал | 140 мс |
| Повторов DISCOVER на канал | 2 |
| Типичное время до успеха | ≈1.8 с (13 × 140 мс), критерий < 2 с |
| Повтор поиска | не чаще 1 раза в 60 с, пока `espnow rx == 0` |
| Ответчик | только `gateway` |
| Fallback | скан SoftAP `SG-MESH`, канал найденного AP без ассоциации |

Успех фиксируется логом `[channel] discovered ch=N`; канал попадает в
`gApChannel`, `gEspNowChannel`, `gDiscoveredChannel`.

## 6. LoRa-мост

Правило пересылки: `dst` в `MT_LORA_DATA` — это **cluster_id**.

```text
if dst == gNodeId || dst == 0xFFFFFFFF:
    доставить локально (wearable -> BLE, gateway -> очередь Hub)
else:
    r = loraClusterRouteFind(dst)      // cluster_id -> nextHop, TTL 10 мин
    if r != null: transmitLoraBridge(MT_LORA_DATA, r->nextHop, payload, ttl=2)
    else: drop
```

- Таблица `cluster_id -> nextHop` наполняется из `MT_LORA_ADVERT`
  (каждые ~180 с).
- Пакет с `dst = cluster_id` не флудится по Wi-Fi.
- Лимит одного кадра — 180 байт; больше — `MT_FRAG`.
- Медиа/OTA через LoRa запрещены на уровне `select_route`.

## 7. Маршрутизация (кратко)

| Параметр | ESP-NOW | LoRa |
|---|---|---|
| TTL | 16 | 8 в маршруте, до 12 у broadcast |
| Expiry маршрута | 300 с | 900 с |
| Порог предпочтения | 120 | 400 |

```text
metric = ewma_ms + hops * 35 + queue_depth * 8
```

- Reverse learning: `routeLearn(src, src, iface, hop+1, ewma)`.
- Path request: `MT_ROUTE_REQ`, повтор каждые 3 с (до 3 раз), через 9 с —
  flood.
- Dedup: `hash(src, packetId)`, кольцо 256 записей, TTL 60 с.
- Медиа и OTA — только ESP-NOW.

## 8. KMT v1

Klinto Mesh Transport инкапсулирует HTTP API приложения в `MT_DATA`:
AES-256-GCM blob, `chatId="__http__"`, `kind:"http"` / `"http_resp"` /
`"http_resend"`, чанки по 280 байт, id идемпотентности, повторная отправка
потерянных чанков. Полное описание, ключи и ограничения — `docs/KMT.md`.

Клиент ходит в mesh только при `transportOnline == false` и живом модуле
(`client/src/data/api.ts` → `meshHttpAvailable()` в
`client/src/modules/meshHttp.ts`). Запросы вне allowlist
(`/v1/admin`, `/v1/auth`, `/v1/objects`, `/v1/uploads`) через mesh не
проксируются.

## 9. Traffic classes

| Класс | Приоритет | Интерфейс | Примечание |
|---|---|---|---|
| `text` | high | любой | основной трафик KMT |
| `telemetry` | low | LoRa | ADVERT/PRESENCE, ACK |
| `search` | medium | LoRa при недоступном Wi-Fi | JSON < 1 КБ |
| `ota` | chunked | только ESP-NOW | 4 КБ чанки |
| `media` | best-effort | только ESP-NOW | по LoRa не отправляется |

Определение класса — по префиксу JSON `"kind"` в первых 160 байтах
(`meshV2TrafficFor`).

## 10. Presence и offline

- `ONLINE_SERVER` — есть интернет/шлюз, heartbeat < 5 с.
- `ONLINE_MESH` — сервера нет, но есть ACK получателя по mesh.
- `OFFLINE_QUEUED` — запись в outbox, ACK нет.

Очередь модуля (`/queue.log`, LittleFS) хранит до 200 записей с TTL 72 ч.
Uplink: `QK_HUB` — запись уходит в Hub; downlink: broadcast `MT_DATA` с
повтором, дубли отсекаются по `packetId`. При handover записи шлются дважды
(cluster-agnostic).

## 11. Telemetry / OTA (серверный уровень)

```text
TELEMETRY_REQUEST { target_mesh_addr, metrics[], request_id }
TELEMETRY_REPORT  { request_id, target_mesh_addr, values{}, ts }
```

Rate limit: 1 запрос на модуль / 30 с. Cluster OTA — только ESP-NOW:

```text
OTA_ANNOUNCE      { firmware_hash, total_chunks, chunk_size }
OTA_CHUNK_REQUEST { firmware_hash, chunk_index }
OTA_CHUNK         { firmware_hash, index, data[4 KiB] }
```
