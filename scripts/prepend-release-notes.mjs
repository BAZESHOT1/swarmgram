import { readFileSync, writeFileSync } from 'node:fs';
const path = 'RELEASE_NOTES_KMESH_V1.md';
let text = readFileSync(path, 'utf8');
const marker = '# Klinto 1.7.0';
if (text.startsWith(marker)) {
  console.log('already present');
  process.exit(0);
}
const section = `# Klinto 1.7.0 — компактная прошивка, радио-OTA и телеметрия

Дата: 14 ноября 2026 года. Прошивка модулей: **1.3** (build 130). Hub: **1.3.0**.

## Главное

- Компактная сборка: только SX126x/SX127x в RadioLib, BLE — у носимых,
  MQTT/TLS — у шлюзов. Все сборки укладываются в OTA-слот 1.75 МБ.
- Таблицы \`klinto_4mb_ota.csv\` и \`klinto_8mb_ota.csv\` с двумя OTA-слотами.
- Каскадная радио-OTA на дельта-патчах KLDP1: шлюз скачивает патч с Hub,
  раздаёт чанки окнами по 32, потерянные досылаются по \`OTA_NACK\`.
- Подпись манифеста ECDSA P-256, SHA-256 патча/образа, монотонный
  \`build_number\`, подтверждение образа через 30 секунд.
- \`NODE_PRESENCE\` +7 байт телеметрии; Hub хранит \`kmesh_nodes_telemetry\`
  и отдаёт \`GET /v1/kmesh/v1/admin/nodes/status\`.

## Проверка

| Проверка | Результат |
| --- | --- |
| Host C++ | 611 проверок, 0 ошибок |
| Матрица 10 сборок (ESP32/C3/S3/C6, LoRa/no-LoRa) | SUCCESS |
| Hub OTA delta test | 5.8 КБ на 120 КБ (4.8%) |
| Client / Hub \`tsc\` | OK |
| Hub 1.3.0 + миграция 038 | применена |

---

`;
text = section + text;
writeFileSync(path, text, 'utf8');
console.log('release notes updated');
