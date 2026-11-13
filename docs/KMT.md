# Klinto Mesh Transport (KMT v1) — устаревший протокол

> Актуальная документация: [`ARCHITECTURE_AND_PROTOCOL.md`](../ARCHITECTURE_AND_PROTOCOL.md) (KMesh_v1).

KMT v1 переносил **произвольный JSON-трафик** приложения по BLE + Wi-Fi mesh,
когда у телефона не было интернета. Приложение не знало о транспорте:
`api.req()` переключался на KMT, если модуль подключён, а
`transportOnline = false`.

## Слои

1. **BLE/USB-кадр:** `A5 5A | ver | type | len u16 | payload | crc16`.
2. **Mesh-пакет:** 24-байтный заголовок + payload.
3. **KMT-конверт:** JSON `{kind, chatId, envelope, ...}`.
4. **Hub relay:** `POST /v1/mesh/relay`, `GET /v1/mesh/inbox`.

## Ограничения

- JSON и base64 раздувают кадр, не помещается в LoRa.
- Нет сквозного `msg_uuid` и постоянной истории.
- Нет частотного плана и хендовера между сотами.

KMT оставлен для старых клиентов и прошивки v2. Новые сборки используют
бинарный RPC KMesh_v1 и `klinto_core`.
