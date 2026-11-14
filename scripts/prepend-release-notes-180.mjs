import { readFileSync, writeFileSync } from 'node:fs';
const path = 'RELEASE_NOTES_KMESH_V1.md';
let text = readFileSync(path, 'utf8');
const marker = '# Klinto 1.8.0';
if (text.startsWith(marker)) {
  console.log('already present');
  process.exit(0);
}
const section = `# Klinto 1.8.0 — идентичность users.id и передача модулей

Дата: 14 ноября 2026 года. Прошивка модулей: **1.4** (build 140). Hub: **1.4.0**.

- Постоянная идентичность \`users.id\` (UUID) без изменения таблицы \`users\`.
- \`user_net_identities\`, \`user_modules\`, \`module_transfer_contracts\`.
- BLE-имя \`KL-<USER8>-<MOD6>\`; оффлайн-правила свой/свободный/чужой.
- \`BRIDGE_CMD_SET_OWNER\` с подписью ECDSA P-256 и \`owner_epoch\`.
- Контракт передачи с уведомлениями, \`claim_token\` и \`pending_ble_claims\`.
- OTA full-image fallback с подписанным манифестом.
- C++: 630 проверок; матрица 4 чипов — SUCCESS; Hub-контракт проверен.

---

`;
text = section + text;
writeFileSync(path, text, 'utf8');
console.log('release notes updated');
