import { appendFileSync, readFileSync } from 'node:fs';
const path = '.env.example';
const text = readFileSync(path, 'utf8');
if (!text.includes('OTA_SIGNING_KEY=')) {
  appendFileSync(path, `\n# Приватный ключ ECDSA P-256 для подписи OTA-манифестов (base64 PEM).\n# Публичная часть вшита в прошивку: firmware/klinto_core/include/klinto_ota_pubkey.h\nOTA_SIGNING_KEY=\n`, 'utf8');
  console.log('updated');
} else {
  console.log('already present');
}
