#!/usr/bin/env bash
# Выпуск/продление сертификата для доменов Klinto.
# Запускается по cron: пока DNS is-a.dev не указывает на этот сервер,
# скрипт молча выходит и ничего не ломает.
set -euo pipefail

SERVER_IP="150.251.143.212"
WEBROOT="/opt/klinto/web"
CERT_DIR="/opt/klinto/certs"
LINEAGE="150-251-143-212.nip.io"
DOMAINS=("150-251-143-212.nip.io" "klinto.is-a.dev" "api.klinto.is-a.dev")
EMAIL="${CERTBOT_EMAIL:-admin@klinto.is-a.dev}"

dns_ready=1
for d in "${DOMAINS[@]:1}"; do
  ip="$(getent ahostsv4 "$d" | awk 'NR==1{print $1}')"
  if [ "$ip" != "$SERVER_IP" ]; then
    dns_ready=0
    echo "[ssl] $d -> ${ip:-NXDOMAIN} (ждём $SERVER_IP)"
  fi
done
if [ "$dns_ready" -ne 1 ]; then
  echo "[ssl] DNS ещё не готов — пропускаем"
  exit 0
fi

args=()
for d in "${DOMAINS[@]}"; do args+=(-d "$d"); done

certbot certonly --webroot -w "$WEBROOT" \
  --cert-name "$LINEAGE" "${args[@]}" \
  --email "$EMAIL" --agree-tos --non-interactive --keep-until-expiring

install -m 644 "/etc/letsencrypt/live/$LINEAGE/fullchain.pem" "$CERT_DIR/cert.pem"
install -m 600 "/etc/letsencrypt/live/$LINEAGE/privkey.pem" "$CERT_DIR/key.pem"
docker exec klinto-web nginx -s reload
echo "[ssl] сертификат обновлён и nginx перезагружен"
