# Klinto KMesh_v1 — архитектура и протокол

> Единый документ для прошивки, клиентского приложения и серверного бэкенда.
> Версия протокола: **KMesh_v1** (поле `version` = 3). Все многобайтные поля — little-endian, если не указано иное.

---

## 0. Аудит репозитория и план миграции

### 0.1 Что было

| Компонент | Где жил | Проблема |
| --- | --- | --- |
| Прошивка ESP32 | `services/firmware-builder/templates/klinto_module_v2.ino` (~195 KB, один файл) | ESP-NOW через `esp_now_add_peer` на каждого соседа → лимит 20 пиров; JSON на радио; `String`/`malloc` в горячем пути; mesh v2 и Wi-Fi UDP конкурируют |
| Сетевые структуры | `MeshHeader` 36 байт в том же `.ino`, `docs/PROTOCOL.md` | Нет `msg_uuid` и сквозной истории; поле `next_hop` отсутствует |
| Mesh v2 | `templates/mesh_v2/*.c` (cluster/border/handover) | Полезен для v2, но не решает лимит пиров и broadcast-шторм |
| Клиент | `client/` Expo/React Native; BLE `a5c0`; `src/modules/protocol.ts` (рамка JSON) | Тяжёлый JSONL/RPC; нет бинарного RPC; offline-очередь только Ed25519-аудит |
| Крипто | `client/src/crypto/core.ts` (ECDSA P-256, XChaCha20-Poly1305), `mesh/OfflineCryptoService.ts` | Ключи чата/устройства есть, но транспортный и постоянный ключи не разделены |
| Hub | `services/hub` Fastify + PostgreSQL | `POST /v1/mesh/relay`, `/v1/mesh/sync` уже есть; `offline_sync_batches` только аудит, не история |

### 0.2 Что сделано в KMesh_v1

| Файл/каталог | Назначение |
| --- | --- |
| `firmware/klinto_core/` | Новый портируемый C++11 стек: кодек, пакет, крипто, роутер, интерфейсы, BLE/MQTT, FreeRTOS |
| `services/firmware-builder/templates/klinto_module_kmesh_v1.ino` | Новый entry-point; builder переключается флагом `kmesh.v1` |
| `services/firmware-builder/server.mjs` | Генерация `KL_KMESH_V1`, `KL_TEMP_MESH_KEY`; копирование `klinto_core` в скетч |
| `services/hub/sql/035_mesh_v3.sql` + `036_kmesh_v1_rename.sql` | `kmesh_v1_presence`, `kmesh_v1_archive`, `kmesh_v1_messages`, `kmesh_v1_gateways`, `messages.msg_uuid` |
| `services/hub/src/routes/kmeshV1.ts` | Архив, presence, sync, история, ACK |
| `client/src/kmesh/v1/*` | Бинарный протокол, крипто, клиент синхронизации |
| `client/src/modules/bleKMeshV1.*` | BLE-транспорт нового протокола |
| `client/src/data/db.ts` | Локальная таблица `kmesh_v1_outbox` (SQLite/KV) |
| `ARCHITECTURE_AND_PROTOCOL.md` | Этот документ |

### 0.3 Совместимость и откат

- v2-прошивка и v2-маршруты **не удалены**. Переключение — `kmesh.v1: true` в конфиге сборки.
- Пакеты KMesh_v1 имеют `magic = 0xA7`, `version = 3`; старые `'S','G'` кадры игнорируются.
- Hub-роуты `/v1/mesh/*` остаются; новые `/v1/kmesh/v1/*` живут параллельно.
- Клиент может работать в v2, пока пользователь не подключит модуль KMesh_v1.

---

## 1. Слои и общая схема

```
┌────────────────────────────── Phone / PC ──────────────────────────────┐
│ UI → KMeshV1Client (binary RPC) → BLE GATT a5c0 → ESP32 ClientBridge   │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ RPC_UP / RPC_DOWN / STATUS (binary)
┌───────────────────────────────────▼───────────────────────────────────┐
│                         ESP32 firmware (klinto_core)                    │
│  PayloadCodec (Unishox2) → Crypto (ChaCha20+HMAC) → MeshPacket        │
│  MeshRouter (dedup, AODV, gateway gradient, ACK, RSSI suppression)    │
│  INetInterface: EspNowInterface | LoraInterface | GatewayInetInterface│
└───────────────┬───────────────────────────────┬───────────────────────┘
                │ ESP-NOW broadcast             │ LoRa (SX1262/SX127x)
        ┌───────▼────────┐              ┌───────▼────────┐
        │ NODE_ROUTER    │◄────────────►│ NODE_ROUTER    │
        │ cross-band     │              │ cross-band     │
        └───────┬────────┘              └───────┬────────┘
                │                               │
        ┌───────▼───────────────────────────────▼───────┐
        │ NODE_GATEWAY (Wi-Fi/Ethernet/LTE)             │
        │ MQTT/TLS: klinto/kmesh/v1/gw/<gw>/up|down|presence      │
        └───────────────────┬───────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │ Hub / backend  │  pending_sync → permanent history
                    └────────────────┘
```

