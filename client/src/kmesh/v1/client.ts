/**
 * Клиентский сервис KMesh_v1.
 *
 * Задачи:
 *   - собирать бинарные RPC_UP для носимого модуля;
 *   - сохранять каждое оффлайн-сообщение в локальной БД (LOCAL_MESH_ONLY);
 *   - расшифровывать и разбирать MeshPacket, доставленные узлом;
 *   - при появлении интернета перешифровывать постоянным ключом чата,
 *     подписывать постоянным ключом устройства и вызывать /v1/kmesh/v1/sync;
 *   - отдавать статус MSG_SYNCED, чтобы UI не дублировал сообщение.
 */
import { encryptBytes, storage } from '../../crypto/core';
import { kv } from '../../crypto/storage';
import { loadChatKey } from '../../data/chatkit';
import { api } from '../../data/api';
import {
  kmeshV1Enqueue,
  kmeshV1List,
  kmeshV1Remove,
  kmeshV1Update,
  type KMeshV1OutboxItem,
  type KMeshV1SyncState,
} from '../../data/db';
import {
  ClientFrameDecoder,
  ClientFrameType,
  DeliveryStatus,
  PacketFlag,
  RpcOp,
  BROADCAST_ID,
  ANY_GATEWAY_ID,
  decodeMeshPacket,
  decodeRpc,
  decodeFeedResponse,
  decodeHistoryResponse,
  decodeSearchResponse,
  encodeClientFrame,
  encodeFeedRequest,
  encodeHistoryRequest,
  encodeInetStatus,
  encodeProxyDown,
  encodeRpcText,
  encodeRpcUp,
  encodeSearchRequest,
  msgUuidHex,
  nextMsgUuid,
  type DeliveryStatusValue,
  type FeedEntry,
  type HistoryEntry,
  type MeshPacket,
  type SearchResult,
} from './protocol';
import { b64ToBytes, signPermanent } from './crypto';

export interface KMeshV1Link {
  send(frame: Uint8Array): Promise<boolean>;
}

export interface KMeshV1ReceivedMessage {
  msgUuid: string;
  chatRef: number;
  srcNodeId: number;
  dstNodeId: number;
  text: string;
  createdAt: number;
  packet: MeshPacket;
}

export interface KMeshV1StatusEvent {
  msgUuid: string;
  packetId: number;
  status: DeliveryStatusValue;
  serverSeq?: number;
}

export interface KMeshV1ClientOptions {
  link: KMeshV1Link;
  getChatKey?: (chatId: string) => Promise<Uint8Array | null>;
  resolveChatByRef?: (chatRef: number) => string | undefined;
  onMessage?: (message: KMeshV1ReceivedMessage) => void;
  onStatus?: (event: KMeshV1StatusEvent) => void;
  onInfo?: (info: { nodeId: number; role: number; mtu: number; queue: number }) => void;
  onSearch?: (reqId: number, results: SearchResult[], more: boolean) => void;
  onFeed?: (entries: FeedEntry[], more: boolean) => void;
  onHistory?: (chatRef: number, messages: HistoryEntry[], more: boolean) => void;
  /** Мобильный шлюз: пакет для отправки на Hub (тело зашифровано). */
  onProxyUplink?: (packet: MeshPacket, raw: Uint8Array) => void;
  allowRelayTraffic?: boolean;
  dailyProxyLimitBytes?: number;
}

export class KMeshV1Client {
  private link: KMeshV1Link;
  private decoder = new ClientFrameDecoder();
  private seq = 1;
  private nodeId = 0;
  private opts: KMeshV1ClientOptions;
  private proxyBytesToday = 0;
  private proxyDay = '';
  private dailyProxyLimit = 10 * 1024 * 1024;

  constructor(options: KMeshV1ClientOptions) {
    this.opts = options;
    this.link = options.link;
    if (options.dailyProxyLimitBytes) this.dailyProxyLimit = options.dailyProxyLimitBytes;
    void this.loadProxyCounter();
  }

