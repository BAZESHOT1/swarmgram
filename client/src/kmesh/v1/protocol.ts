/**
 * Klinto KMesh_v1 — бинарный протокол (TypeScript-зеркало klinto_core).
 *
 * На радиотракте нет JSON. Телефон собирает RPC и MeshPacket; узел сжимает
 * (Unishox2) и шифрует перед передачей и выполняет обратные операции на
 * приёме, поэтому UI всегда видит прозрачный RPC.
 */

export const PACKET_MAGIC = 0xa7;
export const PACKET_VERSION = 3;
export const PACKET_HEADER_SIZE = 35;
export const MAX_PAYLOAD = 200;
export const MAX_PACKET_SIZE = 256;
export const BROADCAST_ID = 0xffffffff;
export const ANY_GATEWAY_ID = 0x00000001;

export const PacketType = {
  DATA: 1,
  ACK: 2,
  RREQ: 3,
  RREP: 4,
  GW_BEACON: 5,
  NODE_PRESENCE: 6,
  SYNC_ARCHIVE: 7,
} as const;

export const PacketFlag = {
  NEED_ACK: 0x01,
  TO_INTERNET: 0x02,
  FROM_INTERNET: 0x04,
  TEMP_MESH_KEY: 0x08,
  PERM_USER_KEY: 0x10,
  NEED_CLOUD_ARCHIVE: 0x20,
  COMPRESSED_UNISHOX: 0x40,
  SERVER_RESIGN: 0x80,
} as const;

export const RpcOp = {
  SEND_TEXT: 0x01,
  MSG_ACK: 0x02,
  MSG_READ: 0x03,
  LOCATION_PING: 0x04,
  SYNC_REQUEST: 0x05,
  SYNC_MESSAGE: 0x06,
  PRESENCE: 0x07,
  SEARCH_REQ: 0x08,
  SEARCH_RESP: 0x09,
  FEED_SYNC_REQ: 0x0a,
  FEED_SYNC_RESP: 0x0b,
  CHAT_HISTORY_REQ: 0x0c,
  CHAT_HISTORY_RESP: 0x0d,
} as const;

export const SearchType = {
  ALL: 0,
  USERS: 1,
  GROUPS: 2,
  CHANNELS: 3,
} as const;

export const RpcFlag = {
  COMPRESSED: 0x01,
  GROUP: 0x02,
  IS_GROUP_OR_CHANNEL: 0x02,
  REPLY: 0x04,
  TYPING: 0x08,
  MORE: 0x40,
} as const;

export const DeliveryStatus = {
  QUEUED: 0,
  SENT_TO_MESH: 1,
  DELIVERED_TO_PEER: 2,
  ACKED_BY_GATEWAY: 3,
  SYNCED_PERMANENT: 4,
  FAILED: 5,
  RECEIVED: 6,
  READ: 7,
} as const;

export type DeliveryStatusValue = (typeof DeliveryStatus)[keyof typeof DeliveryStatus];

export const ClientFrameType = {
  HELLO: 1,
  INFO: 2,
  RPC_UP: 3,
  RPC_DOWN: 4,
  STATUS: 5,
  CONFIG: 6,
  PING: 7,
  PONG: 8,
  LOG: 9,
  SYNC_ACK: 10,
  PROXY_UP: 11,
  PROXY_DOWN: 12,
  INET_STATUS: 13,
  SET_OWNER: 14,
} as const;

export const CLIENT_MAGIC = [0x53, 0x47] as const;
export const CLIENT_VERSION = 3;
export const CLIENT_HEADER_SIZE = 9;
export const CLIENT_MAX_FRAME = 2048;
export const CLIENT_FLAG_FRAGMENT = 0x01;
export const CLIENT_UP_HEADER = 13;

/* -------------------------------------------------------------- CRC16 ---- */

export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

/* ------------------------------------------------------------- packets --- */

export interface MeshPacket {
  packetId: number;
  msgUuid: bigint;
  srcId: number;
  dstId: number;
  nextHopId: number;
  lastHopId: number;
  type: number;
  flags: number;
  ttl: number;
  hopCount: number;
  payload: Uint8Array;
}

