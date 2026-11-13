# Klinto 1.6.0 — гибридный KMesh_v1

Дата: 14 ноября 2026 года. Версия прошивки модулей: **1.2**. Hub: **1.2.0**.

## Главное в 1.6.0

- **Гибридные носимые узлы (`HYBRID_PORTABLE_NODE`).** Каждый `NODE_CLIENT`
  по умолчанию работает как клиент + умный ретранслятор + мобильный шлюз.
  Отключается в настройках приложения.
- **Smart Portable Relay.** Транзит чужих пакетов с роль-штрафом к RSSI-backoff:
  `+60 мс` для ESP-NOW и `+250 мс` для LoRa. Стационарные ретрансляторы и
  шлюзы всегда передают первыми; носимый узел отменяет ретрансляцию, услышав
  тот же `packet_id`.
- **Battery Guard.** При заряде `< 20%` без зарядки транзит и мобильный шлюз
  отключаются; при `> 25%` возвращаются (гистерезис 5%). Зарядка снимает
  ограничение.
- **Мобильный шлюз.** Приложение раз в 15 секунд отправляет
  `INET_STATUS {has_internet, rtt_ms, allow_relay}`; модуль вещает `GW_BEACON`
  с `hop_count = 2`, интервал 25 секунд, TTL маршрута 60 секунд — быстрый
  хэндовер. Uplink/Downlink идут кадрами `PROXY_UP`/`PROXY_DOWN`; телефон
  остаётся «слепым курьером» (Zero-Trust), дневной лимит — 10 МБ.
- **Сервисные RPC через радиосеть.** Поиск пользователей/групп/каналов,
  дельта ленты и история чата работают без интернета на телефоне:
  `RPC_SEARCH_*`, `RPC_FEED_SYNC_*`, `RPC_CHAT_HISTORY_*`. Все они имеют
  `PRIORITY_LOW` и не блокируют личные сообщения и `ACK`.
- **Hub `/v1/kmesh/v1/*`.** Добавлены `search`, `feed`, `history`,
  `channel/gateways`, `mobile/archive`, `mobile/presence`, `node/bind`;
  миграция `037_kmesh_v1_services.sql`.
- **Версии:** клиент 1.6.0 (versionCode 10600), Hub 1.2.0, прошивка 1.2.

## Проверка 1.6.0

| Проверка | Результат |
| --- | --- |
| Host C++ | 564 проверки, 0 ошибок |
| ESP32 DevKit | SUCCESS, flash 2.16 MB |
| ESP32-C3 | SUCCESS, flash 1.70 MB |
| Client `tsc` | OK |
| C↔TS codec | OK |
| Hub `tsc` | OK |
| Expo web production | OK |
| Hub 1.2.0 + миграция 037 | применена, healthy |

---

# История: Klinto 1.5.0 — KMesh_v1

Дата: 14 ноября 2026 года. Версия прошивки модулей: **1.1**.

## Главное

- **Ребрендинг:** SwarmGram / Swarm → **Klinto**, протокол mesh_v3 → **KMesh_v1**.
- **Частотное кластерирование:** 13 независимых радиосот, автоматический выбор
  канала шлюза, хэндовер носимых узлов и аварийный канал 1.
- **Исправлен критический баг web-версии:** экран чата больше не падает с
  `ReferenceError: Cannot access 'Bn' before initialization`.
- **Релизные артефакты:** web-сборка, ядро прошивки, миграции Hub.

## Версии прошивок

Версия прошивки теперь понятная: **1.1**, **1.2**, ... Источник истины —
`firmware/klinto_core/VERSION`. Builder подставляет её в `config.h` как
`KL_FIRMWARE_VERSION` и возвращает в ответе `/build`; Hub и UI показывают
`v1.1`. Увеличение: `node scripts/bump-firmware-version.mjs` (1.1 → 1.2)
или `node scripts/bump-firmware-version.mjs 1.5`.

