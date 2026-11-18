# Модульная mesh-архитектура (ESP-NOW + LoRa)

Статус: **описание фактической реализации** прошивки
`services/firmware-builder/templates/klinto_module_v2.ino` и `mesh_v2/*`.
Документ заменяет редакцию 2.0 в части транспорта и каналов: там
предполагались ESP-WIFI-MESH и фиксированный канал 11, в коде этого нет.

Связанные документы:

- `docs/PROTOCOL.md` — кадры, типы пакетов, JSON-payload.
- `docs/MODULE-DEBUG.md` — логи, порты, диагностика.
- `docs/KMT.md` — Klinto Mesh Transport (API поверх mesh).
- `docs/ROUTING_METRICS.md`, `docs/SPECTRAMESH.md` — метрики и идейная база.

Термины: **модуль** — ESP32/ESP32-C3/S3 с прошивкой; **узел** — модуль в
mesh; **кластер** — группа узлов на одном канале вокруг якоря (gateway или
repeater); **шлюз (gateway)** — узел с uplink в Hub.

---

## 0. Транспорты и роли

| Сегмент | Транспорт | Где в коде |
|---|---|---|
| Внутри кластера | ESP-NOW (по умолчанию normal PHY, опционально LR) | `espNowInit`, `espNowSendRaw`, `espNowPoll` |
| Между кластерами | LoRa SX1262/SX127x, 869.525 МГц | `loraSendRaw`, `transmitLoraBridge` |
| Шлюз → Hub | Wi-Fi STA к роутеру + HTTP | `ensureWifiLink`, `hubLoop` |
| Телефон → модуль | BLE GATT / USB CDC | `setupBle`, `usbPoll` |

Целевой режим — **ESP-NOW LR как основной внутрикластерный транспорт**
(дальность, 250 кбит/с). В текущей сборке по умолчанию включён обычный
ESP-NOW (`KL_ESPNOW_LR=0`): IDF не позволяет держать LR на AP, пока шлюз
одновременно ассоциирован с роутером по STA. LR доступен на выделенном
mesh-канале (вариант B, раздел 6) или на узлах без uplink.

Роли (`KL_ROLE`):

| Роль | SoftAP | STA | ESP-NOW iface | Назначение |
|---|---|---|---|---|
| `gateway` | да (`SG-MESH`) | к роутеру | `WIFI_IF_AP` | якорь кластера, uplink/downlink |
| `repeater` | нет | нет | `WIFI_IF_STA` | только пересылка |
| `wearable` | нет | нет | `WIFI_IF_STA` | BLE/USB мост для телефона |

Ключевое ограничение — **одно радио на модуль**. Wi-Fi (ESP-NOW) и SoftAP
делят один PHY и один канал; LoRa — отдельный чип, но общий корпус и питание.
Поэтому:

- нельзя держать ESP-NOW на одном канале, а SoftAP на другом;
- смена канала Wi-Fi требует переинициализации ESP-NOW и пересоздания пиров;
- LoRa не участвует в ESP-NOW-кластере: это отдельный backbone-сегмент.

---

## 1. Модель каналов

### 1.1 Кто задаёт канал

- **Шлюз наследует канал роутера.** В `AP+STA` канал SoftAP следует за STA:
  после `WiFi.begin(router)` и ассоциации `gApChannel = WiFi.channel()`; при
  смене канала роутером шлюз логирует `[wifi] channel X -> Y (AP follows STA)`
  и рассылает ADVERT.
- **Модули работают STA-only**, без SoftAP: `WiFi.mode(WIFI_STA)`. Иначе AP
  фиксирует home-канал, и ESP-NOW не может уйти на канал шлюза — отправка
  падает с `peer channel != home channel`.
- **Кластер не выбирает канал сам.** Нет «cluster channel switch»: все узлы
  кластера сидят на канале шлюза, шлюз — на канале роутера.

### 1.2 channelDiscover

Узел без ассоциации перебирает каналы 1..13 и ищет шлюз:

```text
channelDiscover(timeoutPerChannelMs = 140):
  for ch in 1..13:
    esp_wifi_set_channel(ch)
    espNowReinitOnChannel(ch)          // deinit + init + пересоздание пиров
    send MT_DISCOVER (broadcast, 2 раза, только ESP-NOW)
    ждать до 140 мс:
      espNowPoll()                     // приём
      если пришёл MT_DISCOVER_ACK или ADVERT с "ch" -> успех

  после успеха: gDiscoveredChannel=ch, gApChannel=ch, gEspNowChannel=ch
  лог: [channel] discovered ch=N
```