**Ключевой инвариант:** `MeshPacket` не пересобирается при переходе ESP-NOW → LoRa → MQTT. Меняются только `ttl`, `hop_count`, `next_hop_id` и пересчитывается CRC.

---

## 2. Слой 1 — PayloadCodec (Unishox2 + бинарные RPC)

### 2.1 Порядок операций

```
UTF-8 текст → Unishox2 → RPC-структура → ChaCha20+HMAC → MeshPacket.payload
```

Сжатие **всегда до шифрования**. Сжатием занимается прошивка (тонкий прокси-адаптер), поэтому приложение не тащит C-порт Unishox2 и не зависит от версии библиотеки. Если приложение присылает уже сжатый RPC (`RPC_FLAG_COMPRESSED`), прошивка его не пережимает.

### 2.2 Общий префикс RPC (4 байта)

| offset | size | поле |
| --- | --- | --- |
| 0 | 1 | `op` |
| 1 | 1 | `rpc_flags` |
| 2 | 2 | `chat_ref` — 16-битный дескриптор чата, выдаваемый шлюзом/сервером |

`chat_ref = 0xFFFF` — служебный/отсутствующий чат.

### 2.3 Операции

| op | имя | тело | размер |
| --- | --- | --- | --- |
| `0x01` | `RPC_SEND_TEXT` | UTF-8 или Unishox2 текст | 4 + N |
| `0x02` | `RPC_MSG_ACK` | `acked_packet_id u32, status u8` | 9 |
| `0x03` | `RPC_MSG_READ` | — (msg_uuid в заголовке MeshPacket) | 4 |
| `0x04` | `RPC_LOCATION_PING` | `lat i32 (1e-7°), lon i32 (1e-7°), accuracy_m u16, battery u8` | 15 |
| `0x05` | `RPC_SYNC_REQUEST` | `since_server_seq u32, limit u8, chat_ref u16` | 11 |
| `0x06` | `RPC_SYNC_MESSAGE` | зарезервировано под пакетную выдачу | — |
| `0x07` | `RPC_PRESENCE` | `battery u8, rssi i8, role u8, caps u8` | 8 |

`rpc_flags`: `0x01 COMPRESSED`, `0x02 GROUP`, `0x04 REPLY`, `0x08 TYPING`.

### 2.4 Экономия Unishox2 (реальные замеры теста)

| Текст | UTF-8 | После Unishox2 |
| --- | --- | --- |
| `hello, meet me at the station at 8pm` | 36 B | **26 B** (28%) |
| `Привет, встречаемся в 8 вечера` | 54 B | **38 B** (30%) |

Для коротких фраз экономия 25–45%; для длинных сообщений с повторами — до 60%. Если сжатие не даёт выигрыша хотя бы в 1 байт, RPC уходит без флага `COMPRESSED`.

---

## 3. Слой 3 — MeshPacket

### 3.1 Заголовок (35 байт)

| offset | size | поле | назначение |
| --- | --- | --- | --- |
| 0 | 1 | `magic` = `0xA7` | фильтр чужих кадров |
| 1 | 1 | `version` = `3` | |
| 2 | 4 | `packet_id` | уникальный ID радиопакета; boot-salted счётчик |
| 6 | 8 | `msg_uuid` | глобальный Snowflake ID сообщения |
| 14 | 4 | `src_id` | ID отправителя |
| 18 | 4 | `dst_id` | получатель; `0xFFFFFFFF` broadcast; `0x00000001` any gateway |
| 22 | 4 | `next_hop_id` | конкретный сосед для приёма/ретрансляции |
| 26 | 4 | `last_hop_id` | узел, который физически передал кадр (обратный маршрут/ACK) |
| 30 | 1 | `type` | `DATA/ACK/RREQ/RREP/GW_BEACON/NODE_PRESENCE/SYNC_ARCHIVE` |
| 31 | 1 | `flags` | см. 3.3 |
| 32 | 1 | `ttl` | максимум прыжков (по умолчанию 7) |
| 33 | 1 | `hop_count` | сколько уже пройдено |
| 34 | 1 | `payload_len` | 0..200 |
| 35 | N | `payload` | RPC после сжатия и шифрования |
| 35+N | 2 | `crc16` | CRC16-CCITT (0x1021, init 0xFFFF) по header+payload |

