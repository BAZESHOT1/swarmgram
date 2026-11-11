#!/usr/bin/env bash
# ============================================================
#  Точка входа build-сервиса.
#
#  Первый старт: скачивает индекс ESP32, ставит выбранную версию
#  ядра esp32:esp32 и нужные библиотеки в /data (несколько минут,
#  ~1–2 ГБ диска). Последующие старты используют том.
#
#  Если диска не хватает, сервис НЕ падает: он поднимает HTTP и
#  честно отвечает на /health (core:false), а сборки — понятной
#  ошибкой. Так Hub и визард показывают причину, а не таймаут.
#
#  Переменные:
#    ESP32_CORE_VERSION  версия ядра (по умолчанию 2.0.17 — заметно
#                        меньше 3.x, стабильна для LoRa/RadioLib)
#    ESP32_BOARDS        какие платы поддержать: через запятую
#                        esp32c3,esp32,esp32s3 (по умолчанию esp32c3).
#                        Для каждой платы ставится только её тулчейн —
#                        полный ESP32 core с четырьмя тулчейнами не
#                        влезает на маленький диск.
#    MIN_FREE_MB         минимум свободного места для установки (2500)
#    SKIP_CORE_INSTALL   =1 — не ставить ядро при старте (офлайн/отладка)
# ============================================================
set -uo pipefail

export DATA_DIR="${DATA_DIR:-/data}"
export ARDUINO_DIRECTORIES_DATA="${DATA_DIR}/arduino"
export ARDUINO_DIRECTORIES_USER="${DATA_DIR}/arduino-user"

CORE_URL="https://espressif.github.io/arduino-esp32/package_esp32_index.json"
CORE_VERSION="${ESP32_CORE_VERSION:-2.0.17}"
BOARDS="${ESP32_BOARDS:-esp32c3}"
MIN_FREE_MB="${MIN_FREE_MB:-2500}"

mkdir -p "${ARDUINO_DIRECTORIES_DATA}" "${ARDUINO_DIRECTORIES_USER}" "${DATA_DIR}/cache" "${DATA_DIR}/work"

echo "[builder] data=${ARDUINO_DIRECTORIES_DATA} user=${ARDUINO_DIRECTORIES_USER}"
echo "[builder] версия ядра: esp32:esp32@${CORE_VERSION}, платы: ${BOARDS}"

# Свободное место в МБ на разделе с /data.
free_mb() {
  df -Pm "${DATA_DIR}" 2>/dev/null | awk 'NR==2 {print $4}' | tr -dc '0-9'
}

FREE_MB="$(free_mb)"
echo "[builder] свободно на ${DATA_DIR}: ${FREE_MB:-?} МБ (нужно ~${MIN_FREE_MB} МБ для установки ядра)"

core_installed() {
  arduino-cli core list 2>/dev/null \
    | awk '{print $1}' | grep -qx 'esp32:esp32'
}

start_server() {
  echo "[builder] запускаем HTTP-сервер на порту ${PORT:-8090}"
  exec node /app/server.mjs
}

if [ "${SKIP_CORE_INSTALL:-0}" = "1" ]; then
  echo "[builder] SKIP_CORE_INSTALL=1 — пропускаем установку ядра"
  start_server
fi

