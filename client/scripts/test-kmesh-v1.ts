/**
 * Host-тест клиентского кодека и криптографии KMesh_v1.
 * Запуск: npm run test:kmesh-v1 (через esbuild, без лишних зависимостей).
 */
import assert from 'node:assert';
import {
  encodeMeshPacket,
  decodeMeshPacket,
  encodeRpcText,
  decodeRpc,
  encodeClientFrame,
  ClientFrameDecoder,
  ClientFrameType,
  crc16,
  PACKET_HEADER_SIZE,
  CLIENT_FLAG_FRAGMENT,
  CLIENT_HEADER_SIZE,
  CLIENT_VERSION,
  CLIENT_MAGIC,
} from '../src/kmesh/v1/protocol';
import { sealMesh, permanentDigest, openMesh } from '../src/kmesh/v1/crypto';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const key = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
const plain = new TextEncoder().encode('hello mesh v3');
const aad = {
  packetId: 0x01020304,
  msgUuid: 0x1122334455667788n,
  srcId: 11,
  dstId: 22,
  type: 1,
  flags: 0x29,
  payloadLen: 19,
};

const sealed = sealMesh(key, aad, plain, 4);
assert.strictEqual(hex(sealed), '0104d0148ce5eaae010e92b4272bb15d69cd9e', 'C/TS seal vector mismatch');
assert.deepStrictEqual(Array.from(openMesh(key, aad, sealed) ?? []), Array.from(plain));

const tampered = sealed.slice();
tampered[tampered.length - 1] ^= 1;
assert.strictEqual(openMesh(key, aad, tampered), null, 'tamper must fail');

const digest = permanentDigest({
  msgUuid: '1122334455667788',
  senderNodeId: 11,
  receiverNodeId: 22,
  timestamp: 1700000000000,
  ciphertext: plain,
});
assert.strictEqual(hex(digest), 'c2fc93b115c666b0f2f2a4c620a984127e97c1a9fa2e0df6cf913989e1873db2', 'perm digest mismatch');

/* Packet round-trip */
const rpc = encodeRpcText(42, 'РїСЂРёРІРµС‚ mesh');
const packet = {
  packetId: 0xdeadbeef,
  msgUuid: 0x1122334455667788n,
  srcId: 11,
  dstId: 22,
  nextHopId: 0xffffffff,
  lastHopId: 0,
  type: 1,
  flags: 0x29,
  ttl: 7,
  hopCount: 0,
  payload: rpc,
};
const wire = encodeMeshPacket(packet);
assert.strictEqual(wire.length, PACKET_HEADER_SIZE + rpc.length + 2);
const parsed = decodeMeshPacket(wire);
assert.ok(parsed);
assert.strictEqual(parsed!.msgUuid, packet.msgUuid);
assert.strictEqual(parsed!.srcId, 11);
const decodedRpc = decodeRpc(parsed!.payload);
assert.ok(decodedRpc);
assert.strictEqual(decodedRpc!.chatRef, 42);
assert.strictEqual(decodedRpc!.text, 'РїСЂРёРІРµС‚ mesh');
assert.strictEqual(crc16(wire.subarray(0, wire.length - 2)), wire[wire.length - 2] | (wire[wire.length - 1] << 8));

/* Client frame decoder: split one frame into two offset fragments. */
const payload = encodeRpcText(7, 'fragment me');
const whole = encodeClientFrame(ClientFrameType.RPC_DOWN, payload, 5);
const chunkA = whole.slice(0, 20);
const chunkB = whole.slice(20);
const decoder = new ClientFrameDecoder();
const frames = [...decoder.push(chunkA), ...decoder.push(chunkB)];
assert.strictEqual(frames.length, 1);
assert.strictEqual(frames[0].type, ClientFrameType.RPC_DOWN);
assert.deepStrictEqual(Array.from(frames[0].payload), Array.from(payload));

/* Explicit fragmentation at the frame layer. */
function fragFrame(total: Uint8Array, offset: number, chunk: Uint8Array, seq: number): Uint8Array {
  const body = new Uint8Array(6 + chunk.length);
  const view = new DataView(body.buffer);
  view.setUint16(0, 0x1234, true);
  view.setUint16(2, offset, true);
  view.setUint16(4, total.length, true);
  body.set(chunk, 6);
  const frame = new Uint8Array(CLIENT_HEADER_SIZE + body.length + 2);
  const fv = new DataView(frame.buffer);
  frame[0] = CLIENT_MAGIC[0];
  frame[1] = CLIENT_MAGIC[1];
  frame[2] = CLIENT_VERSION;
  frame[3] = ClientFrameType.RPC_DOWN;
  frame[4] = CLIENT_FLAG_FRAGMENT;
  fv.setUint16(5, seq, true);
  fv.setUint16(7, body.length, true);
  frame.set(body, CLIENT_HEADER_SIZE);
  fv.setUint16(CLIENT_HEADER_SIZE + body.length, crc16(frame.subarray(2, CLIENT_HEADER_SIZE + body.length)), true);
  return frame;
}

const d2 = new ClientFrameDecoder();
const f1 = fragFrame(payload, 0, payload.slice(0, 5), 1);
const f2 = fragFrame(payload, 5, payload.slice(5), 2);
assert.strictEqual(d2.push(f1).length, 0);
const reassembled = d2.push(f2);
assert.strictEqual(reassembled.length, 1);
assert.deepStrictEqual(Array.from(reassembled[0].payload), Array.from(payload));

console.log('KMesh_v1 client codec: OK');