## Изменения протокола| Было | Стало |
| --- | --- |
| `/v1/mesh/v3/*` | `/v1/kmesh/v1/*` |
| `mesh_v3_*` (БД) | `kmesh_v1_*` (миграция 036) |
| `mesh.v3` | `kmesh.v1` |
| `SwarmNode` / `SwarmGram` | `KlintoNode` / `Klinto` |
| `SG_*` | `KL_*` |
| `firmware/swarm_core` | `firmware/klinto_core` |
| `klinto_module_v3.ino` | `klinto_module_kmesh_v1.ino` |
| MQTT `sg/v3/gw/*` | `klinto/kmesh/v1/gw/*` |

Подпись постоянной истории:

```
KLINTO-KMESH1-PERM|uuid|sender|receiver|timestamp|cipher_hex
```

KDF-метки транспорта: `KLINTO-KMESH1-ENC`, `KLINTO-KMESH1-MAC`.

## Частотное кластерирование

- `klinto_channel_plan.*` — единая таблица Wi-Fi 1..13 ↔ LoRa-подканал
  (433 МГц: шаг 125 кГц; 868 МГц: шаг 200 кГц) + уникальный SyncWord.
- `NODE_GATEWAY` читает канал Wi-Fi AP и сразу вещает `GW_BEACON`.
- `NODE_ROUTER` сканирует 1..13, выбирает шлюз по RSSI/hop_count и фиксируется.
- `NODE_CLIENT` делает хэндовер при `RSSI < -85 dBm` или двух потерянных маяках.
- Если шлюзов нет после двух циклов — `FALLBACK_OFFLINE_CHANNEL = 1`.
- При смене канала роутер очищает маршруты, `best_gw`, pending/ACK и dedup.

## Исправление web-чата

Причина: `const qc = useQueryClient()` был объявлен **после**
`useCallback(commitToCache)`, в массиве зависимостей которого уже использовался
`qc`. На web это давало TDZ-ошибку минифицированного имени `Bn` при открытии
чата.

Исправление: `qc` объявлен в начале компонента до всех `useCallback`/`useMemo`.
Проверено production-сборкой Expo: экран `/chat/:id` открывается, TDZ-ошибки нет.

## Обновление

1. Hub: применить миграции `035_mesh_v3.sql` и `036_kmesh_v1_rename.sql`.
   Существующие таблицы `mesh_v3_*` переименовываются без потери данных.
2. Клиент: локальная SQLite-таблица `mesh_v3_outbox` автоматически
   переименовывается в `kmesh_v1_outbox` при первом запуске.
3. Прошивка: пересобрать с `kmesh.v1 = true` и общим `temp_mesh_key`
   (32 байта hex) для всех узлов сети.
4. MQTT: обновить топики на `klinto/kmesh/v1/gw/<id>/{up,down,presence}`.
5. Внешние API-хосты `api.kinto.is-a.dev` и `api.kinto.io` сохранены для
   совместимости; бренд в интерфейсе — Klinto. Bundle ID `com.pink-project.kintoapp`
   и `com.pink_project.kintoapp` также сохранены, иначе перестанут работать
   Firebase/Google Services и обновления из стора.

## Нативные приложения

- `Klinto-android.apk` — подписан release-ключом (`apksigner`, v1/v2/v3),
  готов к установке. Версия 1.5.0 (versionCode 10500).
- `Klinto-unsigned.ipa` — unsigned IPA для Sideloadly (Apple ID пользователя).
- SHA-256 приложений лежит рядом с файлами.

## Проверка| Проверка | Результат |
| --- | --- |
| Host C++ | 518 проверок, 0 ошибок |
| ESP32 devkit (Arduino 3.3.12, RadioLib 7.8.1) | SUCCESS, flash 2.18 MB |
| ESP32-C3 (NimBLE) | SUCCESS |
| Client `tsc` | OK |
| C↔TS crypto vectors | совпадают |
| Hub `tsc` | OK |
| Expo web production | OK, чат открывается |
