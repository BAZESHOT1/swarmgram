# Klinto 1.10.3 — маршрутизация KMesh_v1 и сервисные RPC

Дата: 14 ноября 2026 года.

## Сервер

- Hub хранит `chat_ref = CRC16(chatId)` и маршрутизирует текст каждому
  получателю чата по `node_id` через `kmesh_v1_downlink`.
- `SEARCH_REQ`, `FEED_SYNC_REQ`, `CHAT_HISTORY_REQ` выполняются на Hub,
  ответы уходят обратно на узел отправителя.
- Downlink отдаёт пакеты конкретному шлюзу и глобальные (`gateway_id = 0`),
  поэтому офлайн-узел получит сообщение от первого шлюза, который его увидит.
- Миграция `041_kmesh_v1_routing.sql`.

## Клиент

- `onStatus` обновляет `kmesh_v1_outbox` и снимает «часики» у сообщения
  в ленте по ACK/доставке.
- `onSearch/onFeed/onHistory` публикуются в событийную шину
  `kmesh/v1/events.ts`.
- `chat_ref` регистрируется на Hub для известных чатов и при отправке.
- `SET_CONFIG` и `SET_OWNER` отправляются бинарными кадрами KMesh_v1.
- Исправлен разбор `FEED_SYNC_RESP` (count в `payload[6]`, записи с 7).

## Проверка

| Проверка | Результат |
| --- | --- |
| Host-тесты ядра | 635 проверок, 0 ошибок |
| Hub RPC/крипто | OK |
| Hub relay → archive → ACK → downlink | OK |
| Hub routing 700000001 → 700000002 | OK |
| Android APK | SUCCESS |
| iOS IPA | SUCCESS |
| Web export | OK |

## Артефакты

- `Klinto-android.apk` — versionCode 11003.
- `Klinto-unsigned.ipa` — buildNumber 11003.
- `klinto-web-1.10.3.zip`.