export function encodeMeshPacket(packet: MeshPacket): Uint8Array {
  if (packet.payload.length > MAX_PAYLOAD) throw new Error(`payload_too_large:${packet.payload.length}`);
  const out = new Uint8Array(PACKET_HEADER_SIZE + packet.payload.length + 2);
  const view = new DataView(out.buffer);
  out[0] = PACKET_MAGIC;
  out[1] = PACKET_VERSION;
  view.setUint32(2, packet.packetId >>> 0, true);
  view.setBigUint64(6, BigInt.asUintN(64, packet.msgUuid), true);
  view.setUint32(14, packet.srcId >>> 0, true);
  view.setUint32(18, packet.dstId >>> 0, true);
  view.setUint32(22, packet.nextHopId >>> 0, true);
  view.setUint32(26, packet.lastHopId >>> 0, true);
  out[30] = packet.type & 0xff;
  out[31] = packet.flags & 0xff;
  out[32] = packet.ttl & 0xff;
  out[33] = packet.hopCount & 0xff;
  out[34] = packet.payload.length;
  out.set(packet.payload, PACKET_HEADER_SIZE);
  view.setUint16(PACKET_HEADER_SIZE + packet.payload.length, crc16(out.subarray(0, PACKET_HEADER_SIZE + packet.payload.length)), true);
  return out;
}

export function decodeMeshPacket(data: Uint8Array): MeshPacket | null {
  if (data.length < PACKET_HEADER_SIZE + 2) return null;
  if (data[0] !== PACKET_MAGIC || data[1] !== PACKET_VERSION) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const len = data[34];
  if (len > MAX_PAYLOAD) return null;
  if (data.length < PACKET_HEADER_SIZE + len + 2) return null;
  const expected = view.getUint16(PACKET_HEADER_SIZE + len, true);
  if (crc16(data.subarray(0, PACKET_HEADER_SIZE + len)) !== expected) return null;
  return {
    packetId: view.getUint32(2, true),
    msgUuid: view.getBigUint64(6, true),
    srcId: view.getUint32(14, true),
    dstId: view.getUint32(18, true),
    nextHopId: view.getUint32(22, true),
    lastHopId: view.getUint32(26, true),
    type: data[30],
    flags: data[31],
    ttl: data[32],
    hopCount: data[33],
    payload: data.slice(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + len),
  };
}

/* ----------------------------------------------------------------- RPC --- */

export interface RpcText {
  chatRef: number;
  flags: number;
  compressed: boolean;
  bytes: Uint8Array;
  text?: string;
}

export function encodeRpcText(chatRef: number, text: string, flags = 0): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const out = new Uint8Array(4 + encoded.length);
  const view = new DataView(out.buffer);
  out[0] = RpcOp.SEND_TEXT;
  out[1] = flags;
  view.setUint16(2, chatRef & 0xffff, true);
  out.set(encoded, 4);
  return out;
}

export function encodeRpcAck(chatRef: number, ackedPacketId: number, status: number): Uint8Array {
  const out = new Uint8Array(9);
  const view = new DataView(out.buffer);
  out[0] = RpcOp.MSG_ACK;
  view.setUint16(2, chatRef & 0xffff, true);
  view.setUint32(4, ackedPacketId >>> 0, true);
  out[8] = status & 0xff;
  return out;
}

export function encodeRpcRead(chatRef: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint16(2, chatRef & 0xffff, true);
  out[0] = RpcOp.MSG_READ;
  return out;
}

export function encodeRpcLocation(chatRef: number, lat: number, lon: number, accuracyM = 0, battery = 0): Uint8Array {
  const out = new Uint8Array(15);
  const view = new DataView(out.buffer);
  out[0] = RpcOp.LOCATION_PING;
  view.setUint16(2, chatRef & 0xffff, true);
  view.setInt32(4, Math.round(lat * 1e7), true);
  view.setInt32(8, Math.round(lon * 1e7), true);
  view.setUint16(12, Math.min(65535, Math.max(0, Math.round(accuracyM))), true);
  out[14] = battery & 0xff;
  return out;
}

