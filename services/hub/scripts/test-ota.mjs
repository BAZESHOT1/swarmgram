// Проверка генератора KLDP1 и совместимости с потоковым патчером прошивки.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { buildDeltaPatch, manifestDigest, manifestCanonical, signManifest } from '../dist/ota.js';

const base = Buffer.alloc(120_000);
for (let i = 0; i < base.length; i += 1) base[i] = (i * 31 + 7) & 0xff;
const target = Buffer.concat([
  base.subarray(0, 40_000),
  Buffer.from('KLINTO-OTA-TEST-INSERT'),
  base.subarray(40_000, 80_000),
  Buffer.alloc(1024, 0x5a),
  base.subarray(80_000),
]);

const delta = buildDeltaPatch(base, target);
assert.ok(delta.patch.length < target.length / 2, 'patch must be compact');
assert.equal(delta.targetSha256.length, 64);

// Минимальный интерпретатор KLDP1 (как в C-патчере).
function apply(baseBuf, patch) {
  assert.equal(patch.subarray(0, 4).toString(), 'KLDP');
  assert.equal(patch[4], 1);
  const baseSize = patch.readUInt32LE(5);
  const targetSize = patch.readUInt32LE(9);
  const expectSha = patch.subarray(13, 45);
  assert.equal(baseSize, baseBuf.length);
  const out = Buffer.alloc(targetSize);
  let op = 45;
  let written = 0;
  for (;;) {
    const code = patch[op++];
    if (code === 0) break;
    if (code === 1) {
      const offset = patch.readUInt32LE(op); op += 4;
      const length = patch.readUInt32LE(op); op += 4;
      baseBuf.copy(out, written, offset, offset + length);
      written += length;
    } else if (code === 2) {
      const length = patch.readUInt16LE(op); op += 2;
      patch.copy(out, written, op, op + length);
      op += length;
      written += length;
    } else {
      throw new Error(`unknown op ${code}`);
    }
  }
  assert.equal(written, targetSize);
  assert.equal(createHash('sha256').update(out).digest('hex'), expectSha.toString('hex'));
  return out;
}

const restored = apply(base, delta.patch);
assert.deepEqual(restored, target);

const m = {
  chip: 'esp32c3',
  baseBuild: 120,
  targetBuild: 130,
  totalChunks: Math.ceil(delta.patch.length / 180),
  patchSize: delta.patch.length,
  patchSha256: delta.patchSha256,
  targetSha256: delta.targetSha256,
};
assert.equal(manifestDigest(m).length, 64);
assert.ok(manifestCanonical(m).startsWith('KLINTO-OTA1|2|120|130|'));

// Подпись манифеста: тот же digest, что проверяет mbedTLS на устройстве.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.OTA_SIGNING_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
const signature = signManifest({ ...m, signature: '', sigAlg: 'ecdsa-p256' });
assert.ok(signature.length > 0);
assert.ok(nodeVerify('sha256', Buffer.from(manifestCanonical(m), 'utf8'), publicKey,
  Buffer.from(signature, 'hex')));
console.log(`OTA delta test: OK (${delta.patch.length} bytes, ${(delta.patch.length / target.length * 100).toFixed(1)}%)`);
