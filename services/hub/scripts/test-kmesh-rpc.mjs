/**
 * Юнит-тест серверного KMesh_v1: пакет, CRC, крипто-конверт и RPC-кодеки.
 * Запуск: npm run build && node scripts/test-kmesh-rpc.mjs
 */
import assert from 'node:assert/strict';
import {
  buildPacket, parsePacket, sealTemp, openTemp, crc16,
  encodeSearchResponse, encodeFeedResponse, encodeHistoryResponse,
  decodeSearchRequest, decodeFeedRequest, decodeHistoryRequest,
  rpcPrefix, RpcOp,
} from '../dist/kmeshRpc.js';

const KEY = '11'.repeat(32);
const packetId = 0x12345678;
const msgUuid = 0x0102030405060708n;
const srcId = 1000;
const dstId = 2000;
const rpc = Buffer.from([RpcOp.SEND_TEXT, 0, 7, 0, 4, 0x68, 0x69, 0x21]);

const sealed = sealTemp(KEY, { packetId, msgUuid, srcId, dstId, type: 1 }, rpc);
assert.ok(sealed);
const wire = buildPacket({
  packetId, msgUuid, srcId, dstId, nextHopId: dstId, type: 1, flags: sealed.flags, payload: sealed.payload,
});
assert.equal(wire[0], 0xa7);
assert.equal(wire[1], 3);
assert.equal(crc16(wire.subarray(0, wire.length - 2)), wire.readUInt16LE(wire.length - 2));

const parsed = parsePacket(wire);
assert.ok(parsed);
assert.equal(parsed.packetId, packetId);
assert.equal(parsed.msgUuid, msgUuid);
assert.equal(parsed.srcId, srcId);
assert.equal(parsed.dstId, dstId);

const opened = openTemp(KEY, parsed);
assert.ok(opened);
assert.deepEqual([...opened], [...rpc]);

const badKey = '22'.repeat(32);
assert.equal(openTemp(badKey, parsed), null);

const searchReq = Buffer.concat([
  Buffer.from([RpcOp.SEARCH_REQ, 0, 7, 0]), Buffer.from([0x34, 0x12, 1, 5]), Buffer.from('alice'),
]);
const search = decodeSearchRequest(searchReq);
assert.ok(search);
assert.equal(search.reqId, 0x1234);
assert.equal(search.type, 1);
assert.equal(search.query, 'alice');

const searchResp = encodeSearchResponse(7, 0x1234, [{ entityId: 42, type: 1, name: 'alice' }]);
assert.equal(searchResp[0], RpcOp.SEARCH_RESP);
assert.equal(searchResp.readUInt16LE(4), 0x1234);
assert.equal(searchResp[6], 1);

const feedReq = Buffer.alloc(8);
feedReq[0] = RpcOp.FEED_SYNC_REQ;
feedReq.writeUInt32LE(1700000000, 4);
assert.equal(decodeFeedRequest(feedReq)?.lastSyncTs, 1700000000);

const feedResp = encodeFeedResponse(7, [
  { chatRef: 7, unreadCount: 3, lastMsgUuid: 0x0a0b0c0d0e0f1011n, timestamp: 1700000000, preview: 'hi' },
]);
assert.equal(feedResp[0], RpcOp.FEED_SYNC_RESP);
assert.equal(feedResp[6], 1);
assert.equal(feedResp.readUInt16LE(7), 7);

const historyReq = Buffer.alloc(13);
historyReq[0] = RpcOp.CHAT_HISTORY_REQ;
historyReq[12] = 5;
assert.equal(decodeHistoryRequest(historyReq)?.limit, 5);

const historyResp = encodeHistoryResponse(7, [
  { msgUuid: 1n, senderId: 1000, timestamp: 1700000000, text: 'hi' },
]);
assert.equal(historyResp[0], RpcOp.CHAT_HISTORY_RESP);
assert.equal(historyResp[4], 1);

assert.equal(rpcPrefix(Buffer.from([1, 0, 7, 0]))?.op, RpcOp.SEND_TEXT);
console.log('KMesh_v1 Hub RPC/крипто: OK');
