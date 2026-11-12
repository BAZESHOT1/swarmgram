# IDENTITY — идентичность модулей Kinto

## Источник истины

Единственный идентификатор модуля — **заводской MAC Wi-Fi STA** из eFuse
(`esp_read_mac(mac, ESP_MAC_WIFI_STA)`). Он не меняется при перезагрузке,
сбросе и перепрошивке.

Каноническая форма в API и БД:

```
esp32-<12 hex lowercase>     например: esp32-4cd27bb7b3f8
```

Mesh Addr — тот же MAC в виде `4c:d2:7b:b7:b3:f8`.

## BLE

BLE MAC (`esp_read_mac(..., ESP_MAC_BT)` или `esp_bt_dev_get_address()`)
хранится **только как алиас** (`modules.ble_mac`) и используется для
сопоставления при BLE-подключении. Он никогда не заменяет Wi-Fi MAC.

## Стабильность

- Прошивка дополнительно кэширует `esp32-<mac>` в NVS (`swarm/hw_id`):
  даже при смене ядра/порядка байт идентичность не «переезжает».
- Сервер ищет модуль по `hardware_id`, `board_uuid` и `ble_mac`.
- Канонический `hardware_id` существующей записи **не перезаписывается**
  данными BLE — это раньше создавало второй модуль после повторного pairing.
- Уникальный индекс `modules (lower(hardware_id))` не даёт создать дубль.
- Дубли и записи с выдуманными MAC удалены миграциями 028/029.

## Где используется

| Слой | Поле |
|---|---|
| Hub API | `hardwareId`, `meshAddr`, `bleMac` |
| PostgreSQL | `modules.hardware_id`, `modules.mesh_addr`, `modules.ble_mac` |
| BLE INFO | `hardwareId`, `bleMac`, `publicId` |
| Beacon | `hw`, `mesh_addr`, `ble_mac` |
| Прошивка | `gHardwareId`, `gBleMac` |
| Приложение | `MeshIdentityService` |

`publicId` (8 цифр) остаётся только удобным коротким номером для ручного
ввода — он никогда не используется как первичный ключ.
