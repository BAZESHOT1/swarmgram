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
import {
  encodeSearchRequest,
  decodeSearchResponse,
  encodeFeedRequest,
  decodeFeedResponse,
  encodeHistoryRequest,
  decodeHistoryResponse,
  encodeInetStatus,
  RpcOp,
} from '../src/kmesh/v1/protocol';

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

/* Сервисные RPC KMesh_v1 */
const searchReq = encodeSearchRequest(7, 1, 'алиса');
assert.strictEqual(searchReq[0], RpcOp.SEARCH_REQ);
assert.strictEqual(searchReq[4] | (searchReq[5] << 8), 7);
assert.strictEqual(new TextDecoder().decode(searchReq.subarray(8)), 'алиса');

const searchResp = new Uint8Array(4 + 3 + 6 + 5);
searchResp[0] = RpcOp.SEARCH_RESP;
searchResp[2] = 0x07;
searchResp[4] = 0x07;
searchResp[6] = 1;
new DataView(searchResp.buffer).setUint32(7, 4242, true);
searchResp[11] = 1;
searchResp[12] = 5;
searchResp.set(new TextEncoder().encode('alice'), 13);
const sdec = decodeSearchResponse(searchResp);
assert.ok(sdec);
assert.strictEqual(sdec!.results[0].entityId, 4242);
assert.strictEqual(sdec!.results[0].name, 'alice');

const feedReq = encodeFeedRequest(1700000000);
assert.strictEqual(feedReq[0], RpcOp.FEED_SYNC_REQ);
assert.strictEqual(new DataView(feedReq.buffer).getUint32(4, true), 1700000000);

const feedResp = new Uint8Array(5 + 17 + 9);
feedResp[0] = RpcOp.FEED_SYNC_RESP;
feedResp[4] = 1;
const fv = new DataView(feedResp.buffer);
fv.setUint16(5, 3, true);
fv.setUint16(7, 2, true);
fv.setBigUint64(9, 0x1122334455667788n, true);
fv.setUint32(17, 1700000100, true);
feedResp[21] = 8;
feedResp.set(new TextEncoder().encode('прив'), 22);
const fdec = decodeFeedResponse(feedResp);
assert.ok(fdec);
assert.strictEqual(fdec!.entries[0].unreadCount, 2);
assert.strictEqual(fdec!.entries[0].preview, 'прив');

const histReq = encodeHistoryRequest(5, 0xABCn, 5);
assert.strictEqual(histReq[0], RpcOp.CHAT_HISTORY_REQ);
assert.strictEqual(new DataView(histReq.buffer).getBigUint64(4, true), 0xABCn);

const histResp = new Uint8Array(5 + 17 + 4);
histResp[0] = RpcOp.CHAT_HISTORY_RESP;
histResp[4] = 1;
const hv = new DataView(histResp.buffer);
hv.setBigUint64(5, 0x1122334455667788n, true);
hv.setUint32(13, 42, true);
hv.setUint32(17, 1700000200, true);
histResp[21] = 2;
histResp.set(new TextEncoder().encode('ok'), 22);
const hdec = decodeHistoryResponse(histResp);
assert.ok(hdec);
assert.strictEqual(hdec!.messages[0].senderId, 42);
assert.strictEqual(hdec!.messages[0].text, 'ok');

const inet = encodeInetStatus(true, 120, true);
assert.deepStrictEqual(Array.from(inet), [1, 120, 0, 1]);

console.log('KMesh_v1 client codec: OK');