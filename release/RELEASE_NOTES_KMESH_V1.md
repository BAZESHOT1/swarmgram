# Klinto 1.5.0 — KMesh_v1

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

## Проверка

| Проверка | Результат |
| --- | --- |
| Host C++ | 518 проверок, 0 ошибок |
| ESP32 devkit (Arduino 3.3.12, RadioLib 7.8.1) | SUCCESS, flash 2.18 MB |
| ESP32-C3 (NimBLE) | SUCCESS |
| Client `tsc` | OK |
| C↔TS crypto vectors | совпадают |
| Hub `tsc` | OK |
| Expo web production | OK, чат открывается |