export function encodeRpcSyncRequest(chatRef: number, since: number, limit = 20): Uint8Array {
  const out = new Uint8Array(11);
  const view = new DataView(out.buffer);
  out[0] = RpcOp.SYNC_REQUEST;
  view.setUint16(2, chatRef & 0xffff, true);
  view.setUint32(4, since >>> 0, true);
  out[8] = Math.min(255, Math.max(1, limit));
  view.setUint16(9, chatRef & 0xffff, true);
  return out;
}

export function decodeRpc(payload: Uint8Array): RpcText | null {
  if (payload.length < 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const op = payload[0];
  if (op !== RpcOp.SEND_TEXT) return null;
  const bytes = payload.slice(4);
  const compressed = (payload[1] & RpcFlag.COMPRESSED) !== 0;
  const result: RpcText = {
    chatRef: view.getUint16(2, true),
    flags: payload[1],
    compressed,
    bytes,
  };
  if (!compressed) result.text = new TextDecoder().decode(bytes);
  return result;
}

/** Upward frame payload: dst u32 | flags u8 | msg_uuid u64 | RPC bytes. */
export function encodeRpcUp(dstId: number, flags: number, msgUuid: bigint, rpc: Uint8Array): Uint8Array {
  const out = new Uint8Array(CLIENT_UP_HEADER + rpc.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, dstId >>> 0, true);
  out[4] = flags & 0xff;
  view.setBigUint64(5, BigInt.asUintN(64, msgUuid), true);
  out.set(rpc, CLIENT_UP_HEADER);
  return out;
}

/* ------------------------------------------------------------- frames ---- */

export function encodeClientFrame(type: number, payload: Uint8Array, seq: number): Uint8Array {
  if (payload.length > CLIENT_MAX_FRAME) throw new Error('frame_too_large');
  const out = new Uint8Array(CLIENT_HEADER_SIZE + payload.length + 2);
  const view = new DataView(out.buffer);
  out[0] = CLIENT_MAGIC[0];
  out[1] = CLIENT_MAGIC[1];
  out[2] = CLIENT_VERSION;
  out[3] = type & 0xff;
  out[4] = 0;
  view.setUint16(5, seq & 0xffff, true);
  view.setUint16(7, payload.length, true);
  out.set(payload, CLIENT_HEADER_SIZE);
  view.setUint16(CLIENT_HEADER_SIZE + payload.length, crc16(out.subarray(2, CLIENT_HEADER_SIZE + payload.length)), true);
  return out;
}

export interface DecodedFrame {
  type: number;
  flags: number;
  seq: number;
  payload: Uint8Array;
}

/** Incremental decoder with offset-based fragment reassembly (2 slots). */
export class ClientFrameDecoder {
  private buffer = new Uint8Array(0);
  private frags: Array<{ type: number; total: number; seen: Map<number, number>; data: Uint8Array; at: number } | null> = [null, null];

  push(chunk: Uint8Array): DecodedFrame[] {
    if (!chunk.length) return [];
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer, 0);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const frames: DecodedFrame[] = [];
    let consumed = 0;
    while (this.buffer.length - consumed >= CLIENT_HEADER_SIZE + 2) {
      const p = this.buffer.subarray(consumed);
      if (p[0] !== CLIENT_MAGIC[0] || p[1] !== CLIENT_MAGIC[1] || p[2] !== CLIENT_VERSION) {
        consumed += 1;
        continue;
      }
      const view = new DataView(p.buffer, p.byteOffset, p.byteLength);
      const plen = view.getUint16(7, true);
      if (plen > CLIENT_MAX_FRAME) {
        consumed += 1;
        continue;
      }
      const total = CLIENT_HEADER_SIZE + plen + 2;
      if (p.length < total) break;
      if (crc16(p.subarray(2, CLIENT_HEADER_SIZE + plen)) !== view.getUint16(CLIENT_HEADER_SIZE + plen, true)) {
        consumed += 1;
        continue;
      }
      const type = p[3];
      const flags = p[4];
      const seq = view.getUint16(5, true);
      const payload = p.slice(CLIENT_HEADER_SIZE, CLIENT_HEADER_SIZE + plen);
      consumed += total;

      if (!(flags & CLIENT_FLAG_FRAGMENT)) {
        frames.push({ type, flags, seq, payload });
        continue;
      }
      if (plen < 6) continue;
      const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const offset = pv.getUint16(2, true);
      const fragTotal = pv.getUint16(4, true);
      const body = payload.slice(6);
      if (!fragTotal || fragTotal > CLIENT_MAX_FRAME || offset + body.length > fragTotal) continue;
      let slot = this.frags.find((f) => f && f.type === type && f.total === fragTotal) ?? null;
      if (!slot || (offset === 0 && slot.seen.size > 1)) {
        const fresh = {
          type,
          total: fragTotal,
          seen: new Map<number, number>(),
          data: new Uint8Array(fragTotal),
          at: Date.now(),
        };
        if (!this.frags[0] || (this.frags[0] && Date.now() - this.frags[0].at > 15000)) {
          this.frags[0] = fresh;
        } else if (!this.frags[1]) {
          this.frags[1] = fresh;
        } else {
          this.frags[0] = fresh;
        }
        slot = fresh;
      }
      slot.data.set(body, offset);
      slot.seen.set(offset, body.length);
      slot.at = Date.now();
      let covered = 0;
      for (const n of slot.seen.values()) covered += n;
      if (covered >= fragTotal) {
        frames.push({ type, flags: flags & ~CLIENT_FLAG_FRAGMENT, seq, payload: slot.data.slice() });
        this.frags = [null, null];
      }
    }
    if (consumed) this.buffer = this.buffer.slice(consumed);
    if (this.buffer.length > CLIENT_MAX_FRAME * 2) this.buffer = new Uint8Array(0);
    return frames;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
    this.frags = [null, null];
  }
}