Максимум: `35 + 200 + 2 = 237` байт → помещается в LoRa MTU 255 и ESP-NOW 250.

**Зарезервированные ID:** `0` (invalid), `1` (any gateway), `0xFFFFFFFF` (broadcast). Прошивка никогда не выдаёт узлу ID ≤ 1.

### 3.2 Типы

| type | значение | payload |
| --- | --- | --- |
| `DATA` | 1 | RPC (сжатый/зашифрованный) |
| `ACK` | 2 | `acked_packet_id u32, status u8` (RPC_MSG_ACK) |
| `RREQ` | 3 | `relay_id u32` |
| `RREP` | 4 | `relay_id u32` |
| `GW_BEACON` | 5 | `relay_id u32, gateway_id u32, load u8, caps u8` |
| `NODE_PRESENCE` | 6 | RPC_PRESENCE |
| `SYNC_ARCHIVE` | 7 | архивная копия RPC |

`relay_id` — критично для LoRa: там нет link-layer адреса отправителя. Каждый ретранслятор переписывает `relay_id = свой node_id`, поэтому получатель может направить обратный маршрут на конкретного соседа.

### 3.3 Флаги

| бит | имя | смысл |
| --- | --- | --- |
| 0x01 | `NEED_ACK` | требуется L3 ACK |
| 0x02 | `TO_INTERNET` | наверх к шлюзу |
| 0x04 | `FROM_INTERNET` | downlink из интернета |
| 0x08 | `TEMP_MESH_KEY` | транспортный ключ |
| 0x10 | `PERM_USER_KEY` | постоянный ключ пользователя |
| 0x20 | `NEED_CLOUD_ARCHIVE` | шлюз обязан сделать shadow copy |
| 0x40 | `COMPRESSED_UNISHOX` | payload содержит Unishox2 (внутри RPC также есть флаг) |
| 0x80 | `SERVER_RESIGN` | `0` = CLIENT_RESIGN, `1` = SERVER_RESIGN |

### 3.4 CRC и валидация

RX-коллбэк проверяет только `magic/version/payload_len/next_hop_id` (без CRC) — этого достаточно, чтобы отбросить чужие транзитные кадры дёшево. Полная проверка CRC и разбор — в задаче роутера.

---

## 4. Слой 2 — интерфейсы

Базовый класс `INetInterface`:

```cpp
bool init(const kl_config_t&);
bool sendPacket(const uint8_t*, size_t, uint32_t next_hop_id, uint8_t priority);
void poll(uint32_t now_ms);
bool isBusy() const;
uint16_t getMTU() const;
int8_t getLinkQuality() const;
uint8_t id() const;                    // 0 = ESP-NOW, 1 = LoRa
void setReceiveCallback(...);
```

### 4.1 EspNowInterface

- **Один peer** — `FF:FF:FF:FF:FF:FF`. `esp_now_add_peer` вызывается ровно один раз.
- Все кадры идут broadcast; фильтрация по `next_hop_id` — в RX-коллбэке:
  ```
  next_hop != BROADCAST && next_hop != my_id && !(gateway && next_hop == ANY)
      → drop, без копирования и без CRC
  ```
- Фиксированный канал Wi-Fi (`wifi_channel` из конфига).
- TX-очередь на 8 кадров; `sendPacket` не блокирует задачу роутера.

### 4.2 LoraInterface

- RadioLib; SX1262 / SX1276 / SX1278 выбираются в рантайме.
- Пины `NSS/SCK/MISO/MOSI/RST/DIO0/DIO1/BUSY` — из NVS/JSON.
- **CAD + CSMA/CA**: до 4 попыток `scanChannel()`; при занятом эфире — случайная задержка 20–180 мс.
- **Очередь приоритетов** (12 слотов):
  - `HIGH` — L3 ACK, RREP;
  - `MEDIUM` — DATA;
  - `LOW` — beacons, presence, телеметрия; дропается при заполнении > 70%.
