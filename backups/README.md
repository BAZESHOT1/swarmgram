# Резервные копии SwarmGram Hub

Здесь лежит зашифрованная копия БД главного сервера **вместе с ключами
шифрования и `.env`**. Это критично: без `HUB_KEY_SECRET` серверные ключи
чатов восстановить невозможно, и пользователи потеряют доступ к истории.

## Что внутри архива

- `db.dump` — полный `pg_dump` (users, chats, messages, objects,
  `chat_key_versions`, `account_chat_keys`, `chat_keys`, `key_backups`,
  модули и т.д.);
- `env` — `.env` сервера, включая `HUB_KEY_SECRET`, `HUB_JWT_SECRET`,
  `HUB_ADMIN_TOKEN`;
- `docker-compose.hub.yml`;
- `SHA256SUMS`.

Архив зашифрован AES-256-CBC (PBKDF2). Пароль — в
`/root/.swarmgram-backup.pass` на сервере и в локальном файле
`C:\Users\vital\.swarmgram-backup.pass` (вне OneDrive). **Обязательно
сохраните пароль в менеджере паролей.** Без него архив бесполезен.

## Автоматизация

- Скрипт: `/opt/swarmgram/scripts/backup-hub.sh`
- Cron: ежедневно в 03:15
- Хранение: 7 дней (`BACKUP_KEEP_DAYS`)
- Лог: `/var/log/swarmgram-backup.log`
- Проверено восстановлением в отдельную БД: users=5, key_versions=5,
  account_keys=2, messages=19, objects=37.

Для офсайта задайте `BACKUP_REMOTE`, например:
`BACKUP_REMOTE="rclone copy"` и настройте remote. Сейчас копия также
складывается в эту папку OneDrive (зашифрованная).

## Восстановление (кратко)

```bash
# на сервере
TMP=$(mktemp -d)
openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/root/.swarmgram-backup.pass \
  -in swarmgram-hub-YYYYmmdd-HHMMSS.tar.gz.enc -out "$TMP/a.tar.gz"
tar -xzf "$TMP/a.tar.gz" -C "$TMP"

docker cp "$TMP/db.dump" swarmgram-postgres:/tmp/restore.dump
docker exec swarmgram-postgres dropdb -U swarm --if-exists swarm
docker exec swarmgram-postgres createdb -U swarm swarm
docker exec swarmgram-postgres pg_restore -U swarm -d swarm --no-owner /tmp/restore.dump

# вернуть .env (HUB_KEY_SECRET!) и перезапустить Hub
cp "$TMP/env" /opt/swarmgram/.env
cd /opt/swarmgram && docker compose -f docker-compose.hub.yml up -d --force-recreate hub
```

После восстановления Hub на старте пишет в лог `key_material_check` с
`failed: 0`. Если `failed > 0` — проверьте, что `.env` взят из того же
архива (несовпадение `HUB_KEY_SECRET` делает старые ключи нечитаемыми).

## Ротация ключа (осторожно)

1. Сделайте бэкап.
2. `HUB_KEY_SECRET_OLD=<старый>` и `HUB_KEY_SECRET=<новый>` в `.env`.
3. Перезапустите Hub — старые ключи читаются `OLD`, новые пишутся `NEW`.
4. Не удаляйте `OLD`, пока все `chat_key_versions` не перешифрованы.