/* ------------------------------------------------ сервисные RPC ---------- */

function putRawText(text: string, cap: number): Uint8Array {
  const bytes = new TextEncoder().encode(text).slice(0, Math.min(127, cap - 1));
  const out = new Uint8Array(1 + bytes.length);
  out[0] = bytes.length;
  out.set(bytes, 1);
  return out;
}

function readRawText(data: Uint8Array, offset: number): { text: string; next: number } {
  if (offset >= data.length) return { text: '', next: data.length };
  const len = data[offset] & 0x7f;
  const start = offset + 1;
  const end = Math.min(data.length, start + len);
  return { text: new TextDecoder().decode(data.subarray(start, end)), next: end };
}

function servicePrefix(op: number, chatRef: number, flags = 0): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = op;
  out[1] = flags;
  new DataView(out.buffer).setUint16(2, chatRef & 0xffff, true);
  return out;
}

export function encodeSearchRequest(reqId: number, searchType: number, query: string, chatRef = 0xffff): Uint8Array {
  const head = servicePrefix(RpcOp.SEARCH_REQ, chatRef);
  const body = putRawText(query, 40);
  const out = new Uint8Array(4 + 3 + body.length);
  out.set(head, 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, reqId & 0xffff, true);
  out[6] = searchType & 0xff;
  out.set(body, 7);
  return out;
}

export interface SearchResult {
  entityId: number;
  type: number;
  name: string;
}

export function decodeSearchResponse(payload: Uint8Array): { reqId: number; results: SearchResult[]; more: boolean } | null {
  if (payload.length < 7 || payload[0] !== RpcOp.SEARCH_RESP) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const total = payload[6];
  const results: SearchResult[] = [];
  let offset = 7;
  for (let i = 0; i < total && offset + 5 <= payload.length; i += 1) {
    const entityId = view.getUint32(offset, true);
    const type = payload[offset + 4];
    offset += 5;
    const text = readRawText(payload, offset);
    results.push({ entityId, type, name: text.text });
    offset = text.next;
  }
  return { reqId: view.getUint16(4, true), results, more: (payload[1] & RpcFlag.MORE) !== 0 };
}

export function encodeFeedRequest(lastSyncTs: number, chatRef = 0xffff): Uint8Array {
  const out = new Uint8Array(8);
  out.set(servicePrefix(RpcOp.FEED_SYNC_REQ, chatRef), 0);
  new DataView(out.buffer).setUint32(4, lastSyncTs >>> 0, true);
  return out;
}

