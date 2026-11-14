// Добавляет русские разделы про OTA и телеметрию в ARCHITECTURE_AND_PROTOCOL.md.
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'ARCHITECTURE_AND_PROTOCOL.md';
const text = readFileSync(path, 'utf8');
const marker = '## 13. Каскадная радио-OTA и телеметрия версий';
if (text.includes(marker)) {
  console.log('already present');
  process.exit(0);
}

const extra = `
---

## 13. Каскадная радио-OTA и телеметрия версий

### 13.1 Сжатие прошивки и таблицы разделов

Прошивка 1.3 собирается с \`-Os -ffunction-sections -fdata-sections -fno-rtti
-fno-exceptions -Wl,--gc-sections\`. RadioLib линкует только семейства
**SX126x** и **SX127x**; остальные драйверы и протоколы исключены макросами
\`RADIOLIB_EXCLUDE_*\`. Для сборок без LoRa (\`KL_HAS_LORA=0\`) RadioLib
полностью исключён из линковки. BLE-стек включается только у носимых узлов
(\`KL_HAS_BLE=1\`), MQTT/TLS — только у шлюзов (\`KL_HAS_MQTT=1\`).

| Таблица | app0 | app1 | LittleFS |
| --- | --- | --- | --- |
| \`klinto_4mb_ota.csv\` | 0x10000 / 1.75 МБ | 0x1D0000 / 1.75 МБ | 0x390000 / 448 КБ |
| \`klinto_8mb_ota.csv\` | 0x10000 / 3.125 МБ | 0x330000 / 3.125 МБ | 0x650000 / 1.625 МБ |

\`nvs\` 20 КБ, \`otadata\` 8 КБ. Builder передаёт CSV в arduino-cli через
\`build.partitions\` и возвращает \`flashBytes\`, \`ramBytes\`, \`slotBytes\`,
\`flashPercent\` в ответе \`/build\`.

### 13.2 Формат дельта-патча KLDP1

\`\`\`
"KLDP" | ver u8 | base_size u32 | target_size u32 | target_sha256[32]
0x01 COPY { offset u32, length u32 }
0x02 ADD  { length u16, bytes }
0x00 END
\`\`\`

Генератор в Hub режет образ контентно-зависимым chunking (gear hash,
средний блок ~1 КБ), поэтому сдвиг кода после правки не ломает совпадения
всех последующих блоков. Патч обычно 3–10% от полного образа.
Прошивка применяет патч потоково буфером 4 КБ: читает активный раздел
(\`esp_ota_get_running_partition\`), пишет в неактивный
(\`esp_ota_get_next_update_partition\`).

### 13.3 Пакеты OTA и приоритеты

| type | Пакет | Полезная нагрузка |
| --- | --- | --- |
| 8 | \`OTA_ANNOUNCE\` | \`patch_id u16, chip u8, base u16, target u16, chunks u16, patch_size u32, patch_sha256[32], target_sha256[32], sig_len u8, sig[]\` |
| 9 | \`OTA_CHUNK\` | \`patch_id u16, index u16, len u8, data[≤180]\` |
| 10 | \`OTA_NACK\` | \`patch_id u16, window_start u16, missing_bitmap u32\` |

Чанки и NACK передаются с \`KL_PRIO_OTA_IDLE\` (ниже \`LOW\`): LoRa-драйвер
принимает их только при пустой очереди, ESP-NOW — когда нет pending/ACK.
Раздача идёт окнами по 32 пакета; получатель шлёт NACK с битовой маской
пропусков, источник досылает только потерянное. Носимые узлы с АКБ < 40%
без зарядки откладывают скачивание.

### 13.4 Подпись, анти-откат и защита от «окирпичивания»

- Манифест подписывается ECDSA P-256 ключом разработчика; в прошивку
  вшит публичный ключ \`KL_OTA_PUBKEY\` (\`include/klinto_ota_pubkey.h\`).
- Канонический вид: \`KLINTO-OTA1|chip|base|target|patch_sha|target_sha|chunks|patch_size\`.
- Перед применением проверяются SHA-256 патча и SHA-256 собранного образа.
- \`build_number\` (файл \`firmware/klinto_core/BUILD\`) монотонно растёт;
  устройство и Hub отвергают откат на меньший номер.
- \`esp_ota_set_boot_partition()\` вызывается только после валидной подписи.
- Через 30 секунд стабильной работы runtime вызывает
  \`esp_ota_mark_app_valid_cancel_rollback()\`.
- Если точного патча под текущий \`base_build\` нет, Hub отдаёт полный образ
  (\`full=true\`, \`/v1/kmesh/v1/ota/full/<chip>/<build>\`).

### 13.5 Телеметрия в NODE_PRESENCE (+7 байт)

К штатным 8 байтам присутствия добавлены:

| Смещение | Поле | Смысл |
| --- | --- | --- |
| 8 | \`fw_build u16\` | номер сборки (например 130) |
| 10 | \`chip_arch u8\` | 1 ESP32, 2 C3, 3 S3, 4 C6 |
| 11 | \`node_role u8\` | 0 client, 1 hybrid, 2 router, 3 gateway |
| 12 | \`radio_caps u8\` | биты LoRa/SX1262/SX127x/BLE/Wi-Fi mesh |
| 13 | \`ota_state u8\` | 0 idle, 1 downloading, 2 verifying, 3 pending reboot, 4 failed |
| 14 | \`battery_pct u8\` | 0..100, 255 = внешнее питание |

Шлюзы и мобильные шлюзы не тратят эфир: их присутствие публикуется локально
в uplink. Роутеры шлют NODE_PRESENCE по Trickle раз в 10–30 минут и сразу
после старта/OTA. Hub сохраняет данные в \`kmesh_nodes_telemetry\`.

Административный мониторинг: \`GET /v1/kmesh/v1/admin/nodes/status\`
(\`?outdated_only=true&role=router&chip=esp32c3\`) возвращает сводку
(всего/актуальные/устаревшие/скачивают OTA/распределение по чипам и ролям)
и детальный список узлов.

`;

writeFileSync(path, text + extra, 'utf8');
console.log('architecture updated');