- Бюджет рабочего цикла: `max_airtime_ms_per_min` (по умолчанию 36 000 мс/мин).
- Передача выполняется отдельной FreeRTOS-задачей; SPI не блокирует роутер.

### 4.3 GatewayInetInterface

MQTT 3.1.1 over TLS (или plain TCP) + Flash-очередь на 100 пакетов. При обрыве пакеты не теряются; `drain_queue()` использует `peek → publish → pop`, поэтому повторная отправка идемпотентна.

### 4.4 ClientBridgeInterface

BLE GATT (`a5c0`, TX `a5c1` notify, RX `a5c2` write, STATUS `a5c3`) или USB-Serial. Фрагментация — на уровне кадров (см. §7).

---

## 5. Слой 4 — MeshRouter

### 5.1 Дедупликация

Кольцевой буфер `512 × (src_id, packet_id, seen_ms)`, TTL 60 с. При повторе:
- пакет немедленно дропается;
- если это был запланированный broadcast-ретранслит, он **отменяется** (`cancel_broadcast`).

### 5.2 RSSI-подавление broadcast-шторма

Задержка ретрансляции обратно пропорциональна RSSI:

```
rssi >= -30 dBm   → 150 мс
rssi <= -115 dBm  → 10 мс
иначе             → 10 + (rssi + 115) * 140 / 85 мс
+ случайный джиттер 0..20 мс, clamp 10..180 мс
```

Слабый сигнал = узел на границе = ретранслирует первым. Сильный = рядом с отправителем = ждёт и отменяет передачу, услышав чужой ретранслит.

### 5.3 AODV (on-demand)

- Таблица маршрутов: 256 записей `dst_id → {next_hop_id, iface, hops, rssi, last_seen, expiry}`.
- Нет маршрута → пакет в `PendingQueue` (12) + broadcast `RREQ` (payload `relay_id`).
- Цель отвечает `RREP` по обратному маршруту; каждый узел на пути учит маршрут к цели через `relay_id`.
- При истечении маршрута — новый `RREQ`.
- Метрика: `hops`, затем RSSI; при равных hops предпочтителен более сильный сигнал.

### 5.4 Градиент шлюзов (восходящий канал)

- `NODE_GATEWAY` каждые 60–120 с рассылает `GW_BEACON` (`hop_count = 0`).
- Узлы обновляют `best_gw = {gateway_id, next_hop, iface, hops, rssi}` и ретранслируют маяк с `hop_count+1`, пока `< gw_max_hops`.
- Маяки обновляют градиент **до** дедупликации (нужно сравнивать несколько путей), но ретранслируются только если пакет не дубликат.
- `TO_INTERNET` и `dst = ANY_GATEWAY` сразу уходят на `best_gw_next_hop`.

### 5.5 Присутствие (нисходящий канал)

- `NODE_CLIENT` раз в 3–5 минут (или при смене шлюза) отправляет `NODE_PRESENCE` на `ANY_GATEWAY`.
- Шлюз вызывает `sink.presence()` → `POST /v1/kmesh/v1/presence`.
- Сервер хранит `node_id → gateway_id` с TTL 10 минут (настраивается).
- Входящее из интернета сообщение маршрутизируется на конкретный шлюз; при отсутствии ACK — фоллбэк на резервный шлюз (ответственность серверной очереди).

### 5.6 L3 ACK и повторы

- При `NEED_ACK` отправитель держит слот в `ACK_TABLE` (16).
- Таймаут 1.8 с, до 3 повторов с линейным backoff.
- После 2-й неудачи маршрут сбрасывается и запускается новый `RREQ`.
- После исчерпания — статус `FAILED` в приложение.
- ACK от шлюза даёт `ACKED_BY_GATEWAY`, ACK от получателя — `DELIVERED_TO_PEER`.

### 5.7 Политика ролей

| роль | транзит | комментарий |
| --- | --- | --- |
| `NODE_CLIENT` | только `GW_BEACON`/`RREQ`, а также uplink при `gw.hops <= 2` | батарея важнее |
| `NODE_ROUTER` | всё | стационарный ретранслятор, cross-band bridge |
| `NODE_GATEWAY` | всё + архив | интернет-выход |

### 5.8 Перехват шлюзом (`NEED_CLOUD_ARCHIVE`)