export interface FeedEntry {
  chatRef: number;
  chatId?: string;
  unreadCount: number;
  lastMsgUuid: string;
  timestamp: number;
  preview: string;
}

export function decodeFeedResponse(payload: Uint8Array): { entries: FeedEntry[]; more: boolean } | null {
  if (payload.length < 7 || payload[0] !== RpcOp.FEED_SYNC_RESP) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const total = payload[6];
  const entries: FeedEntry[] = [];
  let offset = 7;
  for (let i = 0; i < total && offset + 16 <= payload.length; i += 1) {
    const chatRef = view.getUint16(offset, true);
    const unreadCount = view.getUint16(offset + 2, true);
    const uuid = view.getBigUint64(offset + 4, true);
    const timestamp = view.getUint32(offset + 12, true);
    offset += 16;
    const text = readRawText(payload, offset);
    entries.push({
      chatRef,
      unreadCount,
      lastMsgUuid: uuid.toString(16).padStart(16, '0'),
      timestamp,
      preview: text.text,
    });
    offset = text.next;
  }
  return { entries, more: (payload[1] & RpcFlag.MORE) !== 0 };
}

export function encodeHistoryRequest(chatRef: number, beforeUuid: bigint, limit = 10): Uint8Array {
  const out = new Uint8Array(13);
  out.set(servicePrefix(RpcOp.CHAT_HISTORY_REQ, chatRef), 0);
  const view = new DataView(out.buffer);
  view.setBigUint64(4, BigInt.asUintN(64, beforeUuid), true);
  out[12] = Math.min(20, Math.max(1, limit));
  return out;
}

export interface HistoryEntry {
  msgUuid: string;
  senderId: number;
  timestamp: number;
  text: string;
}

export function decodeHistoryResponse(payload: Uint8Array): { messages: HistoryEntry[]; more: boolean } | null {
  if (payload.length < 5 || payload[0] !== RpcOp.CHAT_HISTORY_RESP) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const total = payload[4];
  const messages: HistoryEntry[] = [];
  let offset = 5;
  for (let i = 0; i < total && offset + 16 <= payload.length; i += 1) {
    const uuid = view.getBigUint64(offset, true);
    const senderId = view.getUint32(offset + 8, true);
    const timestamp = view.getUint32(offset + 12, true);
    offset += 16;
    const text = readRawText(payload, offset);
    messages.push({ msgUuid: uuid.toString(16).padStart(16, '0'), senderId, timestamp, text: text.text });
    offset = text.next;
  }
  return { messages, more: (payload[1] & RpcFlag.MORE) !== 0 };
}

export function encodeInetStatus(hasInternet: boolean, rttMs: number, allowRelay: boolean): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = hasInternet ? 1 : 0;
  new DataView(out.buffer).setUint16(1, Math.min(65535, Math.max(0, rttMs)), true);
  out[3] = allowRelay ? 1 : 0;
  return out;
}

export function encodeProxyDown(packet: MeshPacket): Uint8Array {
  return encodeMeshPacket(packet);
}

/* ---------------------------------------------------------- snowflake ---- */

const SEQ_MASK = 0x3ffn;
let snowflakeSeq = 0n;
let lastSnowflakeMs = 0n;

/** 42-bit timestamp | 12-bit node | 10-bit sequence. */
export function nextMsgUuid(nodeId: number): bigint {
  let now = BigInt(Date.now());
  if (now <= lastSnowflakeMs) now = lastSnowflakeMs + 1n;
  lastSnowflakeMs = now;
  const seq = snowflakeSeq++ & SEQ_MASK;
  return ((now & 0x3ffffffffffn) << 22n) | (BigInt(nodeId & 0xfff) << 10n) | seq;
}

export function msgUuidHex(uuid: bigint): string {
  return BigInt.asUintN(64, uuid).toString(16).padStart(16, '0');
}

export function msgUuidFromHex(hex: string): bigint {
  return BigInt(`0x${hex.replace(/[^0-9a-f]/gi, '').padStart(16, '0').slice(0, 16)}`);
}
