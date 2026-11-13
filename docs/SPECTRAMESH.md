# SpectraMesh-подобная архитектура (устаревшее, v2)

> Актуальная документация: [`ARCHITECTURE_AND_PROTOCOL.md`](../ARCHITECTURE_AND_PROTOCOL.md) (Klinto KMesh_v1).

Этот документ описывал mesh-сеть модулей v2. Идея заимствована у
[SpectraMesh](https://github.com/SpectraMeshCore/spectramesh): каждый радиоинтерфейс —
«оттенок» (hue), маршруты без петель, служебные кадры аутентифицированы.
Кластеризация и межкластерный хендовер — расширения Klinto.

## Идентичность

- Основной mesh-адрес: 6-байтный MAC Wi-Fi STA (`esp_read_mac`,
  `ESP_MAC_WIFI_STA`), строка `esp32-<12 hex>`.
- BLE MAC — только псевдоним (`esp_bt_dev_get_address` / `ESP_MAC_BT`).
- `hardwareId` — стабильный `esp32-<12 hex>`.
- `nodeId` — FNV-1a 32 от `hardwareId`.

## Интерфейсы (hues)

- `wifi` — ESP-NOW / Wi-Fi mesh;
- `lora` — дальнобойный канал;
- `ble` — только мост к телефону, транзит запрещён.

## Маршрутизация v2

- Кластеры с `cluster_id`, границы (`border`), якоря (`is_anchor`).
- Handover носимого узла между кластерами.
- Метрика EWMA задержки, `hops`, глубина очереди.
- Ограничение: таблица пиров ESP-NOW и broadcast-шторм.

## Почему появился KMesh_v1

- ESP-NOW через broadcast и `next_hop_id` вместо таблицы пиров.
- Единый `MeshPacket` для ESP-NOW/LoRa/интернета.
- Частотные соты 1..13 и автоматический выбор канала.
- Двухэтапное шифрование и постоянная история.

Старые поля и структуры v2 оставлены только для обратной совместимости
прошивки `klinto_module_v2.ino`.