Шлюз проверяет **каждый услышанный** `DATA/SYNC_ARCHIVE` с ненулевым `msg_uuid` и флагом `NEED_CLOUD_ARCHIVE`, даже если пакет адресован другому узлу. Копия уходит в `kmesh_v1_archive` со статусом `pending`.

### 5.9 Частотное кластерирование от шлюзов

Каждая сота — это пара «Wi-Fi канал + LoRa-подканал». План задан в
`klinto_channel_plan.*`, применяется одновременно к ESP-NOW и LoRa.

| Wi-Fi | LoRa 868, МГц | BW | SyncWord |
| --- | --- | --- | --- |
| 1 | 868.100 | 125 | 0x11 |
| 2 | 868.300 | 125 | 0x12 |
| … | … | … | … |
| 13 | 870.500 | 125 | 0x1D |

Для 433 МГц используется сетка 433.0625 + (N−1)×0.125 МГц: 13 полос по
125 кГц стыкуются без перекрытия. Диапазон выбирается по `lora.freq_mhz`
(`< 500` — 433, иначе 868). Регион обязан проверить допустимость частот.

**Роли:**

- `NODE_GATEWAY` после подключения к Wi-Fi читает фактический канал AP
  (`WiFi.channel()` / `esp_wifi_get_channel`), применяет план и сразу
  рассылает `GW_BEACON` на этой паре.
- `NODE_ROUTER` сканирует 1..13, выбирает шлюз по `RSSI` и минимальному
  `hop_count`, фиксируется на его паре и ретранслирует маяк.
- `NODE_CLIENT` ведёт себя как телефон: следит за RSSI текущего `best_gw`;
  при `RSSI < -85 dBm` или двух потерянных маяках запускает фоновый скан,
  переключается на лучшую соту и сразу отправляет `NODE_PRESENCE`.
- Если после двух полных циклов шлюзов нет, включается
  `FALLBACK_OFFLINE_CHANNEL = 1` (Mesh ↔ Mesh). Ретрансляторы раз в
  2–3 минуты делают быстрый скан, чтобы вернуться в соту при появлении шлюза.

При смене канала `KlintoRouter::on_channel_changed()` очищает маршруты,
соседей, `best_gw`, pending/ACK и кольцо дедупликации — старые записи
относятся к другой соте и не должны влиять на новую.

---

## 6. Слой 5 — двухэтапное шифрование и история

### 6.1 Этап 1 — радио (TEMP_MESH_KEY)

- `msg_uuid` = Snowflake: 42 бита времени, 12 бит node_id, 10 бит sequence.
- RPC сжимается Unishox2, затем шифруется ChaCha20 + HMAC-SHA256 (encrypt-then-MAC).
- Nonce: `packet_id LE32 | src_id LE32 | low32(msg_uuid) LE32`.
- AAD (24 байта): домен, `packet_id`, `msg_uuid`, `dst_id`, `src_id`, `type`, `flags`, `payload_len`.
- Формат: `[alg=1][tag_len=4][ciphertext][tag4]`.
- 4-байтный MIC — осознанный компромисс для LoRa; история защищается постоянной подписью.

### 6.2 Этап 2 — shadow copy

Шлюз отправляет `mesh_archive` (base64 исходного MeshPacket + метаданные). Сервер хранит `kmesh_v1_archive(msg_uuid, gateway_id, src, dst, packet_b64, status='pending')`. Дубликаты по `msg_uuid` не создаются.

### 6.3 Этап 3 — постоянная синхронизация

Клиент при появлении интернета:

1. Берёт локальную запись `LOCAL_MESH_ONLY`.
2. Шифрует текст постоянным ключом чата (`PERM_USER_KEY`, E2EE; в текущем клиенте — XChaCha20-Poly1305 из `crypto/core`).
3. Считает canonical-строку:
   ```
   KLINTO-KMESH1-PERM|<msg_uuid hex>|<sender_node_id>|<receiver_node_id>|<timestamp_ms>|<cipher hex>
   ```
4. Подписывает `SHA-256(canonical)` ключом `identityPriv` (ECDSA P-256; предусмотрен `sig_alg=ed25519`).
5. `POST /v1/kmesh/v1/sync`.

Сервер:

- проверяет членство в чате и подпись по `devices.identity_pub`;
- дедуплицирует по `msg_uuid` (UNIQUE `(chat_id, msg_uuid)` + `kmesh_v1_messages`);
- если есть shadow copy — помечает `permanent`, ciphertext замещается постоянным;
- пишет `messages` + `kmesh_v1_messages`;
- рассылает обоим участникам WS `mesh_synced` → клиент ставит `SYNCED_PERMANENT` и убирает запись из outbox.

