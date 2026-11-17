# KMesh: стабильность модулей, итоги отладки 18.11.2026

Стенд: ESP32 Lite (носимый, BLE + ESP-NOW) и ESP32-C3 Super Mini (шлюз, Wi-Fi DomRuBAZA),
оба подключены к ПК; логи по USB (C3 — CDC on boot).

## Найденные причины и исправления

| # | Симптом | Причина | Исправление |
|---|---------|---------|-------------|
| 1 | Носимый ESP32 в бесконечном reboot (`StoreProhibited`, `btu_hcif_command_complete_evt`) | Bluedroid + Wi-Fi/ESP-NOW съедали кучу: до BLE 96 КБ, после — 4 КБ, выделение в HCI возвращало NULL | BLE переведён на NimBLE-Arduino (все платы): после BLE свободно ~66 КБ, образ 1.97 → 1.47 МБ |
| 2 | Носимый не находит шлюз (`bcn=0`, `gateway=false`) | Обход 13 каналов по 120 мс, маяк раз в 5 с → шанс поймать ~2% | `GW_PROBE` на каждом канале, шлюз отвечает маяком сразу; фиксация на первом маяке |
| 3 | Маршрут до шлюза пропадает каждые 15 с | `gw_` обновлялся только по «лучшему» маяку | маяк того же шлюза через тот же узел — keepalive |
| 4 | Шлюз C3 не подключается к Wi-Fi (`reason=2 AUTH_EXPIRE`) | Super Mini на полной мощности не проходит auth | `WiFi.setTxPower(8.5 dBm)` для C3 |
| 5 | Риск deadlock роутера | `on_beacon` вызывал `apply()` под блокировкой роутера | применение канала отложено в `tick()` |
| 6 | Классический ESP32 + BLE не влезал в слот 1.75 МБ (103%) | Bluedroid | NimBLE + раздел 1.875 МБ для ESP32 |
| 7 | iOS: зависание записи, «зомби»-соединение | см. release/notes-1.10.39.md | сторож связи, переподключение |

## Проверка на железе (2 минуты)
- носимый: `cell locked ch=12 gw=… rssi=-39`, 0 потерь маяка, `gw_age` ≈ 3.6 с;
- шлюз: `presence src=<носимый> rssi=-30`, `[TRACE 3/4] GW->HUB uplink ok status=200` (7/7, 0 ошибок).

## Диагностика
Строка `[mesh] t=… ch=… cell=… rx=… tx=… bcn_rx=… bcn_tx=… gw_age=… heap=…` раз в 5 с.
`cell`: 0 — привязан к шлюзу, 1 — сканирует, 2 — шлюзов нет.
Просмотр: `python -m serial` / любой терминал 115200; C3/C5/C6/S3 — USB CDC.

## Сборщик
- NimBLE-Arduino 2.5.2 установлен в `/data/arduino-user/libraries` контейнера `klinto-firmware`
  (`arduino-cli lib install NimBLE-Arduino@2.5.2` с `ARDUINO_DIRECTORIES_USER=/data/arduino-user`).
- Каталог `sketch` в build-path надо чистить перед сборкой: иначе arduino-cli не пересобирает
  объекты после правки заголовков (несовпадение layout → порча памяти).
- Платы: esp32c3, esp32, esp32s3, esp32c6, esp32c5 (arch 6).
