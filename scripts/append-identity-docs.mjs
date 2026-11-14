import { readFileSync, writeFileSync } from 'node:fs';

const readme = 'README.md';
let text = readFileSync(readme, 'utf8');
const marker = '## Идентичность пользователя и передача модуля';
if (!text.includes(marker)) {
  const section = `## Идентичность пользователя и передача модуля

- Постоянный идентификатор — \`users.id\` (UUID). Для радиоэфира из него
  детерминированно вычисляется \`user_net_id\` (первые 4 байта SHA-256,
  зарезервированные значения пропускаются) и \`ble_prefix\` (8 hex).
- Таблица \`users\` **не меняется**; идентичность хранится в
  \`user_net_identities\`, владение модулями — в \`user_modules\`.
- BLE-имя модуля: **\`KL-<USER8>-<MOD6>\`**. \`USER8\` — префикс владельца,
  \`MOD6\` — последние 6 hex MAC. Свободный модуль: \`KL-00000000-<MOD6>\`.
- Приложение кэширует свой \`user_id\`/\`ble_prefix\` и в оффлайне
  автоподключается только к своим модулям. Свободный модуль привязывается
  вручную; чужой — только по контракту передачи.
- Передача модуля: \`/v1/kmesh/v1/modules/transfer/*\`, статусы
  \`pending/accepted/rejected/cancelled\`, подписанный \`claim_token\` и
  команда \`BRIDGE_CMD_SET_OWNER\` (ECDSA P-256, защита от повторного
  использования по \`owner_epoch\`).
- После подтверждения \`claim_token\` кладётся в локальную
  \`pending_ble_claims\`; при первом появлении модуля приложение
  подключается, переименовывает его в \`KL-<NEW_USER8>-<MOD6>\` и удаляет
  запись.

`;
  text = text.replace('## Документация', section + '## Документация');
  writeFileSync(readme, text, 'utf8');
}

const arch = 'ARCHITECTURE_AND_PROTOCOL.md';
let doc = readFileSync(arch, 'utf8');
const archMarker = '## 14. Постоянная идентичность users.id и передача модулей';
if (!doc.includes(archMarker)) {
  doc += `
---

## 14. Постоянная идентичность users.id и передача модулей

### 14.1 user_net_id и ble_prefix

Сервер не меняет \`users\`: рядом создаётся \`user_net_identities\`
(\`user_id uuid PK\`, \`net_id bigint UNIQUE\`, \`ble_prefix char(8)\`).
\`net_id\` — первые 4 байта SHA-256 от UUID, \`ble_prefix\` — те же 4 байта
в hex. Значения \`0\`, \`1\` и \`0xFFFFFFFF\` зарезервированы.

\`NODE_PRESENCE\` теперь несёт \`owner_net_id u32\` после телеметрии
(+4 байта). Шлюз публикует его в JSON \`owner_net_id\`, Hub сохраняет
в \`kmesh_nodes_telemetry.owner_net_id\`.

### 14.2 BLE-имя и владение

Имя \`KL-<USER8>-<MOD6>\` (18 символов + NUL) однозначно определяет
владельца и конкретный модуль. \`MOD6\` берётся из последних 3 байт MAC.
Несколько модулей одного пользователя различаются суффиксом \`MOD6\`.

Владелец хранится в NVS: \`owner_ble_prefix\`, \`owner_net\`, \`owner_epoch\`.
Смена владельца выполняется кадром \`SET_OWNER\` (14):
\`prefix(8) net_id(4) epoch(4) sig_len(1) DER-подпись\`. Подпись проверяется
вшитым публичным ключом разработчика; \`epoch\` защищает от повторного
использования старого токена.

### 14.3 Контракт передачи

\`module_transfer_contracts\`: \`pending -> accepted | rejected | cancelled\`.
Старый владелец подтверждает или отклоняет заявку; новый может отменить
до решения. При \`accepted\` в транзакции меняется \`user_modules.owner_user_id\`,
\`modules.owner_id\`, увеличивается \`token_version\`, генерируется
\`claim_token\`, а обе стороны получают системные и Push-уведомления.
Клиент хранит старые BLE-имена в \`pending_ble_claims\` и переименовывает
модуль при первом обнаружении.
`;
  writeFileSync(arch, doc, 'utf8');
}
console.log('identity docs updated');