**Флаги переподписи:**
- `CLIENT_RESIGN` (по умолчанию): подпись клиента, сервер только проверяет.
- `SERVER_RESIGN`: сервер проверяет клиента, затем ставит countersignature `server-hmac-sha256` (для инсталляций с серверным хранением ключей). Протокол не выдаёт её за подпись пользователя.

### 6.4 Статусы

| код | имя | когда |
| --- | --- | --- |
| 0 | `QUEUED` | принято мостом |
| 1 | `SENT_TO_MESH` | ушло в эфир |
| 2 | `DELIVERED_TO_PEER` | ACK получателя |
| 3 | `ACKED_BY_GATEWAY` | ACK шлюза |
| 4 | `SYNCED_PERMANENT` | сервер подтвердил историю |
| 5 | `FAILED` | retries исчерпаны |
| 6 | `RECEIVED` | локальная доставка |
| 7 | `READ` | прочитано |

---

## 7. BLE / Serial протокол (ESP32 ↔ приложение)

### 7.1 Кадр

```
'S' 'G' | ver=3 | type | flags | seq u16 | len u16 | payload | crc16
```

CRC16-CCITT по `ver..payload` (без magic). Заголовок — **9 байт** (важно: не 8).

### 7.2 Типы

| type | имя | payload |
| --- | --- | --- |
| 1 | `HELLO` | пусто; ответ — INFO |
| 2 | `INFO` | JSON `{v:3,kind:"info",nodeId,role,mtu,queue}` |
| 3 | `RPC_UP` | `[dst_id u32][flags u8][msg_uuid u64][RPC bytes]` |
| 4 | `RPC_DOWN` | сериализованный `MeshPacket` (уже расшифрован/декомпрессирован узлом) |
| 5 | `STATUS` | `[msg_uuid u64][packet_id u32][status u8]` |
| 6 | `CONFIG` | JSON `{wifiSsid,wifiPassword}` |
| 7 | `PING` / 8 `PONG` | `[millis u32]` |
| 9 | `LOG` | UTF-8 строка |
| 10 | `SYNC_ACK` | `[msg_uuid u64][server_seq u32][status u8]` |

`RPC_UP.flags` — это `TO_INTERNET`, `GROUP` и т.п.; узел сам добавляет `NEED_ACK`, `TEMP_MESH_KEY`, `NEED_CLOUD_ARCHIVE`.

### 7.3 Фрагментация

Если кадр больше `ATT_MTU - 3`:

```
flags |= 0x01
payload = [msg_id u16][offset u16][total u16][chunk]
```

Сборка — по `offset` (не по порядку), таймаут 15 с, максимум 2048 байт. Минимальный ATT MTU для KMesh_v1 — 64; рекомендуется 247.

### 7.4 Буфер во Flash

- Исходящие в приложение пакеты при отключённом BLE → `/klinto_down.q` (100 слотов).
- Входящие от приложения, которые не удалось отправить в эфир, остаются в исходящей очереди приложения.
- Статусы, не доставленные приложению, копятся в RAM-кольце на 16 и выгружаются при подключении.

---

## 8. Серверный контракт

### 8.1 MQTT (шлюз ↔ брокер)

| топик | направление | формат |
| --- | --- | --- |
| `klinto/kmesh/v1/gw/<gateway_id>/up` | gateway → server | JSON `mesh_archive` / `presence` |
| `klinto/kmesh/v1/gw/<gateway_id>/down` | server → gateway | **бинарный MeshPacket** |
| `klinto/kmesh/v1/gw/<gateway_id>/presence` | gateway → server | JSON presence |

> Шлюз читает `hub_url` из NVS. Для MQTT нужен `mqtt://host:1883` или `mqtts://host:8883`; `http(s)://` будет проигнорирован (шлюз останется офлайн и продолжит копить пакеты во Flash). HTTP-транспорт — отдельная точка расширения `IGatewayTransport`.

`mesh_archive`:

```json
{
  "v": 3,
  "kind": "mesh_archive",
  "gateway_id": 100,
  "msg_uuid": "0102030405060708",
  "packet_id": 123456,
  "src_id": 7,
  "dst_id": 8,
  "type": 1,
  "flags": 41,
  "ttl": 7,
  "hop_count": 2,
  "rssi": -87,
  "iface": 1,
  "ts": 1763000000000,
  "need_cloud_archive": true,
  "packet_b64": "p...=="
}
```

