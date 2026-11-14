# Klinto 1.10.2 — KMesh_v1 из приложения, прошивки 141

Дата: 14 ноября 2026 года.

## Клиент

- `sendViaMesh()` теперь сначала использует бинарный `KMeshV1Client`,
  а legacy JSON-конверт остаётся только как резерв.
- `NativeBleTransport` отдаёт `rawLink`: KMesh_v1 работает поверх того же
  GATT, без второго BLE-подключения.
- Исходящие сообщения уходят с `TO_INTERNET` на шлюз и в архив Hub;
  входящие `RPC_DOWN` попадают в кэш сообщений и превью чата.
- Адресация чата — `CRC16(chatId)` в 16-битном `chat_ref`.
- iOS BLE: `stopDeviceScan()` + 250 мс, mutex, 2 попытки, сравнение
  `name`/`localName` без регистра.

## Прошивка (fw_build 141)

- Единственный стек — KMesh_v1; `mesh_v2` выключен.
- ESP-NOW: пауза 25 мс, очередь 16, 3 повтора.
- `GW_BEACON` каждые 5 с с каналом; скан 120 мс; фиксация на канале шлюза.
- Шлюз: HTTP-релей и downlink-поллинг вместо обязательного MQTT.
- ESP32-C3: задача клиента пинована на core 0 (одноядерный чип).
- Совместимость со старым кадром `A5 5A` (HELLO→INFO).

## Проверка

| Проверка | Результат |
| --- | --- |
| Host-тесты ядра | 635 проверок, 0 ошибок |
| Hub relay → ACK → downlink | OK |
| Android APK | SUCCESS |
| iOS IPA | SUCCESS |
| Web export | OK |

## Артефакты

- `Klinto-android.apk` — versionCode 11002.
- `Klinto-unsigned.ipa` — buildNumber 11002.
- `klinto-web-1.10.2.zip`.