- `MT_DISCOVER` payload: `{"hw":"esp32-…","role":"…","nonce":N}`.
- Отвечает **только шлюз**: `MT_DISCOVER_ACK {"ch":N,"cluster_id":N}`.
- ADVERT тоже несёт `"ch"`, поэтому обнаружение работает и без ACK.
- Типичное время до успеха ≈ 1.8 с (13 × 140 мс); критерий приёмки — **< 2 с**.
- Вызывается из `setup()` (блокирующе) и из `channelDiscoverTick()`: не чаще
  одного прохода в 60 с, только если `gEspNowRxCount == 0`.
- Fallback, если discovery не нашёл шлюз: скан SoftAP `SG-MESH` и
  `esp_wifi_set_channel` по каналу найденного AP (без ассоциации).

### 1.3 Переинициализация после смены канала

ESP-IDF «home_channel bug»: после смены канала Wi-Fi `peer.channel = 0`
(«текущий») приводит к silent drop — `esp_now_send` возвращает OK, пакеты не
уходят. Поэтому:

```text
espNowReinitOnChannel(ch):
  esp_wifi_set_channel(ch)
  esp_now_deinit(); очистить пиры
  gEspNowChannel = ch
  espNowInit(ch)            // esp_now_init + broadcast peer
```

Правила:

- `peer.channel` **всегда равен** `gEspNowChannel` (home channel), не 0.
- Пиры пересоздаются при каждом подключении STA: `gEspNowChannel = 0` форсирует
  reinit, затем `espNowReinitOnChannel(WiFi.channel())`.
- `espNowInit` не перетирает явный канал «протухшим» `WiFi.channel()`.

### 1.4 ESP-NOW LR

`KL_ESPNOW_LR` (по умолчанию `0`):

- LR требует отдельного STA-интерфейса/канала. На шлюзе, который одновременно
  держит STA к роутеру, IDF **не даёт** включить LR на AP, а LR на STA рвёт
  ассоциацию с роутером.
- Поэтому по умолчанию используется **обычный ESP-NOW**: лог
  `[espnow] PHY normal (LR needs dedicated STA/channel)`.
- При `KL_ESPNOW_LR=1` PHY переключается до `esp_wifi_start()`
  (`esp_wifi_config_80211_tx_rate(..., WIFI_PHY_RATE_LORA_250K)`), пиры
  получают rate config LR 250K. Это режим выделенного mesh-канала, не
  совместимый с uplink через тот же Wi-Fi.
- Кадр ESP-NOW v1 ≤ 240 байт, крупное режется `MT_FRAG` (150 байт на фрагмент).

---

## 2. Кластеры

`cluster_id` = CRC32 по отсортированным строкам якорей, разделитель `|`
(`klinto_compute_cluster_id`). Якоря — только `is_anchor=1` (gateway и
стационарный repeater), видимые последние 12 с. Нет якорей — `cluster_id = 0`.

### 2.1 Моногамный кластер

Один шлюз (или один якорь) и один канал. Все узлы видят один `cluster_id`.
Штатный режим для дома/офиса: один gateway, N wearable/repeater.

### 2.2 Полигамный кластер

2–3 шлюза на **одном канале** (один роутер / одна mesh-сеть). Узлы видят
несколько якорей, `cluster_id` считается по их общему набору. Даёт:

- резервирование uplink: при падении одного шлюза трафик уходит через другой;
- балансировку по RSSI/очереди при выборе next hop;
- устойчивость `cluster_id`: набор якорей меняется редко.

Важно: полигамия возможна только на одном канале. Разные каналы — это разные
кластеры, связь между ними только через LoRa-мост (раздел 5).

### 2.3 Border node

Пограничный узел видит два кластера и пересылает трафик между ними.

Выбор (`klinto_elect_border_nodes`):

```text
score = min(rssi_A, rssi_B) - max(queue_A, queue_B) * 4
```

| Условие | Значение |
|---|---|
| Минимальный RSSI | `>= -95 dBm` (`KINTO_BORDER_MIN_RSSI`) |
| Максимальная очередь | `<= 8` (`KINTO_BORDER_MAX_QUEUE`) |
| Стабильность | `streaks >= 3` beacon-интервала |
| Свежесть | `last_seen <= 12 s` |
| Количество | до 2 (`KINTO_BORDER_MAX`) |

Дополнительно в `clusterTick()` узел становится border, если:

- он не шлюз;
- `gBorderStreak >= 3` (три интервала подряд видит чужой кластер с RSSI
  `>= -95` и очередью `<= 8`);
