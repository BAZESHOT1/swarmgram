import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
const pem = readFileSync('firmware/klinto_core/ota_signing_key.pem', 'utf8');
const pub = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' }).subarray(26).toString('hex');
const header = readFileSync('firmware/klinto_core/include/klinto_ota_pubkey.h', 'utf8');
const match = /KL_OTA_PUBKEY_HEX\s+"([0-9a-f]+)"/.exec(header);
console.log(pub === match?.[1] ? 'OTA keypair: OK' : 'OTA keypair: MISMATCH');
