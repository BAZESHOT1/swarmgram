# SwarmGram

Мессенджер нового поколения с децентрализованным хранением: **главный сервер — оркестратор, пользовательские узлы — хранилище**.

```
Клиент ──► Главный сервер (Hub) ──► маршрут/тикет ──► Узлы пользователей ──► Клиент
                (оркестратор)                          (только шифротексты)
```

- Сообщения и медиа хранятся на узлах **в зашифрованном виде, в 3 экземплярах**.
- Ключи шифрования хранятся **только на устройствах пользователей**.
- Hub знает маршруты, метаданные и статусы узлов, но **не может прочитать содержимое**.
- Любой пользователь может поднять узел одним `docker compose up -d`.

## Состав репозитория

```
services/hub/    — главный сервер (оркестратор): аккаунты, чаты, репликация, мониторинг
services/node/   — образ узла хранения (для серверов пользователей)
services/firmware-builder/ — сборка прошивок ESP32 (arduino-cli)
client/          — Expo/React Native клиент: web, iOS, Android
docs/            — архитектура mesh-модулей и эксплуатация
```

## Быстрый старт (главный сервер)

```bash
cp .env.example .env          # заполнить секреты
docker compose -f docker-compose.hub.yml up -d --build
```

- Веб-клиент: `http://<IP>:3000`
- API: `http://<IP>:8080/v1/...`
- Проверка: `curl http://<IP>:8080/health`

## Быстрый старт (узел на своём сервере)

1. В клиенте: профиль → «Мои узлы» → **Создать токен привязки** (живёт 30 минут).
2. На своём сервере:

```bash
cp node.env.example .env
# MAIN_SERVER_URL уже прописан; указать OWNER_USERNAME и NODE_CLAIM_TOKEN
docker compose -f docker-compose.node.yml up -d
```

Узел сам регистрируется в Hub, получает `node_id` + секрет подписи тикетов и начинает слать heartbeat.

## Документация

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — полная архитектура, схема БД, криптография, протоколы.
- [`services/node/README.md`](services/node/README.md) — жизненный цикл узла.
- [`docs/module-mesh-architecture.md`](docs/module-mesh-architecture.md) — Wi-Fi/LoRa mesh, BLE/USB-протокол.
- [`docs/operations.md`](docs/operations.md) — ключи, бэкапы, TLS, эксплуатация.

## iOS-сборка без Apple Developer аккаунта

GitHub Actions workflow [`.github/workflows/ios-unsigned.yml`](.github/workflows/ios-unsigned.yml)
собирает **unsigned IPA** для реального iPhone (`arm64`, Release). Apple-аккаунт
для сборки не нужен.

1. Запустить workflow **iOS unsigned IPA** (вручную или push в `main`).
2. Скачать артефакт `SwarmGram-unsigned-ipa`.
3. Установить через **Sideloadly** на iPhone, войдя своим Apple ID — Sideloadly
   подпишет приложение самоподписанным сертификатом.

Ограничения бесплатной подписи: приложение нужно переподписывать раз в 7 дней,
BLE работает только в native-сборке (Expo Go и Safari не поддерживают BLE).
API-адрес нативного клиента: `https://150-251-143-212.nip.io:3443/api`
(Let's Encrypt; HTTP на iOS блокируется ATS).

