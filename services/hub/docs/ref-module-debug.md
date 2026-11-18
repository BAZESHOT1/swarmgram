# Отладка и прошивка модуля

Отладка модулей: веб-админка → вкладка **«Отладка»**
(`client/app/(app)/admin.tsx`, `client/src/components/admin/ModuleDebugPanel.tsx`)
через локальный bridge на ПК.

```bat
cd tools\module-bridge
npm install
start.cmd
```

Bridge слушает `127.0.0.1:8787` и даёт браузеру:

- список COM-портов и автоопределение модуля (`SG-INFO`: MAC, роль, прошивка);
- мониторы нескольких портов одновременно (SSE, последние 600 строк);
- DTR/RTS reset;
- прошивку `merged.bin` через `esptool` в `0x0`;
- скачивание готовой сборки из Hub по `buildId` + access token.

## 1. Требования

- Python 3.12 + `pip install esptool pyserial`
  (bridge сам находит `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`);
- Node.js + `serialport` (ставится `npm install`);
- USB-кабель с линиями данных (не charge-only);
- драйвер CH340/CP210x для платы.

## 2. Порты и режим

| Порт | Роль | Что прошиваем |
|---|---|---|
| `COM4` | `gateway` | сборка с `KL_ROLE=gateway`, `KL_CONNECTIVITY=wifi` |
| `COM5` | `wearable` | сборка с `KL_ROLE=wearable` |
| `COMx` | `repeater` | по потребности |

- Скорость монитора: **115200** 8N1.
- Роль в прошивке должна совпадать с физической ролью платы, иначе шлюз
  поднимет SoftAP на «носимой» плате и сломает себе канал.
- На wearable после первого USB-кадра текстовые логи замолкают (USB CDC
  занят бинарным протоколом). Смотреть лог нужно до подключения клиента или
  через `SG-INFO` и `[diag]`.

Ожидаемые значения сразу после загрузки:

| Строка | Ожидание |
|---|---|
| `SG-INFO {...}` | `hardwareId`, `publicId`, `role` не пустые |
| `[boot] firmware=… role=… conn=…` | роль и транспорт совпадают со сборкой |
| `[espnow] ready if=… ch=… rate=normal` | gateway `if=1`, узел `if=0`; канал 1..13 |
| `[wifi] softAP SG-MESH ch11 …` | только у gateway; стартовый канал, затем следует за роутером |
| `[wifi] sta connected ip=… gw=… ch=N rssi=…` | только у gateway, `ip` из подсети роутера |
| `[channel] discovered ch=N` | у wearable/repeater, N = канал шлюза |
| `[cluster] cid=…` | одинаковый у всех узлов кластера |
| `[lora] SX1262 ready 869.525 MHz SF9` | если LoRa включён |

## 3. Что смотреть в serial-логе

### 3.1 ESP-NOW

```text
[espnow] ready if=1 ch=6 rate=normal
[espnow] PHY normal (LR needs dedicated STA/channel)
[espnow] peer 12345678 mac=aa:bb:cc:dd:ee:ff
[espnow] channel 0 -> 6, reinit
[espnow] sync ch=6 after sta
[espnow] send err 12345 ch=6 dst=12345678 len=96
[espnow] add peer aa:bb:cc:dd:ee:ff failed 12345
```

| Строка | Трактовка |
|---|---|
| `ready if=1` | шлюз работает через AP-интерфейс |
| `ready if=0` | узел работает через STA-интерфейс |
| `rate=normal` | LR выключен (штатно) |
| `rate=LR250K` | LR включён, uplink через тот же Wi-Fi не заработает |
| `PHY normal (LR needs…)` | `KL_ESPNOW_LR=0`, это норма |
| `peer … mac=…` | MAC соседа выучен, unicast возможен |
| `channel X -> Y, reinit` | смена канала, пиры пересозданы |
| `sync ch=N after sta` | канал подтянут за STA (после ассоциации) |
| `send err` | ошибка `esp_now_send`; чаще всего пир не создан или канал не тот |
| `add peer … failed` | исчерпан лимит пиров или неверный MAC |

### 3.2 Канал

```text
[channel] discovered ch=6
[channel] ack ch=6 from=12345678
[channel] discover from 12345678 -> ack ch=6
[channel] discover failed
[espnow] mesh AP not found (12 nets)
[espnow] channel sync ch=6 rssi=-61 (scan fallback)
```

- `discovered` — узел нашёл шлюз, ESP-NOW переинициализирован на канал.
- `ack` — шлюз ответил на `MT_DISCOVER`.
- `discover failed` — за 13 каналов никто не ответил; проверить шлюз.
- `scan fallback` — канал взят из скана SoftAP, без ассоциации.

### 3.3 LoRa

```text
[lora] SX1262 ready 869.525 MHz SF9
[lora] bridge advert cluster=305419896
[lora] bridge advert cluster=305419896 via=12345678
[lora] bridge fwd cluster=305419897 -> 87654321
[lora] duty budget full (359000/360000 ms)
[lora] frag 2/4 id=1a2b3c4d 150B
[frag] reassembled 620 bytes id=1a2b3c4d via=lora
```

| Строка | Трактовка |
|---|---|
| `bridge advert` (локальный) | узел объявил свой кластер по радио |
| `bridge advert … via=` | принято объявление чужого кластера, обновлена таблица |
| `bridge fwd` | `MT_LORA_DATA` переслан по `cluster_id` |
| `duty budget full` | исчерпан лимит 1 %/10 % в час, пакет ждёт |
| `frag` / `reassembled` | фрагментация работает |
| `[lora] tx err` / `cad err` | ошибка радио или CAD |

