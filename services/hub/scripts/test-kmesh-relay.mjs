/**
 * Интеграционный тест Hub-плеча KMesh_v1.
 *
 * Прогоняет реальный бинарный MeshPacket через REST-релей шлюза и проверяет,
 * что в downlink вернулся ACK с тем же packet_id:
 *
 *   упаковка пакета -> CRC16 -> POST /relay -> kmesh_v1_archive ->
 *   POST /downlink -> ACK для носимого модуля.
 *
 * Запуск:
 *   HUB_URL=https://... TEMP_MESH_KEY=<64 hex> npm run test:kmesh-relay
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const HUB = (process.env.HUB_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const KEY = (process.env.TEMP_MESH_KEY || '').trim().toLowerCase();
if (!/^[0-9a-f]{64}$/.test(KEY)) {
  console.error('Нужен TEMP_MESH_KEY (64 hex) в окружении.');
  process.exit(2);
}

function crc16(buf) {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function buildPacket({ packetId, msgUuid, src, dst, type = 1, flags = 0x22, payload }) {
  const body = Buffer.alloc(35 + payload.length);
  body[0] = 0xa7;
  body[1] = 3;
  body.writeUInt32LE(packetId >>> 0, 2);
  msgUuid.copy(body, 6);
  body.writeUInt32LE(src >>> 0, 14);
  body.writeUInt32LE(dst >>> 0, 18);
  body.writeUInt32LE(0xffffffff, 22);
  body.writeUInt32LE(0, 26);
  body[30] = type;
  body[31] = flags;
  body[32] = 7;
  body[33] = 0;
  body[34] = payload.length;
  payload.copy(body, 35);
  const out = Buffer.alloc(body.length + 2);
  body.copy(out, 0);
  out.writeUInt16LE(crc16(body), body.length);
  return out;
}

async function call(path, init = {}) {
  const res = await fetch(`${HUB}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-kmesh-key': KEY,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не JSON — печатаем как есть */
  }
  return { status: res.status, json, text };
}

const gatewayId = 900000000 + (Date.now() % 90000000);
const nodeId = 100000000 + (Date.now() % 90000000);
const packetId = (Date.now() % 0xffffffff) >>> 0;
const msgUuid = randomBytes(8);
const payload = Buffer.from('KMESH-TEST-PAYLOAD', 'utf8');
const packet = buildPacket({ packetId, msgUuid, src: nodeId, dst: gatewayId, payload });

const uuidHex = Buffer.from([...msgUuid].reverse()).toString('hex');
const archive = await call('/v1/kmesh/v1/relay?kind=archive', {
  method: 'POST',
  body: JSON.stringify({
    v: 3,
    kind: 'archive',
    gateway_id: gatewayId,
    msg_uuid: uuidHex,
    packet_id: packetId,
    src_id: nodeId,
    dst_id: gatewayId,
    type: 1,
    flags: 0x22,
    ttl: 7,
    hop_count: 0,
    rssi: -45,
    iface: 1,
    need_cloud_archive: true,
    packet_b64: packet.toString('base64'),
  }),
});
assert.equal(archive.status, 200, `relay archive: ${archive.status} ${archive.text}`);
assert.equal(archive.json?.ok, true);
assert.equal(archive.json?.status, 200);

const presence = await call('/v1/kmesh/v1/relay?kind=presence', {
  method: 'POST',
  body: JSON.stringify({
    v: 3,
    kind: 'presence',
    gateway_id: gatewayId,
    node_id: nodeId,
    rssi: -45,
    hops: 1,
    iface: 1,
    battery: 88,
    role: 0,
    ts: Date.now(),
  }),
});
assert.equal(presence.status, 200, `relay presence: ${presence.status} ${presence.text}`);

const down = await call(`/v1/kmesh/v1/downlink?gateway_id=${gatewayId}&since=0`);
assert.equal(down.status, 200, `downlink: ${down.status} ${down.text}`);
const ack = (down.json?.items ?? []).find(
  (item) => item.kind === 'ack' && item.dst_node_id === nodeId && item.packet_id === packetId,
);
assert.ok(ack, `в downlink нет ACK для packet_id=${packetId}: ${down.text}`);

const again = await call(`/v1/kmesh/v1/downlink?gateway_id=${gatewayId}&since=0`);
assert.equal(again.status, 200);
const repeated = (again.json?.items ?? []).some(
  (item) => item.kind === 'ack' && item.packet_id === packetId,
);
assert.equal(repeated, false, 'ACK не должен выдаваться повторно после доставки');

console.log('KMesh_v1 Hub relay/downlink: OK');
console.log(`  gateway=${gatewayId} node=${nodeId} packet_id=${packetId}`);
console.log(`  packet=${packet.length}B crc=0x${crc16(packet.subarray(0, packet.length - 2)).toString(16)}`);
