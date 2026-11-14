// Добавляет раздел про OTA/телеметрию в README.md.
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'README.md';
let text = readFileSync(path, 'utf8');
const marker = '## Обновление прошивок по радио (OTA)';
if (text.includes(marker)) {
  console.log('already present');
  process.exit(0);
}

const insertBefore = '## Документация';
const section = `## Обновление прошивок по радио (OTA)

Прошивка **1.3** собирается с двумя OTA-слотами и укладывается в 1.75 МБ:

| Плата | Flash-слот | Размер прошивки (RAM) |
| --- | --- | --- |
| ESP32-C3 + SX1262 | 1.75 МБ | ~1.36 МБ (86 КБ) |
| ESP32-C3 без LoRa | 1.75 МБ | ~1.30 МБ (85 КБ) |
| ESP32-S3 + SX1262/SX1278 | 3.125 МБ | ~1.23 МБ (95 КБ) |
| ESP32 (классический) шлюз | 1.75 МБ | ~1.14 МБ (96 КБ) |
| ESP32 (классический) носимый | 1.75 МБ | ~1.76 МБ (109 КБ) |
| ESP32-C6 + SX1262 | 1.75 МБ | ~1.52 МБ (92 КБ) |
| ESP32-C6 без LoRa | 1.75 МБ | ~1.46 МБ (91 КБ) |

RadioLib содержит только SX126x и SX127x; BLE включается только у носимых
узлов, MQTT/TLS — только у шлюзов. Поддерживаются таблицы разделов
\`klinto_4mb_ota.csv\` и \`klinto_8mb_ota.csv\`.

**Дельта-OTA:** шлюз скачивает подписанный манифест и патч KLDP1 с Hub
(\`/v1/kmesh/v1/ota/latest\`), затем раздаёт чанки по 180 байт соседям
окнами по 32. Потерянные чанки досылаются по \`OTA_NACK\` (битовая маска).
Чанки идут فقط в свободный эфир с приоритетом \`PRIORITY_OTA_IDLE\`.
Патч проверяется по SHA-256 и подписи ECDSA P-256, образ — по SHA-256;
\`build_number\` защищает от отката. Подтверждение OTA-образа —
через 30 секунд стабильной работы.

**Телеметрия версий:** каждый \`NODE_PRESENCE\` несёт +7 байт
(\`fw_build\`, \`chip_arch\`, \`node_role\`, \`radio_caps\`, \`ota_state\`,
\`battery_pct\`). Hub складывает их в \`kmesh_nodes_telemetry\`;
админ-эндпоинт \`GET /v1/kmesh/v1/admin/nodes/status\` показывает, сколько
узлов на актуальной прошивке, сколько обновляется и какие отстали.

`;
text = text.replace(insertBefore, section + insertBefore);
writeFileSync(path, text, 'utf8');
console.log('readme updated');