- среди кандидатов меньше двух узлов с меньшим mesh-адресом — выбор
  детерминированный, без флапов.

Лог: `[border] elected|demoted self=… cid=… peers=… elected=…`.

---

## 3. Плавный handover

Триггер только у wearable: текущий кластер `< -85 dBm`, соседний
`> -75 dBm` три beacon-интервала подряд.

```text
IDLE --trigger--> REQUESTED --accept--> ACCEPTED --3 stable beacons--> COMPLETE
                        |                   |
                        +--reject/timeout---+--> ABORT (возврат в исходный)
```

| Параметр | Значение |
|---|---|
| Beacon-интервал | 3 с |
| Стабильных beacon для COMPLETE | 3 |
| Таймаут перехода | 10 с → ABORT |
| Повтор request | каждые 3 с, максимум 3 попытки |
| Cooldown после complete | 10 с |
| Cooldown после local abort | 10 с (по сообщению `abort` — 5 с) |
| Cooldown после reject | 15 с |

Механика:

1. `request` уходит выбранному peer (сначала узел целевого кластера, затем
   gateway, затем border, затем любой с лучшим RSSI).
2. Принять переход может только реальный border: `gBorderNode &&
   cluster != gSelfClusterId`. Иначе шлюз отвечает `reject`.
3. В `ACCEPTED` повторные `request` не шлются: узел ждёт, пока
   пересчитанный `cluster_id` три раза совпадёт с целевым, затем шлёт
   `complete`.
4. Пока переход не завершён (`handoverTransitional()`), очередь шлётся
   **дважды** — cluster-agnostic. Получатель отбрасывает дубль по
   `(src, packetId)`.
5. По таймауту 10 с шлётся `abort`, `cluster_id` возвращается к исходному.

Логи: `[handover] trigger|request|accepted|stable 3/3|complete|retry|abort`.

---

## 4. Маршрутизация (Reticulum-style)

### 4.1 Обучение

- **ADVERT/PRESENCE** — периодические объявления. ADVERT: 8 с первые 2
  минуты, далее 30 с. PRESENCE: 15 с (пропускается при очереди > 120).
- **Reverse learning**: на любом принятом пакете учится обратный путь
  `routeLearn(src, src, iface, hop+1, rssiToEwma(rssi))`. Отдельный route
  request для ответа не нужен.
- **MT_ROUTE_REQ / MT_ROUTE_REP**: запрос пути и ответ с метрикой.
  `MT_ROUTE_REQ` payload — `[target u32]`; `MT_ROUTE_REP` —
  `[target u32][nextHop u32][metric u16][hops u8]`.

### 4.2 Таблица маршрутов

```text
dst | nextHop | iface (ESPNOW|LORA) | hops | metric | expiresMs
```

| Параметр | ESP-NOW | LoRa |
|---|---|---|
| Срок жизни | 300 с | 900 с |
| TTL по умолчанию | 16 | 8 |
| Порог предпочтения | 120 | 400 |

- В скетче кэш — 8 записей (`RouteEntry gRoutes[8]`), в `mesh_v2` —
  до 64 (`KINTO_ROUTE_MAX`).
- Просроченная запись удаляется при чтении.
- Кластерный маршрут LoRa (`cluster_id -> nextHop`) живёт 10 минут.

### 4.3 Метрика

```text
metric = ewma_ms + hops * 35 + queue_depth * 8
```

- `ewma_ms` — оценка задержки по RSSI (`rssiToEwma`: 40/80/140/240/380 мс).
- `metric` пересчитывается по каждому принятому пакету от соседа, ADVERT и
  `MT_ROUTE_REP`, и учитывает очередь соседа.
- Маршрут хуже текущего более чем на 40 не затирает его, пока текущей записи
  меньше 30 с; более старую запись можно заменить любым свежим маршрутом.

### 4.4 Выбор интерфейса

```text
select_route(dst, traffic):
  media/ota                -> только ESP-NOW (LoRa запрещён)
  espnow metric < 120      -> ESP-NOW
  lora metric < 400 и lora_queue < 3 -> LoRa
  иначе лучший по metric
  нет записи               -> NONE (unicast уходит в path request)
```

`transmitRouted` при отсутствии маршрута и для text/media/search:

1. ставит пакет в `PendingRoute` (один слот);
2. шлёт `MT_ROUTE_REQ`;
3. повторяет запрос каждые 3 с, максимум 3 раза;
4. по `MT_ROUTE_REP` отправляет отложенный unicast;
5. через 9 с без ответа — flood.