  private async loadProxyCounter(): Promise<void> {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const storedDay = await kv.get('sg:kmesh:proxy:day');
      if (storedDay !== day) {
        this.proxyDay = day;
        this.proxyBytesToday = 0;
        await kv.set('sg:kmesh:proxy:day', day);
        await kv.set('sg:kmesh:proxy:bytes', '0');
        return;
      }
      this.proxyDay = day;
      this.proxyBytesToday = Number(await kv.get('sg:kmesh:proxy:bytes')) || 0;
    } catch {
      /* счётчик недоступен — работаем без лимита */
    }
  }

  private async addProxyBytes(bytes: number): Promise<boolean> {
    await this.loadProxyCounter();
    if (this.proxyBytesToday + bytes > this.dailyProxyLimit) return false;
    this.proxyBytesToday += bytes;
    try {
      await kv.set('sg:kmesh:proxy:bytes', String(this.proxyBytesToday));
    } catch {
      /* ignore */
    }
    return true;
  }

  getProxyTraffic(): { usedBytes: number; limitBytes: number } {
    return { usedBytes: this.proxyBytesToday, limitBytes: this.dailyProxyLimit };
  }

  attachLink(link: KMeshV1Link): void {
    this.link = link;
    this.decoder.reset();
  }

  setNodeId(nodeId: number): void {
    this.nodeId = nodeId >>> 0;
  }

  getNodeId(): number {
    return this.nodeId;
  }

  /** Handshake: ask the node for its INFO frame (which carries node_id). */
  async hello(): Promise<boolean> {
    return this.link.send(encodeClientFrame(ClientFrameType.HELLO, new Uint8Array(0), this.seq++));
  }

  async ping(): Promise<boolean> {
    return this.link.send(encodeClientFrame(ClientFrameType.PING, new Uint8Array(0), this.seq++));
  }

  /** Раз в 15 секунд приложение сообщает модулю статус интернета. */
  async setInetStatus(hasInternet: boolean, rttMs: number, allowRelay = this.opts.allowRelayTraffic ?? true): Promise<boolean> {
    const payload = encodeInetStatus(hasInternet, rttMs, allowRelay);
    return this.link.send(encodeClientFrame(ClientFrameType.INET_STATUS, payload, this.seq++));
  }

  private async sendServiceRpc(rpc: Uint8Array): Promise<boolean> {
    const up = encodeRpcUp(ANY_GATEWAY_ID, PacketFlag.TO_INTERNET, 0n, rpc);
    return this.link.send(encodeClientFrame(ClientFrameType.RPC_UP, up, this.seq++));
  }

  async search(reqId: number, query: string, searchType: number): Promise<boolean> {
    return this.sendServiceRpc(encodeSearchRequest(reqId, searchType, query));
  }

  async syncFeed(lastSyncTs: number): Promise<boolean> {
    return this.sendServiceRpc(encodeFeedRequest(lastSyncTs));
  }

  async chatHistory(chatRef: number, beforeUuid = 0n, limit = 10): Promise<boolean> {
    return this.sendServiceRpc(encodeHistoryRequest(chatRef, beforeUuid, limit));
  }

  /** Мобильный шлюз: отправить серверный пакет в mesh. */
  async proxyDownlink(packet: MeshPacket): Promise<boolean> {
    return this.link.send(encodeClientFrame(ClientFrameType.PROXY_DOWN, encodeProxyDown(packet), this.seq++));
  }

  async sendConfig(wifiSsid: string, wifiPassword: string): Promise<boolean> {
    const payload = new TextEncoder().encode(JSON.stringify({ wifiSsid, wifiPassword }));
    return this.link.send(encodeClientFrame(ClientFrameType.CONFIG, payload, this.seq++));
  }

  /**
   * Отправить текст через mesh. Сообщение сначала сохраняется локально,
   * поэтому переживает перезапуск и уходит в облако при появлении интернета.
   */
  async sendText(input: {
    chatId: string;
    chatRef: number;
    peerNodeId: number;
    text: string;
    toInternet?: boolean;
    group?: boolean;
  }): Promise<{ msgUuid: string; state: KMeshV1SyncState }> {
    const keys = await storage.loadKeys();
    if (!keys) throw new Error('device_keys_missing');
    if (!this.nodeId) throw new Error('mesh_node_not_connected');

    const msgUuid = nextMsgUuid(this.nodeId);
    const uuidHex = msgUuidHex(msgUuid);
    const isGroup = Boolean(input.group);
    const rpc = encodeRpcText(input.chatRef, input.text, isGroup ? 0x02 : 0);
    const flags =
      (input.toInternet || isGroup
        ? PacketFlag.TO_INTERNET | PacketFlag.NEED_CLOUD_ARCHIVE
        : PacketFlag.NEED_CLOUD_ARCHIVE) |
      (isGroup ? 0 : PacketFlag.NEED_ACK);
    const up = encodeRpcUp(isGroup ? BROADCAST_ID : input.peerNodeId, flags, msgUuid, rpc);
    const frame = encodeClientFrame(ClientFrameType.RPC_UP, up, this.seq++);

    let ciphertextB64 = '';
    let nonce = '';
    const chatKey = await this.chatKeyFor(input.chatId);
    if (chatKey) {
      const sealed = encryptBytes(chatKey, new TextEncoder().encode(input.text));
      ciphertextB64 = sealed.ciphertext;
      nonce = sealed.nonce;
    }

    const item: KMeshV1OutboxItem = {
      msgUuid: uuidHex,
      chatId: input.chatId,
      chatRef: input.chatRef,
      peerNodeId: input.peerNodeId,
      senderNodeId: this.nodeId,
      text: input.text,
      createdAt: new Date().toISOString(),
      ciphertextB64,
      nonce,
      state: 'LOCAL_MESH_ONLY',
      attempts: 0,
      permanentSignature: '',
    };
    await kmeshV1Enqueue(item);

    const ok = await this.link.send(frame).catch(() => false);
    if (!ok) {
      item.state = 'FAILED';
      item.attempts += 1;
      await kmeshV1Update(item);
    }
    return { msgUuid: uuidHex, state: item.state };
  }

  /** Feed bytes from the BLE notification stream. */
  handleData(chunk: Uint8Array): void {
    for (const frame of this.decoder.push(chunk)) {
      switch (frame.type) {
        case ClientFrameType.INFO: {
          try {
            const info = JSON.parse(new TextDecoder().decode(frame.payload)) as {
              nodeId?: number;
              role?: number;
              mtu?: number;
              queue?: number;
            };
            if (typeof info.nodeId === 'number') this.nodeId = info.nodeId >>> 0;
            this.opts.onInfo?.({
              nodeId: this.nodeId,
              role: Number(info.role ?? 0),
              mtu: Number(info.mtu ?? 0),
              queue: Number(info.queue ?? 0),
            });
          } catch {
            /* ignore malformed info */
          }
          break;
        }
        case ClientFrameType.STATUS: {
          if (frame.payload.length < 13) break;
          const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
          const uuid = view.getBigUint64(0, true);
          const packetId = view.getUint32(8, true);
          const status = frame.payload[12] as DeliveryStatusValue;
          this.opts.onStatus?.({ msgUuid: msgUuidHex(uuid), packetId, status });
          break;
        }
        case ClientFrameType.SYNC_ACK: {
          if (frame.payload.length < 13) break;
          const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
          const uuid = view.getBigUint64(0, true);
          const serverSeq = view.getUint32(8, true);
          this.opts.onStatus?.({
            msgUuid: msgUuidHex(uuid),
            packetId: 0,
            status: DeliveryStatus.SYNCED_PERMANENT,
            serverSeq,
          });
          break;
        }
        case ClientFrameType.RPC_DOWN: {
          const packet = decodeMeshPacket(frame.payload);
          if (!packet) break;
          if (packet.flags & PacketFlag.PERM_USER_KEY) {
            /* Постоянный downlink забирается через /v1/kmesh/v1/history. */
            break;
          }
          const op = packet.payload[0];
          if (op === RpcOp.SEARCH_RESP) {
            const parsed = decodeSearchResponse(packet.payload);
            if (parsed) this.opts.onSearch?.(parsed.reqId, parsed.results, parsed.more);
            break;
          }
          if (op === RpcOp.FEED_SYNC_RESP) {
            const parsed = decodeFeedResponse(packet.payload);
            if (parsed) this.opts.onFeed?.(parsed.entries, parsed.more);
            break;
          }
          if (op === RpcOp.CHAT_HISTORY_RESP) {
            const parsed = decodeHistoryResponse(packet.payload);
            if (parsed) this.opts.onHistory?.(packet.payload[2] | (packet.payload[3] << 8), parsed.messages, parsed.more);
            break;
          }
          const rpc = decodeRpc(packet.payload);
          if (!rpc || rpc.compressed) break;
          this.emitMessage(packet, rpc.chatRef, rpc.text ?? '');
          break;
        }
        case ClientFrameType.PROXY_UP: {
          const packet = decodeMeshPacket(frame.payload);
          if (!packet) break;
          void this.addProxyBytes(frame.payload.length).then((allowed) => {
            if (allowed) this.opts.onProxyUplink?.(packet, frame.payload);
          });
          break;
        }
        default:
          break;
      }
    }
  }

  private emitMessage(packet: MeshPacket, chatRef: number, text: string): void {
    if (!text) return;
    this.opts.onMessage?.({
      msgUuid: msgUuidHex(packet.msgUuid),
      chatRef,
      srcNodeId: packet.srcId,
      dstNodeId: packet.dstId,
      text,
      createdAt: Number((packet.msgUuid >> 22n) & 0x3ffffffffffn) || Date.now(),
      packet,
    });
  }

  private async chatKeyFor(chatId: string): Promise<Uint8Array | null> {
    if (this.opts.getChatKey) return this.opts.getChatKey(chatId);
    const keys = await storage.loadKeys();
    if (!keys) return null;
    return loadChatKey(chatId, keys).catch(() => null);
  }

  /**
   * Выгрузить постоянно подписанные записи. Можно вызывать при каждом
   * изменении сети: сервер дедуплицирует по msg_uuid.
   */
  async syncOutbox(): Promise<{ synced: number; remaining: number }> {
    const keys = await storage.loadKeys();
    if (!keys) return { synced: 0, remaining: (await kmeshV1List()).length };
    const items = await kmeshV1List();
    let synced = 0;
    for (const item of items) {
      if (item.state === 'SYNCED_PERMANENT') {
        await kmeshV1Remove(item.msgUuid);
        continue;
      }
      if (!item.ciphertextB64) {
        const key = await this.chatKeyFor(item.chatId);
        if (!key) {
          item.state = 'FAILED';
          item.attempts += 1;
          await kmeshV1Update(item);
          continue;
        }
        const sealed = encryptBytes(key, new TextEncoder().encode(item.text));
        item.ciphertextB64 = sealed.ciphertext;
        item.nonce = sealed.nonce;
      }
      const timestamp = Date.parse(item.createdAt) || Date.now();
      const ciphertext = b64ToBytes(item.ciphertextB64);
      try {
        const signature = signPermanent(keys.identityPriv, {
          msgUuid: item.msgUuid,
          senderNodeId: item.senderNodeId || this.nodeId,
          receiverNodeId: item.peerNodeId,
          timestamp,
          ciphertext,
        });
        const response = await api.kmeshV1Sync({
          msg_uuid: item.msgUuid,
          chat_id: item.chatId,
          sender_node_id: item.senderNodeId || this.nodeId,
          receiver_node_id: item.peerNodeId,
          timestamp,
          ciphertext_b64: item.ciphertextB64,
          nonce: item.nonce,
          kind: 'text',
          header: { chatRef: item.chatRef, transport: 'kmesh-v1' },
          signature,
          sig_alg: 'ecdsa-p256',
          resign_mode: 'client',
          chat_ref: item.chatRef,
        });
        item.state = 'SYNCED_PERMANENT';
        item.serverSeq = response.server_seq;
        item.permanentSignature = response.permanent_signature;
        item.attempts = 0;
        await kmeshV1Update(item);
        await kmeshV1Remove(item.msgUuid);
        this.opts.onStatus?.({
          msgUuid: item.msgUuid,
          packetId: 0,
          status: DeliveryStatus.SYNCED_PERMANENT,
          serverSeq: response.server_seq,
        });
        synced += 1;
      } catch {
        item.state = 'SYNC_PENDING';
        item.attempts += 1;
        await kmeshV1Update(item);
      }
    }
    const remaining = (await kmeshV1List()).filter((i) => i.state !== 'SYNCED_PERMANENT').length;
    return { synced, remaining };
  }

  /** Export the local pending list for the UI/debug screen. */
  async pending(): Promise<KMeshV1OutboxItem[]> {
    return kmeshV1List();
  }
}

export { DeliveryStatus };
export type { KMeshV1OutboxItem, KMeshV1SyncState };
