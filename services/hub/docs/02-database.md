# База данных (PostgreSQL)

Схема создаётся миграциями `services/hub/sql/NNN_*.sql`; Hub применяет их по порядку при старте (все `IF NOT EXISTS`, повторный запуск безопасен). Сейчас миграции 001–042.

## Аккаунты и устройства

| Таблица | Назначение |
| --- | --- |
| `users` | Аккаунт: username, email, роль (`user`/`admin`), статус, квоты, профиль и настройки |
| `username_history` | История смены username (ограничение раз в 90 дней) |
| `devices` | Устройства пользователя; `identity_pub` — публичный ключ подписи (JWK P-256), им проверяются подписи kMesh |
| `prekeys` | Одноразовые ключи для начала E2E-сессии |
| `refresh_tokens`, `email_codes` | Сессии и коды подтверждения почты |
| `account_chat_keys`, `key_backups` | Публичные ключи аккаунта (ECDH) и резерв ключей |
| `user_blocks`, `user_reports`, `user_warnings` | Блокировки между пользователями, жалобы, предупреждения |
| `push_tokens`, `push_notifications` | Токены push и очередь уведомлений |

## Чаты и сообщения

| Таблица | Назначение |
| --- | --- |
| `chats`, `chat_members` | Диалоги, секретные чаты, группы, каналы и их участники |
| `chat_keys`, `chat_key_versions` | Ключи чатов; в `chat_key_versions.key_enc` серверные ключи, зашифрованные `HUB_KEY_SECRET` |
| `messages` | Сообщение: `kind`, `header` (JSON), `object_id`/`nonce` или встроенный шифртекст, `msg_uuid` (уникален в чате) |
| `message_receipts`, `message_reactions`, `message_views` | Доставка, реакции, просмотры |
| `chat_invite_links`, `chat_join_requests`, `chat_bans`, `chat_audit`, `post_comments` | Группы и каналы |

## Хранение (узлы)

| Таблица | Назначение |
| --- | --- |
| `nodes`, `node_claims`, `node_events`, `blocked_nodes` | Пользовательские узлы, привязка, события, блокировки по IP/HW |
| `objects`, `fragments`, `object_grants` | Зашифрованные объекты и их реплики (3 копии в разных подсетях) |
| `node_contributions`, `ledger` | Вклад узлов и кредиты |

## Модули (устаревшая серверная модель)

| Таблица | Назначение |
| --- | --- |
| `modules` | Запись модуля: `hardware_id` (`esp32-<MAC>`), роль, плата, прошивка, батарея, владелец, `public_id`, блокировка |
| `module_neighbors` | Соседи модуля из presence |
| `module_networks`, `module_shadows` | Сети и «теневые» записи модулей, привязанных на другом устройстве |
| `module_transfers` | Заявки на перенос (старый механизм) |
| `module_ota_jobs`, `firmware_releases` | OTA-задания и **последняя версия прошивки по плате** (формат `<версия>/<сборка>`) |
| `firmware_builds` | История серверных сборок: конфиг, статус, прогресс, путь к `.bin`, версия |
| `mesh_config` | Singleton глобальной mesh-сети (SSID, канал, параметры LoRa) |

## kMesh_v1

| Таблица | Назначение |
| --- | --- |
| `kmesh_v1_presence` | Последний presence узла: шлюз, RSSI, батарея, роль, `display_name`, срок жизни |
| `kmesh_v1_links` | Прямые связи узел↔сосед (`rssi`, `flags`: 1 — шлюз, 2 — LoRa), источник карты кластера |
| `kmesh_v1_gateways` | Активные шлюзы (выход в Hub) |
| `kmesh_v1_node_bindings` | Привязка узла (nodeId) к пользователю |
| `kmesh_v1_messages`, `kmesh_v1_archive`, `kmesh_v1_sync_events` | Полученные из mesh сообщения, облачный архив, события синхронизации |
| `kmesh_v1_downlink` | Очередь доставки с Hub на модули через шлюз |
| `kmesh_v1_chat_refs` | Соответствие `chat_ref = CRC16(chatId)` ↔ чат для маршрутизации |
| `kmesh_v1_entity_map` | Сопоставление сущностей для поиска |
| `kmesh_nodes_telemetry` | Телеметрия узлов (роль, заряд, LoRa) |
| `kmesh_ota_releases`, `kmesh_ota_manifests` | Релизы OTA для модулей и их манифесты |

## Личность и владение модулями

| Таблица | Назначение |
| --- | --- |
| `user_net_identities` | Сетевая личность пользователя: `net_id` (u32) и `ble_prefix` (8 hex) — префикс BLE-имени `KL-<PREFIX>-<MOD6>` |
| `user_modules` | **Владение по MAC**: `module_mac` (PK), `mod6` (последние 3 байта MAC), `owner_user_id`, `custom_name` |
| `module_transfer_contracts` | Передача модуля: старый владелец подтверждает, `claim_token` выдаётся новому владельцу |

## Прочее

`audit_log` (журнал админ-действий), `handover_events`, `telemetry_reports`, `offline_sync_batches`, `mesh_inbox`, `mesh_devices`, `search_history` (поле в профиле).

## Полезные запросы

```
select board, version from firmware_releases;               -- последние версии прошивки
select module_mac, custom_name from user_modules;           -- модули по MAC
select node_id, neighbor_id, rssi from kmesh_v1_links where seen_at > now() - interval '10 minutes';
```
