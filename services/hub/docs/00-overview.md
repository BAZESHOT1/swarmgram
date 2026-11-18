# Обзор проекта и инфраструктуры

Klinto (репозиторий SwarmGram) — мессенджер с E2E-шифрованием, который работает и без интернета: сообщения могут ходить через самодельные ESP32-модули (kMesh). Состав системы:

| Часть | Технологии | Где живёт |
| --- | --- | --- |
| **Клиент** (web, iOS, Android) | Expo / React Native, expo-router, TanStack Query, zustand | `client/` |
| **Hub** (главный сервер) | Fastify + TypeScript, PostgreSQL 17 | `services/hub/` |
| **Node** (пользовательский узел хранения) | Fastify, Docker | `services/node/` |
| **Сборщик прошивок** | Node + arduino-cli + ядро ESP32 3.3.12 | `services/firmware-builder/` |
| **Прошивка модулей** | C++/Arduino, NimBLE, RadioLib 8 | `firmware/klinto_core/` |
| **Веб-сервер** | nginx (раздаёт собранный web-клиент, проксирует `/api`) | контейнер `klinto-web` |

## Контейнеры на сервере

Сервер: `150.251.143.212`, каталог `/opt/swarmgram`. Всё описано в `docker-compose.hub.yml`.

| Контейнер | Образ | Назначение | Порты |
| --- | --- | --- | --- |
| `klinto-postgres` | postgres:17-alpine | База Hub, том `pgdata`, лимит памяти 220 МБ | внутренний |
| `klinto-hub` | klinto/hub:<версия> | API, WebSocket `/ws`, миграции `sql/*.sql` при старте | 8080 |
| `klinto-firmware` | образ сборщика | HTTP-сервис сборки прошивок, порт 8090 (только внутри сети) | внутренний |
| `klinto-web` | nginx:alpine | Раздаёт `/opt/swarmgram/web`, `nginx.conf`, сертификаты | 80, 3000, 443, 3443 |
| `swarmgram-node-*` | services/node | Узлы хранения фрагментов (3 реплики) | свои |

Файлы на хосте, которые должны быть свежими (контейнер без них собрать нельзя):

- `/opt/swarmgram/firmware/klinto_core/` — исходники прошивки; монтируются в сборщик только для чтения. Файл `BUILD` задаёт номер сборки прошивки (монотонный, нужен для анти-отката OTA).
- `/opt/swarmgram/services/firmware-builder/` — `server.mjs`, `entrypoint.sh`, шаблоны (`templates/`).
- `/opt/swarmgram/services/hub/` и `docker-compose.hub.yml` — исходники Hub и тег образа.
- `/opt/swarmgram/web/` — собранный web-клиент (`expo export -p web`).

## Выкладка

1. **Web**: `npx expo export -p web` → архив `dist` → распаковать в `/opt/swarmgram/web` (nginx отдаёт сразу).
2. **Hub**: собрать образ из `services/hub` (`docker build -t klinto/hub:X.Y.Z .`), поменять тег в `docker-compose.hub.yml`, `docker compose -f docker-compose.hub.yml up -d --no-build`. Миграции применяются при старте.
3. **Прошивка**: обновить `/opt/swarmgram/firmware/klinto_core`, скопировать `server.mjs` в `/opt/swarmgram/services/firmware-builder/` и в контейнер (`docker cp`), перезапустить `klinto-firmware`.
4. **iOS**: GitHub Actions `ios-unsigned.yml` (macos-15) собирает неподписанный IPA; релиз создаётся `gh release create vX.Y.Z` с файлом `Klinto-unsigned.ipa`.
5. **Android**: `android-apk.yml` (подписанный APK).

## Секреты и ключи

- `HUB_JWT_SECRET` — подпись токенов; `HUB_KEY_SECRET` — шифрование ключей server-чатов (`chat_key_versions.key_enc`). **Не терять**: без него история станет нечитаемой. При старте Hub пишет `key_material_check` (`failed` должно быть 0).
- `TEMP_MESH_KEY` — общий ключ KMesh_v1, вшивается в прошивку модулей и проверяется на `/kmesh/v1/relay`.
- `OTA_SIGNING_KEY` — приватный ключ подписи OTA-обновлений (публичный — в прошивке `klinto_ota_pubkey.h`).
- Резервные копии: `scripts/backup-hub.sh` каждые 6 часов (pg_dump + `.env`, шифрование AES-256-CBC).

## Что где читать дальше

- `01-hub-server.md` — серверная логика и маршруты.
- `02-database.md` — таблицы БД по группам.
- `03-client.md` — устройство клиента.
- `04-firmware.md` — прошивка модулей и сборщик.
- `05-kmesh.md` — протокол kMesh и обмен сообщениями.
- `06-modules-and-identity.md` — модули, владение, мастер прошивки, карта кластера.
- Справочные документы `ref-*.md` — ранее написанные подробные описания.