`presence`:

```json
{
  "v": 3, "kind": "presence", "gateway_id": 100,
  "node_id": 7, "rssi": -70, "hops": 1, "iface": 0,
  "battery": 87, "role": 0, "ts": 1763000000000
}
```

Downlink — **не JSON**: сервер публикует ровно те байты `MeshPacket`, которые уйдут в эфир. Шлюз ставит `FROM_INTERNET`, сбрасывает `hop_count`, вызывает `router.forward_downlink()`.

### 8.2 HTTP API

| метод | путь | auth | назначение |
| --- | --- | --- | --- |
| POST | `/v1/kmesh/v1/archive` | module token | shadow copy от шлюза |
| POST | `/v1/kmesh/v1/presence` | module token | `node_id → gateway_id` |
| POST | `/v1/kmesh/v1/sync` | user session | постоянная запись (идемпотентно) |
| GET | `/v1/kmesh/v1/messages?chatId=&since=&limit=` | user | ciphertext-история |
| GET | `/v1/kmesh/v1/presence/:nodeId` | user | где сейчас узел + `fallbackGatewayIds` |

`GET /v1/kmesh/v1/presence/:nodeId` возвращает `{online, gatewayId, fallbackGatewayIds, rssi, hops}`. Downlink-воркер сервера публикует пакет в `klinto/kmesh/v1/gw/<gatewayId>/down`; если ACK не пришёл за таймаут — повторяет через `fallbackGatewayIds`.
| POST | `/v1/kmesh/v1/ack` | user | receipt по `messageUuids` |

`POST /v1/kmesh/v1/sync`:

```json
{
  "msg_uuid": "0102030405060708",
  "chat_id": "uuid",
  "sender_node_id": 7,
  "receiver_node_id": 8,
  "timestamp": 1763000000000,
  "ciphertext_b64": "...",
  "nonce": "...",
  "kind": "text",
  "header": { "chatRef": 42, "transport": "kmesh-v1" },
  "signature": "...",
  "sig_alg": "ecdsa-p256",
  "resign_mode": "client",
  "chat_ref": 42
}
```

Ответ:

```json
{
  "ok": true, "deduped": false,
  "msg_uuid": "0102030405060708",
  "message_id": "uuid", "server_seq": 12345,
  "permanent_signature": "...", "sig_alg": "ecdsa-p256",
  "resign_mode": "client"
}
```

### 8.3 Таблицы

| таблица | ключ | роль |
| --- | --- | --- |
| `kmesh_v1_presence` | `node_id` | last gateway, TTL |
| `kmesh_v1_archive` | `msg_uuid` | shadow copy, `pending/permanent/expired` |
| `kmesh_v1_messages` | `msg_uuid` | постоянная запись + подпись |
| `kmesh_v1_sync_events` | `id` | аудит попыток |
| `kmesh_v1_gateways` | `gateway_id` | liveness/статистика |
| `messages.msg_uuid` | UNIQUE `(chat_id,msg_uuid)` | защита от дублей в истории |

### 8.4 Дедупликация и MSG_SYNCED

1. `SELECT ... FROM kmesh_v1_messages WHERE msg_uuid = $1` → если есть, вернуть `deduped: true`.
2. `INSERT INTO messages ... ON CONFLICT DO NOTHING` → гонка двух устройств безопасна.
3. `INSERT INTO kmesh_v1_messages ... ON CONFLICT DO NOTHING`.
4. `UPDATE kmesh_v1_archive SET status='permanent'`.
5. WS `mesh_synced {chatId, msgUuid, serverSeq, permanentSignature}` обоим участникам.
6. Клиент по этому событию: `SYNCED_PERMANENT`, удаляет outbox, **не добавляет** вторую строку в UI.

---

## 9. Конфигурация NVS / JSON

Прошивка при старте берёт compile-time defaults из `config.h`, затем накладывает JSON из NVS (`namespace klinto3`, key `cfg`):

