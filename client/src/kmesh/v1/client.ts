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
import { pairKeyFor } from './pairKey';
import { signRelay } from './relay';
import { encryptBytes, decryptBytes, storage } from '../../crypto/core';
import { kv } from '../../crypto/storage';
import { getServerChatKey, loadChatKey, peekServerChatKey } from '../../data/chatkit';
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
  encodeEnvelopeRpc,
  decodeEnvelopeRpc,
  encodeChatKeyRequest,
  decodeChatKeyResponse,
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
import { b64ToBytes, bytesToB64, signPermanent } from './crypto';
import { decodeLocalSearch, encodeLocalSearchReq, encodeLocalSearchResp, msgUuidFromHex } from './protocol';

export interface KMeshV1Link {
  send(frame: Uint8Array): Promise<boolean>;
  sendProgress?: (
    frame: Uint8Array,
    onProgress: (sent: number, total: number) => void,
  ) => Promise<boolean>;
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
  onSecureMessage?: (message: {
    msgUuid: string;
    chatId: string;
    chatRef: number;
    kind: string;
    nonce: string;
    ciphertext: string;
    srcNodeId: number;
  }) => void;
  onStatus?: (event: KMeshV1StatusEvent) => void;
  onInfo?: (info: { nodeId: number; role: number; mtu: number; queue: number; gateway: boolean }) => void;
  onSearch?: (reqId: number, results: SearchResult[], more: boolean) => void;
  /** Поиск без Hub: соседний телефон спрашивает — отвечаем из своих локальных данных. */
  onLocalSearchRequest?: (query: string) => Array<{ type: number; name: string }>;
  onFeed?: (entries: FeedEntry[], more: boolean) => void;
  onHistory?: (chatRef: number, messages: HistoryEntry[], more: boolean) => void;
  /** Прогресс записи кадра в BLE: байты и привязка к сообщению. */
  onSendProgress?: (event: {
    msgUuid: string;
    clientId?: string;
    chatId: string;
    sent: number;
    total: number;
    phase?: 'preparing' | 'key' | 'sending' | 'sent' | 'nokey';
  }) => void;
  /** Hub вернул постоянный ключ серверного чата через KMesh. */
  onChatKey?: (chatId: string, version: number, key: Uint8Array) => void;
  /** Мобильный шлюз: пакет для отправки на Hub (тело зашифровано). */
  onProxyUplink?: (packet: MeshPacket, raw: Uint8Array) => void;
  allowRelayTraffic?: boolean;
  dailyProxyLimitBytes?: number;
}

/** Общий для всех экземпляров: повтор после переподключения использует тот же uuid. */
const uuidByClient = new Map<string, bigint>();

export class KMeshV1Client {
  private link: KMeshV1Link;
  private decoder = new ClientFrameDecoder();
  private seq = 1;
  private nodeId = 0;
  private opts: KMeshV1ClientOptions;
  /** Мобильный шлюз подключает обработчик после создания клиента. */
  private proxyHandler?: (packet: MeshPacket, raw: Uint8Array) => void;
  private proxyBytesToday = 0;
  private proxyDay = '';
  private dailyProxyLimit = 10 * 1024 * 1024;
  private pendingKeyRefs = new Map<number, string>();
  /**
   * clientId → msgUuid. Повторная отправка того же сообщения (очередь meshLink)
   * должна использовать тот же uuid, иначе каждая попытка создавала новую
   * запись в outbox и дубликаты на Hub.
   */

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

