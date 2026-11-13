#!/bin/sh
# certbot deploy-hook: копируем свежий сертификат в контейнер web и перезагружаем nginx.
set -e
LINEAGE="150-251-143-212.nip.io"
install -m 644 "/etc/letsencrypt/live/$LINEAGE/fullchain.pem" /opt/klinto/certs/cert.pem
install -m 600 "/etc/letsencrypt/live/$LINEAGE/privkey.pem" /opt/klinto/certs/key.pem
docker exec klinto-web nginx -s reload || true
