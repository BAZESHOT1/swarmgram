# Klinto — архитектура (кратко)

## Роли

| Роль | Что делает | Чего не делает |
| --- | --- | --- |
| **Hub** (главный сервер) | Аккаунты, username (смена раз в 90 дней), чаты/каналы/подписки, метаданные сообщений (`object_id + nonce + header`), выдача подписанных маршрутов, мониторинг/блокировка узлов (IP+HW), квоты, кредиты, админ-API | Не хранит ни сообщения, ни медиа; не расшифровывает |
| **Node** (пользовательский узел, Docker) | Хранит фрагменты шифротекстов (3 копии), отдаёт по тикету, heartbeat (место, версия, IP, HW-отпечаток, подсеть) | Не имеет ключей |
| **Client** (web/iOS/Android, RN + expo-router) | E2E, сама раскладывает конверты на 3 узла, offline-очередь в sqlite, BLE-транспорт к модулю, каналы | Не доверяет Hub |
| **Admin** (users.role='admin' или `x-admin-token`) | Панель: пользователи, узлы, модули, чаты/каналы — блокировка с текстом причины, квоты/планы, роли, аудит | — |

## Хранение и репликация

- `POST /v1/objects/init` -> 3 реплики в разных подсетях, билеты на запись
- Клиент сам кладёт шифротекст `PUT <node>/fragments/:oid/:idx`
- `POST /v1/objects/:id/commit` фиксирует подтверждения
- `replicator`: восстановление копий с живых реплик + верификация SHA-256 (порченая реплика вычёркивается)
- `monitor`: degraded/offline по heartbeat, публичный ping, суточные кредиты

## Транспорт

| Режим | Цепочка |
| --- | --- |
| Интернет | client ⇄ Hub WS |
| ESP32 via gateway | клиент ⇄ BLE ⇄ личный/публичный модуль ⇄ WiFi/шлюз ⇄ Hub |
| ESP32 direct | клиент ⇄ BLE ⇄ модуль ⇄ … ⇄ модуль ⇄ BLE ⇄ клиент (без интернета) |
| LoRa hop | то же с LoRa-звеном между модулями |

## Модули расширения (ESP32)

Типы (`modules.module_type`):

| type | Назначение | Связь с клиентом | Доступ в интернет | Ретрансляция чужих |
| --- | --- | --- | --- | --- |
| `personal` | Носимый, владелец = пользователь | BLE к устройству владельца | через шлюз соседа (gateway=true) | опционально, флаг `is_public` (проверка по username на downlink) |
| `public` | Автономный ретранслятор | BLE к любому рядом | WiFi-роутер | всегда, для всех |
| `latent` | Расширение радиуса mesh | BLE/WiFi/LoRa mesh | никогда | только store&forward, без Hub |

Два режима личного модуля:
1. «через посредника» (у устройства владельца нет сети): клиент1 → personal1 → personal2 → клиент(с сетью) → Hub → узлы — на бэкенде реализовано `POST /v1/mesh/relay` (octet-stream, Hub раскладывает на 3 узла и создаёт message, проверяет подпись и членство).
2. «локально» (никто не в сети): общение напрямую BLE/LoRa; при появлении сети клиент делает `POST /v1/mesh/sync` на каждый локальный конверт — идемпотентно по `client_id` (unique index, дубликаты склеиваются).

Downlink для модуля: `GET /v1/mesh/inbox?username=<peer>&since=<seq>` — право релея проверяется (владелец / public / personal.is_public / общий чат). Ack: `POST /v1/mesh/ack {username, messageIds}` → receipt + WS `message_delivered` отправителю.

Подпись конверта: `sig = ECDSA-P256(sha256(chatId + "|" + ciphertext))` приватным identity-ключом отправителя, Hub проверяет по `devices.identity_pub` — модуль подделать не может.

Формат BLE/LoRa пакета (JSONL): {chatId, ciphertext(b64), nonce, kind, senderDeviceId, clientId?, sig}.

ESP32 прошивка-референс: `firmware/messenger_module/messenger_module.ino`.

## Команды

```bash
cp node.env.example .env     # MAIN_SERVER_URL, OWNER_USERNAME, NODE_CLAIM_TOKEN, NODE_PUBLIC_URL, NODE_HW_HASH?
docker compose -f docker-compose.node.yml up -d --build

python3 scripts/issue_claim.py imbirok        # выдать claim-токен администратором
python3 scripts/bootstrap_demo.py             # (инфруктурная демо-инициализация)
python3 scripts/e2e_check.py                  # сквозная проверка
```

## API админ-панели (сезон: role=admin или x-admin-token)

- `GET/POST /v1/admin/users, /v1/admin/users/:id/status|role|quota, DELETE /v1/admin/users/:id`
- `GET /v1/admin/nodes, POST /v1/admin/nodes/:id/block|unblock (причина текстом)`
- `GET /v1/admin/modules, POST /v1/admin/modules/:id/block|unblock (причина ID/plate)`
- `GET /v1/admin/chats?type=…, POST /v1/admin/chats/:id/block|unblock, DELETE /v1/admin/chats/:id`
- `GET /v1/admin/blocked, DELETE /v1/admin/blocked/:id`
- `GET /v1/admin/audit` — журнал `audit_log` (каждое действие с причиной)

UI админ-панели — следующая итерация клиента (пункт «Администрирование» в профиле/сети при роли admin).