  /** Обработчик PROXY_UP (мобильный шлюз включает его после создания). */
  setProxyUplinkHandler(handler: (packet: MeshPacket, raw: Uint8Array) => void): void {
    this.proxyHandler = handler;
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

  /** Поиск без Hub: опросить телефоны в кластере (broadcast; ретрансляторы передают дальше по TTL). */
  async localSearch(reqId: number, query: string): Promise<boolean> {
    const up = encodeRpcUp(BROADCAST_ID, 0, 0n, encodeLocalSearchReq(reqId, query));
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

  /** Запросить постоянный ключ серверного чата у Hub через KMesh. */
  async requestChatKey(chatId: string, chatRef: number): Promise<boolean> {
    this.pendingKeyRefs.set(chatRef & 0xffff, chatId);
    return this.sendServiceRpc(encodeChatKeyRequest(chatRef, chatId));
  }

  /** Мобильный шлюз: отправить серверный пакет в mesh. */
  async proxyDownlink(packet: MeshPacket): Promise<boolean> {
    return this.link.send(encodeClientFrame(ClientFrameType.PROXY_DOWN, encodeProxyDown(packet), this.seq++));
  }

  async sendConfig(wifiSsid: string, wifiPassword: string): Promise<boolean> {
    const payload = new TextEncoder().encode(JSON.stringify({ wifiSsid, wifiPassword }));
    return this.link.send(encodeClientFrame(ClientFrameType.CONFIG, payload, this.seq++));
  }

  /** Настройка железа, подписанная Hub (владельцем): по BLE/USB напрямую в подключённый модуль. */
  async sendHwConfig(p: string, epoch: number, sigHex: string): Promise<boolean> {
    const payload = new TextEncoder().encode(JSON.stringify({ hw: p, e: epoch, s: sigHex }));
    return this.link.send(encodeClientFrame(ClientFrameType.CONFIG, payload, this.seq++));
  }

  /** То же, но другому узлу через mesh (RPC 0x30): [epoch u32][sig_len u8][sig][p]. */
  async sendNodeConfig(dstNodeId: number, p: string, epoch: number, sigHex: string): Promise<boolean> {
    const sig: number[] = [];
    for (let i = 0; i + 1 < sigHex.length; i += 2) sig.push(parseInt(sigHex.slice(i, i + 2), 16));
    const pb = new TextEncoder().encode(p);
    const body = new Uint8Array(4 + 4 + 1 + sig.length + pb.length);
    body.set([0x30, 0, 0xff, 0xff], 0);
    new DataView(body.buffer).setUint32(4, epoch >>> 0, true);
    body[8] = sig.length;
    body.set(sig, 9);
    body.set(pb, 9 + sig.length);
    const up = encodeRpcUp(dstNodeId >>> 0, PacketFlag.NEED_ACK, 0n, body);
    return this.link.send(encodeClientFrame(ClientFrameType.RPC_UP, up, this.seq++));
  }

  /** Первичная локальная привязка (без подписи), только для модуля без владельца. */
  async assignOwnerLocal(claim: { prefix: string; netId: number; epoch?: number }): Promise<boolean> {
    if (!/^[0-9a-f]{8}$/i.test(claim.prefix)) return false;
    const payload = new Uint8Array(16);
    const prefix = claim.prefix.toLowerCase();
    for (let i = 0; i < 8; i += 1) payload[i] = prefix.charCodeAt(i) & 0xff;
    const view = new DataView(payload.buffer);
    view.setUint32(8, claim.netId >>> 0, true);
    view.setUint32(12, (claim.epoch ?? 1) >>> 0, true);
    return this.link.send(encodeClientFrame(ClientFrameType.SET_OWNER_LOCAL, payload, this.seq++));
  }

  /** SET_OWNER в бинарном KMesh_v1: prefix(8) net(4) epoch(4) sig_len(1) DER. */
  async setOwner(claim: { prefix: string; netId: number; epoch: number; signature: string }): Promise<boolean> {
    const sig: number[] = [];
    for (let i = 0; i + 1 < claim.signature.length; i += 2) {
      sig.push(parseInt(claim.signature.slice(i, i + 2), 16));
    }
    if (!sig.length || sig.length > 72) return false;
    const payload = new Uint8Array(17 + sig.length);
    const prefix = claim.prefix.toLowerCase();
    for (let i = 0; i < 8; i += 1) payload[i] = prefix.charCodeAt(i) & 0xff;
    const view = new DataView(payload.buffer);
    view.setUint32(8, claim.netId >>> 0, true);
    view.setUint32(12, claim.epoch >>> 0, true);
    payload[16] = sig.length;
    payload.set(sig, 17);
    return this.link.send(encodeClientFrame(ClientFrameType.SET_OWNER, payload, this.seq++));
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
    /** Публичный канал: без ключа можно слать открыто (пост и так публичный). */
    allowPlaintext?: boolean;
    clientId?: string;
  }): Promise<{ msgUuid: string; state: KMeshV1SyncState }> {
    const keys = await storage.loadKeys();
    if (!keys) throw new Error('device_keys_missing');
    if (!this.nodeId) throw new Error('mesh_node_not_connected');

    const knownUuid = input.clientId ? uuidByClient.get(input.clientId) : undefined;
    const msgUuid = knownUuid ?? nextMsgUuid(this.nodeId);
    if (input.clientId && !knownUuid) {
      uuidByClient.set(input.clientId, msgUuid);
      if (uuidByClient.size > 200) {
        const first = uuidByClient.keys().next().value;
        if (first !== undefined) uuidByClient.delete(first);
      }
    }
    const uuidHex = msgUuidHex(msgUuid);
    // Повторный вызов для уже принятого шлюзом сообщения не шлём заново: раньше очередь повторяла отправку,
    // и статус в пузыре гонялся «Подготовка kMesh» ↔ «Шлюз принял».
    if (knownUuid) {
      const prev = (await kmeshV1List().catch(() => [])).find((row) => row.msgUuid === uuidHex);
      if (prev && prev.state === 'SYNCED_PERMANENT') return { msgUuid: uuidHex, state: prev.state };
    }
    const isGroup = Boolean(input.group);
    const item: KMeshV1OutboxItem = {
      msgUuid: uuidHex,
      chatId: input.chatId,
      chatRef: input.chatRef,
      peerNodeId: input.peerNodeId,
      senderNodeId: this.nodeId,
      text: input.text,
      createdAt: new Date().toISOString(),
      ciphertextB64: '',
      nonce: '',
      state: 'SYNC_PENDING',
      attempts: 0,
      permanentSignature: '',
      ...(input.clientId ? { clientId: input.clientId } : {}),
    };
    // Сначала фиксируем в очереди: сообщение не должно потеряться, даже если
    // ключ чата ещё не в кэше (офлайн после переустановки). Такое сообщение
    // уйдёт на Hub при появлении сети.
    await kmeshV1Enqueue(item);
    this.opts.onSendProgress?.({
      msgUuid: uuidHex,
      clientId: input.clientId,
      chatId: input.chatId,
      sent: 0,
      total: 0,
      phase: 'preparing',
    });

    const sendFrame = async (frame: Uint8Array): Promise<boolean> => {
      const sendOnce = this.link.sendProgress
        ? this.link.sendProgress(frame, (sent, total) =>
            this.opts.onSendProgress?.({
              msgUuid: uuidHex,
              clientId: input.clientId,
              chatId: input.chatId,
              sent,
              total,
              phase: 'sending',
            }),
          )
        : this.link.send(frame);
      // Android BLE иногда не вызывает callback write-with-response. Не держим
      // сообщение вечно: по таймауту считаем попытку неуспешной, очередь повторит.
      const ok = await Promise.race([
        sendOnce.catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 12_000)),
      ]);
      if (!ok) {
        console.log('[kmesh]', 'sendFrame timeout/failed', frame.length);
        return false;
      }
      this.opts.onSendProgress?.({
        msgUuid: uuidHex,
        clientId: input.clientId,
        chatId: input.chatId,
        sent: frame.length,
        total: frame.length,
        phase: 'sent',
      });
      return true;
    };

