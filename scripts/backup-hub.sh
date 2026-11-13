#!/usr/bin/env bash
# ============================================================================
#  Klinto Hub — резервная копия БД вместе с ключами шифрования.
#
#  Что попадает в архив:
#    - pg_dump всей БД (users, chats, messages, chat_keys, chat_key_versions,
#      account_chat_keys, key_backups, objects, module_* и т.д.);
#    - .env (HUB_KEY_SECRET, HUB_JWT_SECRET, HUB_ADMIN_TOKEN, SMTP и пр.);
#    - docker-compose.hub.yml.
#
#  Без .env и HUB_KEY_SECRET ключи server-чатов восстановить невозможно,
#  поэтому архив шифруется AES-256-CBC паролем из /root/.klinto-backup.pass.
#  Пароль обязательно храните ВНЕ этого сервера (менеджер паролей/офлайн).
#
#  Запуск:  /opt/klinto/scripts/backup-hub.sh
#  Cron:    15 3 * * * /opt/klinto/scripts/backup-hub.sh >> /var/log/klinto-backup.log 2>&1
#
#  Переменные:
#    BACKUP_DIR       каталог архивов (по умолчанию /opt/klinto/backups)
#    BACKUP_KEEP_DAYS сколько дней хранить (по умолчанию 7)
#    BACKUP_PASS_FILE файл с паролем (по умолчанию /root/.klinto-backup.pass)
#    BACKUP_REMOTE    опционально: команда копирования, например
#                     "rclone copy" — архив будет отправлен в настроенный remote
# ============================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
PASS_FILE="${BACKUP_PASS_FILE:-/root/.klinto-backup.pass}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"
ARCHIVE="${BACKUP_DIR}/klinto-hub-${STAMP}.tar.gz.enc"
LOCK="${BACKUP_DIR}/.backup.lock"

cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

# Один бэкап за раз.
exec 9>"${LOCK}"
if ! flock -n 9; then
  echo "[backup] уже выполняется, пропускаем"
  exit 0
fi

# Пароль шифрования: генерируем один раз, если файла нет.
if [ ! -f "${PASS_FILE}" ]; then
  umask 077
  openssl rand -base64 48 > "${PASS_FILE}"
  chmod 600 "${PASS_FILE}"
  echo "[backup] создан новый пароль ${PASS_FILE} — СКОПИРУЙТЕ ЕГО ВНЕ СЕРВЕРА!"
fi

COMPOSE="${ROOT_DIR}/docker-compose.hub.yml"
ENV_FILE="${ROOT_DIR}/.env"
PG_CONTAINER="${PG_CONTAINER:-klinto-postgres}"
PG_USER="${POSTGRES_USER:-klinto}"
PG_DB="${POSTGRES_DB:-klinto}"

echo "[backup] $(date -Is) старт"

# 1) Дамп БД (custom format — восстанавливается pg_restore).
docker exec "${PG_CONTAINER}" pg_dump -U "${PG_USER}" -d "${PG_DB}" -Fc > "${WORK}/db.dump"
# Проверяем, что дамп читается (pg_restore требует seekable-файл).
docker cp "${WORK}/db.dump" "${PG_CONTAINER}:/tmp/klinto-db.dump" >/dev/null
docker exec "${PG_CONTAINER}" pg_restore -l /tmp/klinto-db.dump > /dev/null
docker exec "${PG_CONTAINER}" rm -f /tmp/klinto-db.dump
# 2) Конфигурация и ключи.
cp "${ENV_FILE}" "${WORK}/env"
cp "${COMPOSE}" "${WORK}/docker-compose.hub.yml"
chmod 600 "${WORK}/env"

# 3) Манифест с контрольными суммами.
(
  cd "${WORK}"
  sha256sum db.dump env docker-compose.hub.yml > SHA256SUMS
)

# 4) Архив + шифрование.
tar -czf - -C "${WORK}" . \
  | openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:${PASS_FILE}" -out "${ARCHIVE}"
chmod 600 "${ARCHIVE}"

SIZE="$(du -h "${ARCHIVE}" | awk '{print $1}')"
echo "[backup] готово: ${ARCHIVE} (${SIZE})"

# 5) Офсайт (опционально).
if [ -n "${BACKUP_REMOTE:-}" ]; then
  echo "[backup] копируем офсайт: ${BACKUP_REMOTE} ${ARCHIVE}"
  ${BACKUP_REMOTE} "${ARCHIVE}"
fi

# 6) Ротация.
find "${BACKUP_DIR}" -maxdepth 1 -name 'klinto-hub-*.tar.gz.enc' -type f -mtime "+${KEEP_DAYS}" -print -delete
echo "[backup] $(date -Is) готово"