### 3.4 Wi-Fi STA

```text
[wifi] softAP SG-MESH ch11 hidden=0 ip=10.42.x.x
[wifi] sta connected ip=192.168.1.50 gw=192.168.1.1 ch=6 rssi=-58
[wifi] sta disconnected (ap clients=2)
[wifi] channel 11 -> 6 (AP follows STA), clients=2
[wifi] WARN subnet collision sta=192.168.1.50 ap=192.168.1.7
[wifi] no router ssid (SET_CONFIG needed)
```

- `sta connected` — uplink до Hub есть; `ch` — канал кластера.
- `channel X -> Y (AP follows STA)` — роутер сменил канал, шлюз перестроился.
- `WARN subnet collision` — подсеть SoftAP совпала с роутером, AP-клиенты
  будут недостижимы.
- `no router ssid` — не задан SSID роутера (`SET_CONFIG` из приложения).

### 3.5 Диагностика и кластеры

```text
[diag] role=gateway conn=wifi wifi=1 lora=1 sta=1 ch=6 apClients=2
       espnow tx=1543 rx=987 fail=4 lora rx=12 tx=8 load=3/1 q=0 fwd=411
[cluster] cid=305419896 border=0 peers=4 nc=1
[border] elected self=a1b2c3d4e5f60718 cid=305419896 peers=5 elected=2
[handover] trigger cur=-88 other=-67 cluster=305419897
[route] rep target=… next=… hops=2 metric=190
[route] tx dst=… next=… via=espnow hops=1 128B
[mesh] rx wifi type=1 src=aa:bb:… dst=bcast len=210 ttl=8
[mesh] fwd wifi->lora type=2 hop=2 ttl=6 (n=411)
```

| Поле `[diag]` | Норма | Проблема |
|---|---|---|
| `wifi=1` | транспорт поднят | `0` — Wi-Fi не инициализирован |
| `lora=1` | радио готово | `0` при `conn=wifi_lora` — смотреть `[lora] … init failed` |
| `sta=1` | шлюз в сети роутера | `0` — нет uplink |
| `ch` | 1..13, совпадает у всех | расхождение = разные кластеры |
| `apClients` | `>0` у шлюза | `0` — узлы не видят SoftAP |
| `espnow tx/rx` | оба растут | `rx=0` — неверный канал/нет пиров |
| `espnow fail` | единицы | рост = ошибки отправки |
| `q` | 0..10 | устойчивый рост = нет маршрута/ACK |
| `fwd` | растёт при трафике | `0` — узел ничего не пересылает |

## 4. Диагностика неисправностей

| Симптом | Вероятная причина | Что проверить |
|---|---|---|
| `espnow rx=0` при `tx>0` | узел на другом канале, чем шлюз | `[channel] discovered`, `ch` в `[diag]` у обоих; ADVERT с `ch` |
| `peer channel != home channel` / silent drop | пир создан с `channel=0` после смены канала | лог `[espnow] channel X -> Y, reinit`; `peer.channel` должен равняться `gEspNowChannel` |
| `espnow send err` после смены канала | пиры не пересозданы | должен быть `reinit`, затем `ready` |
| `discover failed` | шлюз не поднял SoftAP или другой канал | `[wifi] softAP`, `[channel] discover … -> ack` на шлюзе |
| `PHY normal` при `KL_ESPNOW_LR=1` | IDF не даёт LR на AP, пока шлюз держит STA к роутеру | лог `[espnow] LR phy if=1 err=… -> normal`; выключить LR или использовать вариант B (два радио) |
| `relay_expired` в ответе Hub | повтор запроса со старым `ts` | модуль должен ACK до похода в Hub; проверить `[http] relay failed`, синхронизацию времени |
| ответ KMT не собирается | потеряны чанки | `[http] resend …`, `part/total` в клиенте, 35 с таймаут |
| `[lora] bridge fwd` нет | нет записи `cluster_id -> nextHop` | `[lora] bridge advert … via=` давно не появлялся |
| `[lora] duty budget full` | исчерпан 1 %/10 % | уменьшить трафик, проверить `lora_load` |
| `[wifi] WARN subnet collision` | AP и роутер в одной подсети | сменить подсеть роутера или `meshApAddress()` |
| `cid` скачет | в якоря попал чужой/свой `hw` | `is_anchor`, дубли ADVERT, `nginx`-логи Hub |
| handover-шторм | старые прошивки шлют `request` всем | шлюз отвечает `reject`; смотреть `[handover] reject/abort` |
| `q` растёт, `fwd=0` | нет маршрута и нет ACK | `[route] pending` → `path timeout` → flood |
| модуль не виден в списке | драйвер/кабель/порт | диспетчер устройств, `mode` COM-порта |
| нет `SG-INFO` | неверный baud или плата не сбросилась | 115200, DTR/RTS reset |

## 5. Быстрый чек-лист стенда

1. Прошить `COM4` как gateway, `COM5` как wearable.
2. Открыть оба монитора, дождаться `SG-INFO` и `[boot] ready`.
3. На gateway: `sta=1`, `apClients>0`, `espnow rx>0`.
4. На wearable: `[channel] discovered ch=N`, где `N` = `ch` шлюза.
5. `[cluster] cid` одинаковый; `[border]` — только у реальных мостов.
6. `[handover]` не появляется без пересечения границы кластера.
7. В админке Hub: `GET /v1/devices` и `GET /v1/mesh/network` показывают
   модули по MAC, кластерам, RSSI и хендоверам.