Если выбранный интерфейс не принял пакет, пробуется второй, затем flood.

### 4.5 TTL и дубли

- Каждый хоп уменьшает TTL на 1.
- При переходе Wi-Fi → LoRa: `ttl = floor(ttl/2)`, затем clamp до 8.
- Дубли отбрасываются по `hash(src, packetId)` в кольце 256 записей, TTL
  записи 60 с.

---

## 5. LoRa-мост между кластерами

Назначение — связать кластеры, которые не слышат друг друга по Wi-Fi
(разные каналы/здания), без общего роутера.

| Параметр | Значение |
|---|---|
| Частота / SF / BW / CR | 869.525 МГц / SF9 / 125 кГц / 4:5 |
| Sync word / мощность | `0x12` / +17 dBm |
| Payload | ≤ 180 байт, крупное — `MT_FRAG` (150 Б × до 16) |
| TTL | 8 при маршрутизации, до 12 у broadcast (`KL_LORA_MAX_HOPS`) |
| Duty cycle | wearable 1 % (36 с/час), остальные 10 % (360 с/час) |
| LBT | CAD перед передачей (SX1262); SX127x — только duty-cycle |

### 5.1 Объявления

`MT_LORA_ADVERT` шлётся каждые 180 с (жёсткий rate-limit в
`loraBridgeTick`; целевой диапазон по требованиям — 120–300 с):

```json
{"cluster_id":305419896,"gw":1,"ch":6,"hw":"esp32-aabbccddeeff"}
```

Приёмник обновляет таблицу `cluster_id -> nextHop` (`loraClusterRouteUpsert`),
запись живёт 10 минут.

### 5.2 Правило пересылки

`MT_LORA_DATA` адресуется **cluster_id**, а не узлу:

```text
if dst == gNodeId или broadcast:
    локальная доставка (wearable -> BLE, gateway -> очередь Hub)
else:
    r = loraClusterRouteFind(dst)
    if r: transmitLoraBridge(MT_LORA_DATA, r->nextHop, payload, ttl=2)
    иначе: drop
```

- Пакет с `dst=cluster_id` **не флудится по Wi-Fi** — иначе уйдёт не в тот
  сегмент (`handleMeshPacket` выходит сразу после обработки).
- Пересылка идёт только по радио, `ttl=2` от исходного объявления.
- Uplink/downlink через мост не меняет формат MeshHeader.

### 5.3 Ограничения

- Мост не шифрует и не сжимает сверх KMT.
- Медиа и OTA по LoRa не передаются (`select_route` их блокирует).
- Один LoRa-кадр несёт ≤ 180 байт; большие ответы идут фрагментами и
  собираются в 2 слотах, поэтому параллельные крупные потоки конкурируют.

---

## 6. Шлюз → Hub: два варианта

### Вариант A — один ESP32, STA к роутеру (текущая реализация)

```text
[wearable] --ESP-NOW--> [gateway AP+STA] --Wi-Fi STA--> [router] --> Hub
                              |
                         SoftAP SG-MESH
```

- Канал кластера = канал роутера (AP следует за STA).
- Плюсы: одна плата, нет межпроцессорного протокола, минимум задержки,
  код уже есть.
- Минусы:
  - канал кластера зависит от роутера (смена канала → reinit ESP-NOW,
    пересоздание пиров, возможные потери на границе);
  - ESP-NOW LR на этом узле недоступен;
  - перезагрузка/зависание шлюза рвёт и mesh, и uplink.

### Вариант B — два радио-узла (проектный вариант, в коде отсутствует)

```text
[cluster] --ESP-NOW fixed ch--> [ESP32 mesh-radio] --UART--> [ESP32/C6 Wi-Fi] --> router --> Hub
```

- Первый MCU держит **фиксированный** ESP-NOW-канал кластера и может
  использовать LR; второй — только STA к роутеру и HTTP.
- Плюсы: канал кластера не зависит от роутера; LR возможен; падение uplink
  не ломает mesh; проще отлаживать по отдельности.
- Минусы: +1 плата и питание; нужен собственный UART-протокол (кадры,
  backpressure, перезапуск); +1 хоп задержки; прошивка делится на две
  сборки; текущий шаблон этого не реализует — только точка расширения.

| Критерий | A | B |
|---|---|---|
| Платы на шлюз | 1 | 2 |
| Канал кластера | канал роутера | фиксированный |
| ESP-NOW LR | нет | да |
| Зависимость mesh от uplink | полная | нет |
| Сложность прошивки | низкая | средняя/высокая |
| Готовность | есть | проект |