```json
{
  "role": "router",
  "node_id": 268435470,
  "wifi_channel": 6,
  "espnow": true,
  "ttl": 7,
  "gw_max_hops": 8,
  "presence_interval_ms": 180000,
  "gw_beacon_interval_ms": 90000,
  "ack_timeout_ms": 1800,
  "ack_retries": 3,
  "lora_low_watermark": 70,
  "temp_mesh_key": "32-byte-hex",
  "hub_url": "mqtts://mqtt.example.org:8883",
  "module_token": "...",
  "lora": {
    "present": true,
    "chip": "sx1262",
    "sck": 4, "miso": 5, "mosi": 6, "cs": 7,
    "rst": 3, "dio0": 2, "dio1": 2, "busy": 10,
    "freq": 869.525, "sf": 9, "bw": 125.0, "cr": 5, "power": 17
  }
}
```

Пины можно менять без перекомпиляции. `role`: `client|router|gateway` (алиасы `wearable|repeater`).

> Для KMesh_v1 `temp_mesh_key` обязателен и должен быть **одинаковым для всех узлов одной сети**. Builder возвращает `temp_mesh_key_required`, если ключ не задан: генерировать его на каждую сборку нельзя — устройства окажутся в разных «сетях».

---

## 10. FreeRTOS и память

| задача | ядро | стек | работа |
| --- | --- | --- | --- |
| `kl_mesh` | 0 | 8 KB | `interface.poll()`, разбор кадров, `router.on_packet/tick` |
| `kl_client` | 1 | 8 KB | `bridge.loop()`, BLE/Serial, flash-outbox |
| `kl_gateway` | 0 | 8 KB | MQTT reconnect/publish/downlink |
| `kl_lora` | 0 | 6 KB | CAD/CSMA, TX-очередь, RX |

- Коллбэки прерываний только копируют байты в `KlintoRxRing` (8 × 256).
- Нет `String`, `std::string`, `new`/`malloc` в сетевом пути.
- Все очереди фиксированные; переполнение → сброс по приоритету, а не исчерпание памяти.
- Router занимает ~23 КБ BSS; flash-очереди — 100 × 260 байт каждая.
- Критические секции — короткий spinlock; никаких блокирующих `delay()` в задачах (только `vTaskDelay`).

---

## 11. Сборка и проверка

```bash
# Портируемое ядро + тесты (Linux/macOS)
cd firmware/klinto_core && make test

# Windows без Visual Studio
powershell -File firmware/klinto_core/run_tests.ps1

# Клиент: типы + кросс-языковые векторы C↔TS
cd client && npm run typecheck && npm run test:kmesh-v1

# Hub
cd services/hub && npm run typecheck
```

Сборка прошивки: в конфиге билдера выставить `kmesh.v1 = true`. Builder скопирует `firmware/klinto_core/{src,include}` в скетч и соберёт `klinto_module_kmesh_v1.ino` через arduino-cli.

### 11.1 Результаты проверки

| Проверка | Результат |
| --- | --- |
| Host C++ (`make test`) | 518 проверок, 0 ошибок |
| ESP32 devkit (Arduino core 3.3.12, RadioLib 7.8.1) | SUCCESS; RAM 33.5%, flash 2.18 MB |
| ESP32-C3 (NimBLE) | SUCCESS |
| Client `tsc --noEmit` | OK |
| Клиентские C↔TS векторы (`npm run test:kmesh-v1`) | seal + permanent digest совпадают байт-в-байт |
| Hub `tsc --noEmit` | OK |

> Для KMesh_v1 на 4 MB модуле используется `PartitionScheme=huge_app` (3 MB app, без OTA).
> OTA для KMesh_v1 требует 8 MB flash и схемы `max_app_8MB`; v2 продолжает собираться с `min_spiffs`.

---

## 12. Ограничения и следующие шаги

1. **Wi-Fi + ESP-NOW на одном радио**: канал mesh должен совпадать с каналом AP шлюза. Для шлюзов с интернетом рекомендуется Ethernet/LTE либо отдельный Wi-Fi AP на mesh-канале.
2. **LoRa duty cycle**: 4-байтный MIC и приоритетная очередь снижают airtime, но региональные ограничения (1%/10%) всё равно нужно соблюдать через `max_airtime_ms_per_min`.
3. **Unishox2 в приложении** не дублируется: сжатие делает прошивка. Это сохраняет тонкий клиент и одну версию алгоритма.
4. **Ed25519 на устройстве**: хук `kl_crypto_set_signers` готов; для ESP32 нужен mbedTLS/PSA-адаптер под конкретную версию IDF. Клиент/сервер уже поддерживают `sig_alg=ed25519`.
5. **Резервные шлюзы**: серверная очередь downlink должна повторять публикацию на второй `gateway_id` при отсутствии ACK (точка расширения в `kmeshV1.ts`).