# Урезанный индекс: platform toolsDependencies содержит все тулчейны
# (xtensa ×2, riscv, gdb, openocd) — это несколько ГБ. Оставляем только
# esptool/файловые утилиты и gcc для выбранных плат.
TRIMMED_INDEX="${DATA_DIR}/package_esp32_index.json"
build_trimmed_index() {
  curl -fsSL "${CORE_URL}" -o "${DATA_DIR}/package_esp32_index.raw.json" || return 1
  ESP32_BOARDS="${BOARDS}" node -e '
    const fs = require("fs");
    const [src, dst] = process.argv.slice(1);
    const boards = String(process.env.ESP32_BOARDS || "esp32c3").split(",").map((b) => b.trim()).filter(Boolean);
    const gcc = {
      esp32c3: ["riscv32-esp-elf-gcc", "esp-rv32", "esp32c3-libs"],
      esp32: ["xtensa-esp32-elf-gcc", "esp-x32", "esp32-libs"],
      esp32s3: ["xtensa-esp32s3-elf-gcc", "esp-x32", "esp32s3-libs"],
    };
    const keep = new Set(["esptool_py", "mklittlefs", "mkspiffs", "dfu-util"]);
    for (const b of boards) if (gcc[b]) for (const name of gcc[b]) keep.add(name);
    const idx = JSON.parse(fs.readFileSync(src, "utf8"));
    for (const pkg of idx.packages) {
      if (pkg.name !== "esp32") continue;
      for (const pl of pkg.platforms) {
        if (Array.isArray(pl.toolsDependencies)) {
          pl.toolsDependencies = pl.toolsDependencies.filter((t) => keep.has(t.name));
        }
      }
      if (Array.isArray(pkg.tools)) pkg.tools = pkg.tools.filter((t) => keep.has(t.name));
    }
    fs.writeFileSync(dst, JSON.stringify(idx));
    console.error(`[builder] урезанный индекс: платы ${boards.join(", ")}, инструменты ${[...keep].join(", ")}`);
  ' "${DATA_DIR}/package_esp32_index.raw.json" "${TRIMMED_INDEX}"
  rm -f "${DATA_DIR}/package_esp32_index.raw.json"
}

if core_installed; then
  echo "[builder] ядро esp32:esp32 уже установлено"
else
  if [ -z "${FREE_MB}" ] || [ "${FREE_MB}" -lt "${MIN_FREE_MB}" ]; then
    echo "[builder] ВНИМАНИЕ: недостаточно свободного места для установки ESP32 core." >&2
    echo "[builder] Освободите диск (нужно ~${MIN_FREE_MB} МБ) или соберите прошивки на другой машине;" >&2
    echo "[builder] Hub ответит понятной ошибкой, сервис останется запущенным." >&2
    start_server
  fi

  echo "[builder] готовим урезанный индекс плат..."
  if ! build_trimmed_index; then
    echo "[builder] не удалось скачать/подготовить индекс плат (сеть?). Сборки недоступны." >&2
    start_server
  fi

  echo "[builder] ставим ядро esp32:esp32@${CORE_VERSION} (первый запуск, это долго)..."
  if ! arduino-cli core update-index --additional-urls "file://${TRIMMED_INDEX}"; then
    echo "[builder] не удалось обновить индекс плат. Сборки недоступны." >&2
    start_server
  fi
  if ! arduino-cli core install "esp32:esp32@${CORE_VERSION}" --additional-urls "file://${TRIMMED_INDEX}"; then
    echo "[builder] не удалось установить ядро esp32:esp32@${CORE_VERSION}." >&2
    start_server
  fi
fi

# Библиотеки: LoRa (SX127x), ArduinoJson, RadioLib (SX1262).
# RadioLib пинится на 6.x: в 8.x изменился API begin(), и шаблон перестаёт
# собираться. Ошибка установки библиотеки не должна ронять сервис.
install_lib() {
  local name="$1"
  local ver="$2"
  local cur
  cur="$(arduino-cli lib list 2>/dev/null | awk -v n="${name}" '$1==n {print $2; exit}')"
  if [ "${cur}" = "${ver}" ]; then
    echo "[builder] библиотека ${name} ${ver} уже есть"
    return 0
  fi
  if [ -n "${cur}" ]; then
    echo "[builder] заменяем ${name} ${cur} -> ${ver}..."
    arduino-cli lib uninstall "${name}" >/dev/null 2>&1 || true
  else
    echo "[builder] ставим библиотеку ${name}@${ver}..."
  fi
  arduino-cli lib install "${name}@${ver}" || echo "[builder] библиотеку ${name}@${ver} поставить не удалось" >&2
}

install_lib LoRa 0.8.0
install_lib ArduinoJson 7.4.3
install_lib RadioLib 6.6.0

start_server