    /* Выбор ключа (конфиденциальность в кластере без Hub):
     *  1) секретный чат — E2E-ключ с устройства (с Hub не синхронизируется);
     *  2) закэшированный постоянный серверный ключ чата — всегда, даже без шлюза;
     *  3) шлюз есть — запрашиваем серверный ключ у Hub через KMesh (CHAT_KEY_REQ);
     *  4) ключа нет — ключ пары пользователей (ECDH ключей аккаунтов), модули и Hub его не знают;
     *  5) нет и его — в эфир НЕ отправляем: сообщение ждёт в outbox до доступа к Hub.
     *     Исключение — публичный канал (allowPlaintext): пост и так публичный. */
    const e2eKey = await this.e2eKeyFor(input.chatId).catch(() => null);
    let keyKind: 'e2e' | 'server' | 'pair' | null = null;
    let chatKey: Uint8Array | null = null;
    if (e2eKey) {
      chatKey = e2eKey;
      keyKind = 'e2e';
    } else {
      chatKey = await peekServerChatKey(input.chatId).catch(() => null);
      if (chatKey) keyKind = 'server';
    }
    const toCluster = !input.toInternet;
    if (!chatKey && input.toInternet) {
      this.opts.onSendProgress?.({ msgUuid: uuidHex, clientId: input.clientId, chatId: input.chatId, sent: 0, total: 0, phase: 'key' });
      chatKey = await this.chatKeyFor(input.chatId).catch(() => null);
      if (!chatKey) {
        await this.requestChatKey(input.chatId, input.chatRef).catch(() => false);
        for (let i = 0; i < 14 && !chatKey; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          chatKey = await peekServerChatKey(input.chatId).catch(() => null);
        }
      }
      if (chatKey) keyKind = 'server';
    }
    if (!chatKey) {
      chatKey = await pairKeyFor(input.chatId);
      if (chatKey) keyKind = 'pair';
    }
    if (!chatKey && !input.allowPlaintext) {
      // Нечем зашифровать конфиденциально — в эфир не отправляем. Сообщение остаётся в outbox и уйдёт
      // с серверным ключом, как только Hub станет доступен (через интернет или шлюз KMesh).
      item.state = 'LOCAL_MESH_ONLY';
      await kmeshV1Update(item);
      this.opts.onSendProgress?.({ msgUuid: uuidHex, clientId: input.clientId, chatId: input.chatId, sent: 0, total: 0, phase: 'nokey' });
      console.log('[kmesh]', 'no confidential key, kept in outbox', { chatId: input.chatId });
      return { msgUuid: uuidHex, state: item.state };
    }
    if (!chatKey) {
      // Офлайн/кластер: текст идёт открытым внутри mesh-пакета (он запечатан
      // временным ключом кластера); при появлении Hub outbox зашифрует его
      // постоянным ключом чата и сохранит.
      const textRpc = encodeRpcText(input.chatRef, input.text);
      const textFlags =
        (input.toInternet || isGroup ? PacketFlag.TO_INTERNET : 0) |
        PacketFlag.NEED_CLOUD_ARCHIVE |
        (isGroup ? 0 : PacketFlag.NEED_ACK);
      const up = encodeRpcUp(isGroup || toCluster ? BROADCAST_ID : input.peerNodeId, textFlags, msgUuid, textRpc);
      const frame = encodeClientFrame(ClientFrameType.RPC_UP, up, this.seq++);
      item.state = 'LOCAL_MESH_ONLY';
      await kmeshV1Update(item);
      const ok = await sendFrame(frame);
      console.log('[kmesh]', 'sendText plaintext', {
        chatId: input.chatId,
        chatRef: input.chatRef,
        frameLen: frame.length,
        ok,
      });
      if (!ok) {
        item.state = 'FAILED';
        item.attempts += 1;
        await kmeshV1Update(item);
      }
      return { msgUuid: uuidHex, state: item.state };
    }
    // Тот же формат, что у обычной отправки (encryptForChat → JSON {text}): Hub и получатели
    // расшифровывают его как любое другое сообщение. Раньше шифровался «голый» текст → пустое сообщение.
    let payloadJson = JSON.stringify({ text: input.text });
    if (keyKind === 'pair') {
      // Подпись автора — чтобы получатель мог выгрузить копию на Hub, если отправитель туда не выйдет.
      const ts = Date.now();
      const signed = JSON.stringify({ text: input.text, ts, sig: signRelay(keys.identityPriv, uuidHex, input.chatId, ts, input.text) });
      // Пакет KMesh ≤ 255 байт: длинный текст уходит без подписи (сохранность — через очередь отправителя).
      if (signed.length <= 150) payloadJson = signed;
    }
    const sealed = encryptBytes(chatKey, new TextEncoder().encode(payloadJson));
    const ciphertextBytes = b64ToBytes(sealed.ciphertext);
    const nonceBytes = b64ToBytes(sealed.nonce);
    // В эфир уходит готовый E2EE-конверт; temp-ключ только транспорт.
    const rpc = encodeEnvelopeRpc({
      chatRef: input.chatRef,
      chatId: input.chatId,
      // 'text:pair' — зашифровано ключом пары: Hub не хранит такую копию (не может прочитать),
      // только пересылает узлам собеседника; серверная копия придёт через outbox.
      kind: keyKind === 'pair' ? 'text:pair' : 'text',
      nonce: nonceBytes,
      ciphertext: ciphertextBytes,
    });
    const flags =
      (keyKind === 'pair'
        ? 0
        : input.toInternet || isGroup
          ? PacketFlag.TO_INTERNET | PacketFlag.NEED_CLOUD_ARCHIVE
          : PacketFlag.NEED_CLOUD_ARCHIVE) |
      (isGroup || toCluster ? 0 : PacketFlag.NEED_ACK);
    const up = encodeRpcUp(isGroup || toCluster ? BROADCAST_ID : input.peerNodeId, flags, msgUuid, rpc);
    const frame = encodeClientFrame(ClientFrameType.RPC_UP, up, this.seq++);

