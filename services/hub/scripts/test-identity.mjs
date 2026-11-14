// Проверка постоянной идентичности users.id, MAC и токена передачи модуля.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { moduleMod6, normalizeModuleMac, userNetIdentityFromUuid } from '../dist/meshId.js';
import { issueOwnerClaim, ownerClaimCanonical } from '../dist/ota.js';

const uuid = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const a = userNetIdentityFromUuid(uuid);
const b = userNetIdentityFromUuid(uuid.toUpperCase());
assert.deepEqual(a, b);
assert.match(a.blePrefix, /^[0-9a-f]{8}$/);
assert.ok(a.netId !== 0 && a.netId !== 1 && a.netId !== 0xffffffff);
assert.notEqual(userNetIdentityFromUuid('11111111-1111-4111-8111-111111111111').netId, a.netId);

const mac = normalizeModuleMac('24:6F:28:AB:CD:EF');
assert.equal(mac, '24:6f:28:ab:cd:ef');
assert.equal(moduleMod6(mac), 'abcdef');
assert.equal(normalizeModuleMac('bad'), null);

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.OTA_SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
const token = issueOwnerClaim('abcdef', a.blePrefix, a.netId, 1710000000);
assert.ok(token);
const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
assert.equal(decoded.prefix, a.blePrefix);
assert.equal(decoded.netId, a.netId);
assert.equal(decoded.epoch, 1710000000);
assert.ok(verify(
  'sha256',
  Buffer.from(ownerClaimCanonical('abcdef', a.blePrefix, a.netId, 1710000000), 'utf8'),
  publicKey,
  Buffer.from(decoded.signature, 'hex'),
));

// Ограничение проекта: миграция не меняет таблицу users.
const sql = readFileSync(new URL('../sql/039_user_identity_modules.sql', import.meta.url), 'utf8');
assert.ok(!/ALTER\s+TABLE\s+users\b/i.test(sql), 'users must stay untouched');
assert.ok(sql.includes('user_net_identities'));
assert.ok(sql.includes('user_modules'));
assert.ok(sql.includes('module_transfer_contracts'));

console.log('User identity and module transfer contract test: OK');
