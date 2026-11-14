// Генерация ключа подписи OTA для разработчика.
// Приватный ключ остаётся локально и на сервере, публичный вшивается в прошивку.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = publicKey.export({ type: 'spki', format: 'der' });
// SPKI для P-256: 26-байтный заголовок, далее 64 байта X||Y.
const pub = spki.subarray(26).toString('hex');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

fs.writeFileSync(path.join(root, 'firmware/klinto_core/ota_signing_key.pem'), pem);
fs.writeFileSync(
  path.join(root, 'firmware/klinto_core/include/klinto_ota_pubkey.h'),
  `/**
 * Klinto KMesh_v1 — публичный ключ разработчика для проверки OTA-манифестов.
 *
 * Кривая P-256, несжатая точка 64 байта (X||Y) в hex.
 * Приватный ключ хранится только на сервере (OTA_SIGNING_KEY) и не коммитится.
 */
#ifndef KLINTO_OTA_PUBKEY_H
#define KLINTO_OTA_PUBKEY_H

#define KL_OTA_PUBKEY_HEX "${pub}"

#endif  // KLINTO_OTA_PUBKEY_H
`,
);
console.log(`pubkey=${pub}`);
console.log('private key: firmware/klinto_core/ota_signing_key.pem');
