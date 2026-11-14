/**
 * KMesh_v1 на стороне Hub: разбор/сборка бинарных пакетов, крипто-конверт
 * временного ключа и RPC поиска/ленты/истории.
 *
 * Формат полностью повторяет firmware/klinto_core:
 *   MeshPacket: a7 03 | packet_id u32 | msg_uuid u64 | src | dst | next | last |
 *               type | flags | ttl | hop | payload_len | payload | crc16
 *   Крипто:     [alg=1][tag_len=4][ciphertext][tag 4]
 */
import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';

export const PACKET_HEADER_SIZE = 35;
export const MAX_PACKET_SIZE = 256;
export const BROADCAST_ID = 0xffffffff;
export const ANY_GATEWAY_ID = 1;
export const TEMP_TAG_LEN = 4;
export const CRYPTO_HDR_LEN = 2;
export const FLAG_TEMP_MESH_KEY = 0x08;

export function crc16(buf: Buffer): number {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

function writeU64LE(buf: Buffer, offset: number, value: bigint): void {
  buf.writeBigUInt64LE(BigInt.asUintN(64, value), offset);
}

export interface MeshPacketInput {
  packetId: number;
  msgUuid: bigint;
  srcId: number;
  dstId: number;
  type: number;
  flags: number;
  ttl?: number;
  hopCount?: number;
  nextHopId?: number;
  payload: Buffer;
}

export function buildPacket(packet: MeshPacketInput): Buffer {
  const out = Buffer.alloc(PACKET_HEADER_SIZE + packet.payload.length + 2);
  out[0] = 0xa7;
  out[1] = 3;
  out.writeUInt32LE(packet.packetId >>> 0, 2);
  writeU64LE(out, 6, packet.msgUuid);
  out.writeUInt32LE(packet.srcId >>> 0, 14);
  out.writeUInt32LE(packet.dstId >>> 0, 18);
  out.writeUInt32LE((packet.nextHopId ?? BROADCAST_ID) >>> 0, 22);
  out.writeUInt32LE(0, 26);
  out[30] = packet.type & 0xff;
  out[31] = packet.flags & 0xff;
  out[32] = packet.ttl ?? 7;
  out[33] = packet.hopCount ?? 0;
  out[34] = packet.payload.length;
  packet.payload.copy(out, PACKET_HEADER_SIZE);
  out.writeUInt16LE(crc16(out.subarray(0, PACKET_HEADER_SIZE + packet.payload.length)),
    PACKET_HEADER_SIZE + packet.payload.length);
  return out;
}

export interface ParsedPacket {
  packetId: number;
  msgUuid: bigint;
  srcId: number;
  dstId: number;
  type: number;
  flags: number;
  payload: Buffer;
}

export function parsePacket(data: Buffer): ParsedPacket | null {
  if (data.length < PACKET_HEADER_SIZE + 2) return null;
  if (data[0] !== 0xa7 || data[1] !== 3) return null;
  const len = data[34];
  if (data.length < PACKET_HEADER_SIZE + len + 2) return null;
  const expected = data.readUInt16LE(PACKET_HEADER_SIZE + len);
  if (crc16(data.subarray(0, PACKET_HEADER_SIZE + len)) !== expected) return null;
  return {
    packetId: data.readUInt32LE(2),
    msgUuid: data.readBigUInt64LE(6),
    srcId: data.readUInt32LE(14),
    dstId: data.readUInt32LE(18),
    type: data[30],
    flags: data[31],
    payload: data.subarray(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + len),
  };
}

export function msgUuidHex(uuid: bigint): string {
  return BigInt.asUintN(64, uuid).toString(16).padStart(16, '0');
}

function keys(keyHex: string): { enc: Buffer; mac: Buffer } {
  const key = Buffer.from(keyHex, 'hex');
  return {
    enc: createHmac('sha256', key).update('KLINTO-KMESH1-ENC').digest(),
    mac: createHmac('sha256', key).update('KLINTO-KMESH1-MAC').digest(),
  };
}

function aadBuffer(aad: {
  packetId: number; msgUuid: bigint; srcId: number; dstId: number;
  type: number; flags: number; payloadLen: number;
}): Buffer {
  const out = Buffer.alloc(24);
  out[0] = 0x01;
  out.writeUInt32LE(aad.packetId >>> 0, 1);
  writeU64LE(out, 5, aad.msgUuid);
  out.writeUInt32LE(aad.dstId >>> 0, 13);
  out.writeUInt32LE(aad.srcId >>> 0, 17);
  out[21] = aad.type & 0xff;
  out[22] = aad.flags & 0xff;
  out[23] = aad.payloadLen & 0xff;
  return out;
}

export function sealTemp(keyHex: string, packet: Omit<MeshPacketInput, 'payload' | 'flags'>,
                         plain: Buffer): { payload: Buffer; flags: number } | null {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) return null;
  const flags = FLAG_TEMP_MESH_KEY;
  const payloadLen = CRYPTO_HDR_LEN + plain.length + TEMP_TAG_LEN;
  if (payloadLen > 255) return null;
  const { enc, mac } = keys(keyHex);
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32LE(packet.packetId >>> 0, 0);
  nonce.writeUInt32LE(packet.srcId >>> 0, 4);
  nonce.writeUInt32LE(Number(packet.msgUuid & 0xffffffffn), 8);
  const iv = Buffer.alloc(16);
  iv.writeUInt32LE(1, 0);
  nonce.copy(iv, 4);
  const cipher = createCipheriv('chacha20', enc, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const aad = aadBuffer({ ...packet, flags, payloadLen });
  const tag = createHmac('sha256', mac)
    .update(createHash('sha256').update(Buffer.concat([aad, ciphertext])).digest())
    .digest()
    .subarray(0, TEMP_TAG_LEN);
  return {
    payload: Buffer.concat([Buffer.from([1, TEMP_TAG_LEN]), ciphertext, tag]),
    flags,
  };
}

export function openTemp(keyHex: string, packet: ParsedPacket): Buffer | null {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) return null;
  const payload = packet.payload;
  if (payload.length < CRYPTO_HDR_LEN + TEMP_TAG_LEN) return null;
  if (payload[0] !== 1 || payload[1] !== TEMP_TAG_LEN) return null;
  const ciphertext = payload.subarray(CRYPTO_HDR_LEN, payload.length - TEMP_TAG_LEN);
  const tag = payload.subarray(payload.length - TEMP_TAG_LEN);
  const { enc, mac } = keys(keyHex);
  const aad = aadBuffer({
    packetId: packet.packetId,
    msgUuid: packet.msgUuid,
    srcId: packet.srcId,
    dstId: packet.dstId,
    type: packet.type,
    flags: packet.flags,
    payloadLen: payload.length,
  });
  const expected = createHmac('sha256', mac)
    .update(createHash('sha256').update(Buffer.concat([aad, ciphertext])).digest())
    .digest()
    .subarray(0, TEMP_TAG_LEN);
  if (!expected.equals(tag)) return null;
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32LE(packet.packetId >>> 0, 0);
  nonce.writeUInt32LE(packet.srcId >>> 0, 4);
  nonce.writeUInt32LE(Number(packet.msgUuid & 0xffffffffn), 8);
  const iv = Buffer.alloc(16);
  iv.writeUInt32LE(1, 0);
  nonce.copy(iv, 4);
  const decipher = createDecipheriv('chacha20', enc, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/* ------------------------------------------------------------ RPC ------- */

export const RpcOp = {
  SEND_TEXT: 0x01,
  MSG_ACK: 0x02,
  SYNC_REQUEST: 0x05,
  SEARCH_REQ: 0x08,
  SEARCH_RESP: 0x09,
  FEED_SYNC_REQ: 0x0a,
  FEED_SYNC_RESP: 0x0b,
  CHAT_HISTORY_REQ: 0x0c,
  CHAT_HISTORY_RESP: 0x0d,
} as const;

export const RPC_FLAG_MORE = 0x40;

export interface RpcPrefix {
  op: number;
  flags: number;
  chatRef: number;
}

export function rpcPrefix(payload: Buffer): RpcPrefix | null {
  if (payload.length < 4) return null;
  return { op: payload[0], flags: payload[1], chatRef: payload.readUInt16LE(2) };
}

function putText(text: string, cap = 127): Buffer {
  const bytes = Buffer.from(text, 'utf8').subarray(0, Math.min(cap, 127));
  return Buffer.concat([Buffer.from([bytes.length & 0x7f]), bytes]);
}

function readText(data: Buffer, offset: number): { text: string; next: number } {
  if (offset >= data.length) return { text: '', next: data.length };
  const len = data[offset] & 0x7f;
  const start = offset + 1;
  const end = Math.min(data.length, start + len);
  return { text: data.subarray(start, end).toString('utf8'), next: end };
}

export interface SearchItem { entityId: number; type: number; name: string }
export interface FeedItem {
  chatRef: number; unreadCount: number; lastMsgUuid: bigint; timestamp: number; preview: string;
}
export interface HistoryItem { msgUuid: bigint; senderId: number; timestamp: number; text: string }

export function encodeSearchResponse(chatRef: number, reqId: number, items: SearchItem[],
                                     more = false): Buffer {
  const parts: Buffer[] = [Buffer.from([RpcOp.SEARCH_RESP, more ? RPC_FLAG_MORE : 0])];
  const head = Buffer.alloc(4);
  head.writeUInt16LE(chatRef & 0xffff, 0);
  head.writeUInt16LE(reqId & 0xffff, 2);
  parts.push(head);
  const count = Math.min(items.length, 5);
  parts.push(Buffer.from([count]));
  for (let i = 0; i < count; i += 1) {
    const item = items[i];
    const meta = Buffer.alloc(5);
    meta.writeUInt32LE(item.entityId >>> 0, 0);
    meta[4] = item.type & 0xff;
    parts.push(meta, putText(item.name, 40));
  }
  return Buffer.concat(parts);
}

export function encodeFeedResponse(chatRef: number, items: FeedItem[], more = false): Buffer {
  const parts: Buffer[] = [Buffer.from([RpcOp.FEED_SYNC_RESP, more ? RPC_FLAG_MORE : 0])];
  const head = Buffer.alloc(2);
  head.writeUInt16LE(chatRef & 0xffff, 0);
  parts.push(head);
  const count = Math.min(items.length, 5);
  // Как в прошивке: два нулевых байта, затем count (payload[6]), записи с 7.
  parts.push(Buffer.from([0, 0, count]));
  for (let i = 0; i < count; i += 1) {
    const item = items[i];
    const meta = Buffer.alloc(16);
    meta.writeUInt16LE(item.chatRef & 0xffff, 0);
    meta.writeUInt16LE(item.unreadCount & 0xffff, 2);
    writeU64LE(meta, 4, item.lastMsgUuid);
    meta.writeUInt32LE(item.timestamp >>> 0, 12);
    parts.push(meta, putText(item.preview, 48));
  }
  return Buffer.concat(parts);
}

export function encodeHistoryResponse(chatRef: number, items: HistoryItem[], more = false): Buffer {
  const parts: Buffer[] = [Buffer.from([RpcOp.CHAT_HISTORY_RESP, more ? RPC_FLAG_MORE : 0])];
  const head = Buffer.alloc(2);
  head.writeUInt16LE(chatRef & 0xffff, 0);
  parts.push(head);
  const count = Math.min(items.length, 8);
  parts.push(Buffer.from([count]));
  for (let i = 0; i < count; i += 1) {
    const item = items[i];
    const meta = Buffer.alloc(16);
    writeU64LE(meta, 0, item.msgUuid);
    meta.writeUInt32LE(item.senderId >>> 0, 8);
    meta.writeUInt32LE(item.timestamp >>> 0, 12);
    parts.push(meta, putText(item.text, 72));
  }
  return Buffer.concat(parts);
}

export function decodeSearchRequest(payload: Buffer): { reqId: number; type: number; query: string } | null {
  if (payload.length < 8) return null;
  return { reqId: payload.readUInt16LE(4), type: payload[6], query: readText(payload, 7).text };
}

export function decodeFeedRequest(payload: Buffer): { lastSyncTs: number } | null {
  if (payload.length < 8) return null;
  return { lastSyncTs: payload.readUInt32LE(4) };
}

export function decodeHistoryRequest(payload: Buffer): { beforeUuid: bigint; limit: number } | null {
  if (payload.length < 13) return null;
  return { beforeUuid: payload.readBigUInt64LE(4), limit: payload[12] };
}

export function decodeTextRpc(payload: Buffer): { chatRef: number; text: string } | null {
  const prefix = rpcPrefix(payload);
  if (!prefix || prefix.op !== RpcOp.SEND_TEXT) return null;
  return { chatRef: prefix.chatRef, text: readText(payload, 4).text };
}
