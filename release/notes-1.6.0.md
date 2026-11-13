# Klinto 1.6.0 — гибридный KMesh_v1

Дата: 14 ноября 2026 года. Прошивка модулей: **1.2**. Hub: **1.2.0**.

## Главное

- **Гибридные носимые узлы (`HYBRID_PORTABLE_NODE`).** Каждый `NODE_CLIENT`
  по умолчанию — клиент + умный ретранслятор + мобильный шлюз.
- **Smart Portable Relay.** Транзит с роль-штрафом: `+60 мс` ESP-NOW и
  `+250 мс` LoRa поверх RSSI-backoff; стационарные узлы всегда первыми.
- **Battery Guard.** `< 20%` без зарядки — транзит и мобильный шлюз выключены;
  `> 25%` — снова включены; зарядка снимает ограничение.
- **Мобильный шлюз.** `INET_STATUS` раз в 15 секунд, `GW_BEACON` с
  `hop_count = 2`, интервал 25 секунд, TTL 60 секунд. Uplink/Downlink через
  `PROXY_UP`/`PROXY_DOWN`, Zero-Trust, лимит 10 МБ/сутки.
- **Сервисные RPC через радиосеть:** поиск (`RPC_SEARCH_*`), лента
  (`RPC_FEED_SYNC_*`), история (`RPC_CHAT_HISTORY_*`), все с `PRIORITY_LOW`.
- **Hub `/v1/kmesh/v1/*`:** `search`, `feed`, `history`, `channel/gateways`,
  `mobile/archive`, `mobile/presence`, `node/bind`; миграция 037.

## Артефакты

- `Klinto-android.apk` — подписанный release APK, versionCode 10600.
- `Klinto-unsigned.ipa` — unsigned IPA для Sideloadly.
- `klinto-web-1.6.0.zip` — production-сборка веб-клиента.
- `klinto-core-1.6.0.zip` — ядро прошивки и тесты.
- SHA-256 приложений — рядом с файлами.

## Проверка

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
| Серверная сборка прошивки 1.2 (C3) | SUCCESS |
