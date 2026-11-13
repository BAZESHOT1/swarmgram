# ============================================================
#  Firmware builder Klinto: arduino-cli + Node.js HTTP-обёртка.
#  ESP32 core НЕ ставится в образ: entrypoint доустанавливает его
#  в том /data при первом старте (образ остаётся компактным).
# ============================================================
FROM node:20-bookworm-slim

ARG ARDUINO_CLI_VERSION=1.1.1
ARG TARGETARCH=amd64

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates python3 python3-serial python3-cryptography python3-ecdsa \
 && rm -rf /var/lib/apt/lists/*

# arduino-cli берём с GitHub releases. Для arm64 подставляется отдельный архив.
RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) ARCH="Linux_ARM64" ;; \
      *)     ARCH="Linux_64bit" ;; \
    esac; \
    curl -fsSL "https://github.com/arduino/arduino-cli/releases/download/v${ARDUINO_CLI_VERSION}/arduino-cli_${ARDUINO_CLI_VERSION}_${ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin arduino-cli; \
    chmod +x /usr/local/bin/arduino-cli; \
    arduino-cli version

WORKDIR /app

COPY services/firmware-builder/server.mjs ./server.mjs
COPY services/firmware-builder/entrypoint.sh ./entrypoint.sh
COPY services/firmware-builder/templates ./templates
# Canonical portable mesh core (also unit-tested on the host).
COPY firmware/klinto_core ./klinto_core

RUN chmod +x ./entrypoint.sh

ENV PORT=8090 \
    DATA_DIR=/data

EXPOSE 8090

ENTRYPOINT ["/app/entrypoint.sh"]