    if (keyKind !== 'pair') {
      // Копия под ключом пары на Hub не нужна: outbox зашифрует серверным ключом при синхронизации.
      item.ciphertextB64 = sealed.ciphertext;
      item.nonce = sealed.nonce;
    }
    item.state = 'LOCAL_MESH_ONLY';
    await kmeshV1Update(item);

    const ok = await sendFrame(frame);
    console.log('[kmesh]', 'sendText', {
      chatId: input.chatId,
      chatRef: input.chatRef,
      nodeId: this.nodeId,
      rpcLen: rpc.length,
      frameLen: frame.length,
      ok,
    });
    if (!ok) {
      item.state = 'FAILED';
      item.attempts += 1;
      await kmeshV1Update(item);
    }
    return { msgUuid: uuidHex, state: item.state };
  }

  /**
   * Hub стал доступен через шлюз KMesh (у телефона интернета нет): сообщения, ушедшие под ключом пары,
   * переотправляем под постоянным серверным ключом чата с тем же msgUuid — Hub сохранит их как обычные
   * (дедупликация по msgUuid), и у обоих собеседников появится серверная копия.
   */
  async resendPairViaGateway(): Promise<number> {
    if (!this.nodeId) return 0;
    const items = (await kmeshV1List().catch(() => [])).filter(
      (row) => !row.ciphertextB64 && row.state !== 'SYNCED_PERMANENT' && row.text,
    );
    let sent = 0;
    for (const item of items.slice(0, 5)) {
      let key = await peekServerChatKey(item.chatId).catch(() => null);
      if (!key) {
        await this.requestChatKey(item.chatId, item.chatRef).catch(() => false);
        for (let i = 0; i < 14 && !key; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          key = await peekServerChatKey(item.chatId).catch(() => null);
        }
      }
      if (!key) continue;
      const sealed = encryptBytes(key, new TextEncoder().encode(JSON.stringify({ text: item.text })));
      const rpc = encodeEnvelopeRpc({
        chatRef: item.chatRef,
        chatId: item.chatId,
        kind: 'text',
        nonce: b64ToBytes(sealed.nonce),
        ciphertext: b64ToBytes(sealed.ciphertext),
      });
      const up = encodeRpcUp(item.peerNodeId || ANY_GATEWAY_ID,
        PacketFlag.TO_INTERNET | PacketFlag.NEED_CLOUD_ARCHIVE | PacketFlag.NEED_ACK,
        msgUuidFromHex(item.msgUuid), rpc);
      const ok = await this.link.send(encodeClientFrame(ClientFrameType.RPC_UP, up, this.seq++));
      if (ok) {
        item.ciphertextB64 = sealed.ciphertext;
        item.nonce = sealed.nonce;
        item.state = 'SYNC_PENDING';
        await kmeshV1Update(item);
        sent += 1;
      }
    }
    if (sent) console.log('[kmesh]', 'pair messages re-sent with server key via gateway', sent);
    return sent;
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
              gateway?: boolean;
            };
            if (typeof info.nodeId === 'number') this.nodeId = info.nodeId >>> 0;
            this.opts.onInfo?.({
              nodeId: this.nodeId,
              role: Number(info.role ?? 0),
              mtu: Number(info.mtu ?? 0),
              queue: Number(info.queue ?? 0),
              gateway: info.gateway === true,
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
        case ClientFrameType.LOG: {
          try {
            console.log('[module]', new TextDecoder().decode(frame.payload));
          } catch {
            /* битый лог не критичен */
          }
          break;
        }
        case ClientFrameType.RPC_DOWN: {
          const packet = decodeMeshPacket(frame.payload);
          console.log('[kmesh]', 'RPC_DOWN', {
            parsed: Boolean(packet),
            op: packet ? packet.payload[0] : undefined,
            src: packet?.srcId,
            dst: packet?.dstId,
            flags: packet?.flags,
          });
          if (!packet) break;
          if (packet.flags & PacketFlag.PERM_USER_KEY) {
            /* Постоянный downlink забирается через /v1/kmesh/v1/history. */
            break;
          }
          const op = packet.payload[0];
          if (op === RpcOp.CHAT_KEY_RESP) {
            const resp = decodeChatKeyResponse(packet.payload);
            if (resp) {
              const chatId =
                this.opts.resolveChatByRef?.(resp.chatRef) ?? this.pendingKeyRefs.get(resp.chatRef);
              if (chatId) {
                this.pendingKeyRefs.delete(resp.chatRef);
                this.opts.onChatKey?.(chatId, resp.version, resp.key);
              }
            }
            break;
          }
          if (op === RpcOp.SEND_ENVELOPE) {
            const envelope = decodeEnvelopeRpc(packet.payload);
            if (envelope) {
              this.opts.onSecureMessage?.({
                msgUuid: msgUuidHex(packet.msgUuid),
                chatId: envelope.chatId,
                chatRef: envelope.chatRef,
                kind: envelope.kind,
                nonce: bytesToB64(envelope.nonce),
                ciphertext: bytesToB64(envelope.ciphertext),
                srcNodeId: packet.srcId,
              });
            }
            break;
          }
          if (op === RpcOp.LOCAL_SEARCH_REQ || op === RpcOp.LOCAL_SEARCH_RESP) {
            const local = decodeLocalSearch(packet.payload);
            if (!local || packet.srcId === this.nodeId) break;
            if (local.op === RpcOp.LOCAL_SEARCH_REQ && local.query && this.opts.onLocalSearchRequest) {
              const items = this.opts.onLocalSearchRequest(local.query);
              if (items.length) {
                const resp = encodeLocalSearchResp(local.reqId, items);
                void this.link.send(
                  encodeClientFrame(ClientFrameType.RPC_UP, encodeRpcUp(BROADCAST_ID, 0, 0n, resp), this.seq++),
                );
              }
            } else if (local.op === RpcOp.LOCAL_SEARCH_RESP && local.items) {
              this.opts.onSearch?.(
                local.reqId,
                local.items.map((item) => ({ entityId: 0, type: item.type, name: item.name })),
                false,
              );
            }
            break;
          }
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
          const handler = this.opts.onProxyUplink ?? this.proxyHandler;
          void this.addProxyBytes(frame.payload.length).then((allowed) => {
            if (allowed) handler?.(packet, frame.payload);
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

  async decryptMessage(chatId: string, ciphertextB64: string, nonceB64: string): Promise<string | null> {
    const candidates: Uint8Array[] = [];
    const server = await peekServerChatKey(chatId).catch(() => null);
    if (server) candidates.push(server);
    const pair = await pairKeyFor(chatId);
    if (pair) candidates.push(pair);
    const keys = await storage.loadKeys();
    if (keys) {
      const e2e = await loadChatKey(chatId, keys).catch(() => null);
      if (e2e) candidates.push(e2e);
    }
    if (!candidates.length) {
      try {
        candidates.push((await getServerChatKey(chatId)).key);
      } catch {
        return null;
      }
    }
    for (const key of candidates) {
      try {
        return new TextDecoder().decode(decryptBytes(key, ciphertextB64, nonceB64));
      } catch {
        /* пробуем следующий ключ */
      }
    }
    return null;
  }

  /** Локальный E2E-ключ секретного чата (с Hub не синхронизируется). */
  private async e2eKeyFor(chatId: string): Promise<Uint8Array | null> {
    const keys = await storage.loadKeys();
    if (!keys) return null;
    // Локальный ключ — сразу. loadChatKey без него ходит в сеть (ключи аккаунта/устройства):
    // без интернета эти запросы висели до таймаута, и отправка через kMesh начиналась через минуту.
    const local = (await storage.loadChatKeys().catch(() => ({}) as Record<string, string>))[chatId];
    if (local) return loadChatKey(chatId, keys).catch(() => null);
    return Promise.race([
      loadChatKey(chatId, keys).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
  }

  private async chatKeyFor(chatId: string): Promise<Uint8Array | null> {
    if (this.opts.getChatKey) return this.opts.getChatKey(chatId);
    const keys = await storage.loadKeys();
    if (!keys) return null;
    // Серверный чат: используем сохранённый ключ Hub (кэшируется при онлайне),
    // иначе KMesh-отправка офлайн была невозможна.
    const server = await peekServerChatKey(chatId).catch(() => null);
    if (server) return server;
    // E2E-чат: локальный ключ устройства.
    const e2e = await this.e2eKeyFor(chatId);
    if (e2e) return e2e;
    // Офлайн HTTP-запрос ключа может висеть десятки секунд — ограничиваем.
    // Дальше sendText сам запросит ключ через KMesh (CHAT_KEY_REQ).
    try {
      const key = await Promise.race([
        getServerChatKey(chatId).then((result) => result.key),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200)),
      ]);
      return key;
    } catch {
      return null;
    }
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
          // Ключ ещё не получен (нет сети): не помечаем FAILED, повторим позже.
          continue;
        }
        const sealed = encryptBytes(key, new TextEncoder().encode(JSON.stringify({ text: item.text })));
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
          header: {
            chatRef: item.chatRef,
            transport: 'kmesh-v1',
            ...(item.clientId ? { clientId: item.clientId } : {}),
          },
          signature,
          sig_alg: 'ecdsa-p256',
          resign_mode: 'client',
          chat_ref: item.chatRef,
        });
        item.state = 'SYNCED_PERMANENT';
        item.serverSeq = response.server_seq;
        item.permanentSignature = response.permanent_signature;
        item.attempts = 0;
        // Не удаляем сразу: обработчик статуса ищет запись, чтобы снять «отправляется» в ленте.
        // Подтверждённые записи удаляются в начале следующего прохода syncOutbox.
        await kmeshV1Update(item);
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
