/**
 * Механика сообщений: каждая отправка шифруется на устройстве, конверт кладётся
 * напрямую на 3 реплики узлов (init → PUT → commit) и регистрируется в Hub.
 * Если связь недоступна — сообщение остаётся в локальной очереди и будет
 * доставлено автоматически.
 */
import * as api from './api';
import type { Chat, ChatEncryption, Envelope, MessageReaction } from './api';
import {
  decryptPayload,
  encryptForChat,
  getServerChatKey,
  loadChatKey,
  topUpAllKeys,
  type ChatEnvelopeHeader,
  type MessagePayload,
} from './chatkit';
import { uploadEnvelope, downloadObject } from './chatkit';
import {
  decryptFileBytes,
  encryptFileBytes,
  fromB64u,
  toB64u,
  toB64,
  storage,
  type DeviceKeys,
} from '../crypto/core';
import { dbGet, dbSet, enqueueOutbox, listOutbox, removeOutbox, updateOutboxState, type OutboxItem } from './db';
import { compressImage, uploadBytesWithProgress, type UploadStage } from './uploader';
import { sendViaMesh, canSendViaMesh, isMeshCongested } from '../modules/meshLink';
import { loadCachedMessages } from './cache';
import { useStore } from '../state/useStore';

/**
 * Политика трафика: без интернета медиа можно отправить только через mesh
 * и только если сеть модулей не перегружена.
 */
function assertMediaTransport(): void {
  const online = useStore.getState().transportOnline;
  if (online) return;
  if (!canSendViaMesh()) {
    throw new Error('Нет связи с сервером. Подключите носимый модуль или дождитесь сети.');
  }
  if (isMeshCongested()) {
    throw new Error('Сеть модулей сейчас загружена — медиа отправить нельзя. Текст и поиск работают.');
  }
}

export type { OutboxItem } from './db';

export interface ViewMessage {
  id: string;
  seq: number;
  senderUsername: string;
  mine: boolean;
  createdAt: string;
  kind: string;
  text?: string;
  file?: MessagePayload['file'];
  imageUri?: string;
  replyTo?: string | null;
  edited?: boolean;
  reactions?: MessageReaction[];
  scheme?: 'server' | 'e2e';
  commentsCount?: number;
  delivered: boolean;
  failed: boolean;
  pending: boolean;
  /* ---- оптимистичная отправка (локальные данные, сервер их не присылает) ---- */
  /** Идентификатор сообщения, сгенерированный на клиенте до ответа сервера. */
  clientId?: string;
  /** Общий прогресс загрузки медиа 0..1. */
  uploadProgress?: number;
  /** Текущий этап загрузки; null — загрузка завершена/не медиа. */
  uploadStage?: UploadStage | null;
  /** Локальный data URI превью (web) до расшифровки серверного файла. */
  localPreview?: string;
  /** Пост опубликован от имени канала (композер канала). */
  asChannel?: boolean;
  /** Просмотры поста канала (приходит с конвертом). */
  viewsCount?: number;
  /* ---- системные сообщения о событиях группы (kind='system') ---- */
  /** Кто совершил действие (для акцента в тексте). */
  systemActor?: string;
  /** Второй участник события: пригласивший или исключённый. */
  systemTarget?: string;
  /** Тип события участника группы. */
  systemEvent?: string;
}

/** Колбэки прогресса отправки медиа (экран держит их в своём состоянии). */
export interface AttachProgressCallbacks {
  onStage?: (stage: UploadStage) => void;
  onProgress?: (progress: number) => void;
  onPreview?: (dataUri: string) => void;
  onDone?: (message: ViewMessage) => void;
  onError?: (error: Error) => void;
}

export interface AttachSendOptions {
  replyTo?: string;
  clientId?: string;
  signal?: AbortSignal;
  /** Сжать как аватар (меньше maxDim). */
  avatar?: boolean;
  /** Опубликовать от имени канала (для owner/admin/mod с правом publish). */
  asChannel?: boolean;
}

export type SendState = 'boxSending' | 'boxSent' | 'boxDelivered' | 'boxFailed';

async function requireKeys(): Promise<DeviceKeys | null> {
  return storage.loadKeys();
}

function fromB64(b64: string): Uint8Array {
  const bin = atobCompat(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function atobCompat(s: string): string {
  if (typeof atob === 'function') return atob(s);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = alphabet.indexOf(clean[i]);
    const c1 = alphabet.indexOf(clean[i + 1]);
    const c2 = alphabet.indexOf(clean[i + 2]);
    const c3 = alphabet.indexOf(clean[i + 3]);
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) out.push(((c1 & 15) << 4) | (c2 >> 2));
    if (c3 >= 0) out.push(((c2 & 3) << 6) | c3);
  }
  return out.map((n) => String.fromCharCode(n)).join('');
}

/* ---------------------------------------------------------------- отправка */

export async function sendMessage(
  chatId: string,
  payload: MessagePayload,
  kind: string,
  myUsername: string,
  opts: {
    replyTo?: string;
    clientId?: string;
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
    /** Опубликовать от имени канала. */
    asChannel?: boolean;
  } = {},
): Promise<ViewMessage> {
  const clientId = opts.clientId ?? `loc-${Math.random().toString(16).slice(2, 10)}-${Date.now()}`;
  if (opts.signal?.aborted) throw abortError();
  const keys = await requireKeys();
  if (!keys) {
    return localFallback(chatId, payload, kind, myUsername, 'нет ключей устройства', clientId);
  }

  // режим чата определяет схему шифрования; без сети сохраняем прежний E2E-режим,
  // если для чата уже есть локальный ключ
  let chat: Chat | null = null;
  try {
    chat = await api.api.getChat(chatId);
  } catch {
    chat = null;
  }
  let encryption: ChatEncryption = chat?.encryption === 'e2e' ? 'e2e' : 'server';
  if (!chat) {
    const local = await loadChatKey(chatId, keys).catch(() => null);
    if (local) encryption = 'e2e';
  }

  let encrypted: { ciphertext: string; nonce: string; header: ChatEnvelopeHeader };
  try {
    encrypted = await encryptForChat({ id: chatId, encryption }, payload, keys);
  } catch {
    return localFallback(chatId, payload, kind, myUsername, 'ключ чата ещё не получен', clientId);
  }

  const { ciphertext, nonce, header } = encrypted;
  const bytes = fromB64u(ciphertext);
  const createdAt = new Date().toISOString();
  const headerObj: ChatEnvelopeHeader = {
    ...header,
    clientId,
    ...(opts.asChannel ? ({ asChannel: true } as object) : {}),
  };

  const draft: ViewMessage = {
    id: clientId,
    seq: Number.MAX_SAFE_INTEGER,
    senderUsername: myUsername,
    mine: true,
    createdAt,
    kind,
    text: payload.text,
    file: payload.file,
    replyTo: opts.replyTo ?? null,
    scheme: header.scheme,
    reactions: [],
    delivered: false,
    failed: false,
    pending: true,
    clientId,
    asChannel: opts.asChannel,
  };

  const item: Omit<OutboxItem, 'state' | 'attempts'> & {
    senderUserId?: string;
    senderUsername?: string;
    text?: string;
    file?: unknown;
    replyTo?: string;
  } = {
    id: clientId,
    chatId,
    objectId: '',
    nonce,
    header: JSON.stringify({ ...headerObj, ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) }),
    kind,
    createdAt,
    clientId,
    envelopeB64: ciphertext,
    // Для mesh-получателя: без Hub он не знает автора иначе.
    senderUserId: api.getSession()?.userId,
    senderUsername: myUsername,
    text: payload.text,
    file: payload.file,
    replyTo: opts.replyTo,
  };

  try {
    // Нет интернета, но модуль подключён — не ждём HTTP-таймаут, сразу mesh.
    if (canSendViaMesh() && !useStore.getState().transportOnline) {
      throw new Error('offline_mesh');
    }
    const uploaded = await uploadEnvelope(bytes, {
      onProgress: opts.onProgress ? (p) => opts.onProgress?.(Math.max(0, Math.min(1, p))) : undefined,
      signal: opts.signal,
    });
    item.objectId = uploaded.objectId;
    if (opts.signal?.aborted) throw abortError();
    const saved = await api.api.sendMessage(chatId, {
      objectId: uploaded.objectId,
      nonce,
      header: headerObj,
      kind,
      clientId,
      replyTo: opts.replyTo,
      // Поле контракта data-слоя: публикация от имени канала.
      ...(opts.asChannel ? { asChannel: true } : {}),
      // Короткий предпросмотр для push (только для текста, не для E2E-секретов).
      ...(kind === 'text' ? { pushText: String(payload.text ?? '').slice(0, 300) } : {}),
    } as never);
    // Hub обязан вернуть сохранённое сообщение с id/seq. Иначе это не доставка.
    if (!saved || typeof (saved as { id?: unknown }).id !== 'string' || !Number.isFinite(Number((saved as { seq?: unknown }).seq))) {
      throw new Error('message_not_registered');
    }
    await removeOutbox(clientId);
    return {
      ...draft,
      id: (saved as { id: string }).id,
      seq: Number((saved as { seq: number }).seq),
      createdAt: (saved as { createdAt?: string }).createdAt ?? createdAt,
      delivered: true,
      pending: false,
      clientId,
    };
  } catch (e) {
    // отмена пользователем не должна попадать в офлайн-очередь
    if (opts.signal?.aborted) throw abortError();
    void e;
    // Нет интернета, но подключён модуль — отдаём шифротекст в USB/BLE mesh.
    const viaMesh = await sendViaMesh(chatId, item);
    if (viaMesh) {
      // Оставляем сообщение в очереди: получатель уже увидел его через mesh,
      // но Hub ещё не знает о нём. При появлении интернета оно уйдёт на сервер
      // (идемпотентно по clientId), и история не потеряется после перезапуска.
      await enqueueOutbox(item).catch(() => undefined);
      return { ...draft, delivered: false, pending: true, clientId };
    }
    // связь недоступна (нет интернета и модуля): держим шифротекст в очереди
    item.objectId = '';
    await enqueueOutbox(item);
    return { ...draft, delivered: false, pending: true, failed: false, clientId };
  }
}

async function localFallback(
  chatId: string,
  payload: MessagePayload,
  kind: string,
  myUsername: string,
  reason: string,
  clientId?: string,
): Promise<ViewMessage> {
  void chatId; void payload; void kind; void reason; void clientId;
  return {
    id: clientId ?? `local-${Date.now()}`,
    seq: 0,
    senderUsername: myUsername,
    mine: true,
    createdAt: new Date().toISOString(),
    kind,
    // Ключей устройства нет — сообщение остаётся в ленте без красной ошибки,
    // отправим после синхронизации ключей.
    failed: false,
    delivered: false,
    pending: true,
    clientId,
  };
}

function abortError(): Error {
  const err = new Error('upload_aborted');
  (err as Error & { name: string }).name = 'AbortError';
  return err;
}

/** Ретрай накопленных сообщений — вызывается из транспорта при появлении связи. */
export async function flushOutbox(myUsername: string): Promise<ViewMessage[]> {
  const keys = await requireKeys();
  if (!keys) return [];
  const items = await listOutbox();
  const out: ViewMessage[] = [];

  for (const item of items) {
    try {
      const ciphertext = item.objectId.startsWith('encrypted:') ? item.objectId.slice('encrypted:'.length) : item.envelopeB64;
      const bytes = fromB64u(ciphertext);
      const uploaded = await uploadEnvelope(bytes);
      // header из очереди уже содержит scheme/keyVersion/nonce/clientId
      const parsed = parseHeader(item.header);
      const queuedReplyTo = typeof parsed.replyTo === 'string' ? parsed.replyTo : undefined;
      const { replyTo: _queuedReplyTo, ...restHeader } = parsed;
      void _queuedReplyTo;
      const header: ChatEnvelopeHeader = {
        scheme: restHeader.scheme === 'server' ? 'server' : 'e2e',
        ...(typeof restHeader.keyVersion === 'number' ? { keyVersion: restHeader.keyVersion } : {}),
        nonce: item.nonce,
        clientId: item.clientId,
      };
      await api.api.sendMessage(item.chatId, {
        objectId: uploaded.objectId,
        nonce: item.nonce,
        header,
        kind: item.kind,
        clientId: item.clientId,
        replyTo: queuedReplyTo,
        ...(parsed.asChannel === true ? { asChannel: true } : {}),
        ...(item.kind === 'text' && typeof (item as { text?: unknown }).text === 'string'
          ? { pushText: String((item as { text?: string }).text).slice(0, 300) }
          : {}),
      } as never);
      await removeOutbox(item.id);
      out.push({
        id: item.clientId,
        seq: Number.MAX_SAFE_INTEGER,
        senderUsername: myUsername,
        mine: true,
        createdAt: item.createdAt,
        kind: item.kind,
        delivered: true,
        failed: false,
        pending: false,
        clientId: item.clientId,
      });
    } catch {
      await updateOutboxState(item.id, 'failed', item.attempts + 1);
    }
  }
  return out;
}

export async function outboxCount(): Promise<number> {
  return (await listOutbox()).length;
}

/* -------------------------------------------------------------- получение */

function parseHeader(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface EnvelopeMeta {
  scheme: 'server' | 'e2e';
  keyVersion?: number;
  edited: boolean;
  replyTo: string | null;
  reactions: MessageReaction[];
}

/** Схема/версия/признак правки: старые конверты без scheme читаются как E2E. */
function envelopeMeta(env: Envelope): EnvelopeMeta {
  const h = parseHeader(env.header);
  const scheme: 'server' | 'e2e' = env.scheme ?? (h.scheme === 'server' ? 'server' : 'e2e');
  let keyVersion = env.keyVersion;
  if (keyVersion === undefined && h.keyVersion !== undefined) {
    const n = Number(h.keyVersion);
    if (Number.isFinite(n)) keyVersion = n;
  }
  const replyTo = env.replyTo ?? (typeof h.replyTo === 'string' ? h.replyTo : null);
  return {
    scheme,
    keyVersion,
    edited: env.edited ?? h.edited === true,
    replyTo,
    reactions: env.reactions ?? [],
  };
}

async function decryptWithKey(env: Envelope, rawKey: Uint8Array | null, myUsername: string): Promise<ViewMessage> {
  const meta = envelopeMeta(env);
  // clientId может прийти полем конверта или из header — нужен для склейки
  // с оптимистичным сообщением без дублей.
  const envHeader = parseHeader(env.header);
  const clientId = env.clientId ?? (typeof envHeader.clientId === 'string' ? envHeader.clientId : undefined);
  const envExt = env as Envelope & { asChannel?: boolean; viewsCount?: number };
  const common = {
    id: env.id,
    seq: env.seq,
    clientId,
    senderUsername: env.senderUsername,
    mine: env.senderUsername === myUsername,
    createdAt: env.createdAt,
    kind: env.kind,
    replyTo: meta.replyTo,
    edited: meta.edited,
    reactions: meta.reactions,
    scheme: meta.scheme,
    commentsCount: env.commentsCount,
    asChannel: envExt.asChannel === true || envHeader.asChannel === true,
    viewsCount: envExt.viewsCount,
  };
  // Системное сообщение (или конверт без объекта) нечего скачивать с узлов:
  // текст лежит открытым в header. UI рисует его отдельной центрированной строкой.
  if (env.kind === 'system' || !env.objectId) {
    const systemText = typeof envHeader.systemText === 'string' ? envHeader.systemText : '';
    return {
      ...common,
      kind: 'system',
      text: systemText,
      systemActor: typeof envHeader.actorUsername === 'string' ? envHeader.actorUsername : undefined,
      systemTarget: typeof envHeader.targetUsername === 'string' ? envHeader.targetUsername : undefined,
      systemEvent: typeof envHeader.event === 'string' ? envHeader.event : undefined,
      delivered: true,
      failed: false,
      pending: false,
    };
  }
  if (!rawKey) {
    return { ...common, text: '', delivered: true, failed: true, pending: false };
  }
  const bytes = env.envelopeB64
    ? fromB64u(env.envelopeB64)
    : await downloadObject(env.objectId);
  // внимание: decryptPayload ожидает стандартный base64 (toB64), не base64url —
  // иначе fromB64 отбрасывает '-'/'_' и шифротекст повреждается.
  const payload = bytes ? await decryptPayload(rawKey, toB64(bytes), env.nonce) : null;
  return {
    ...common,
    text: payload?.text ?? '',
    file: payload?.file,
    delivered: true,
    failed: !payload,
    pending: false,
  };
}

/** Старая сигнатура: расшифровка заранее полученным ключом (E2E). */
export async function decryptEnvelope(
  env: Envelope,
  rawKey: Uint8Array,
  myUsername: string,
): Promise<ViewMessage> {
  return decryptWithKey(env, rawKey, myUsername);
}

/**
 * Расшифровка с авто-выбором схемы: серверный ключ тянется с Hub (и кэшируется),
 * E2E-ключ — из локального хранилища устройства.
 */
export async function decryptEnvelopeAuto(env: Envelope, chat: Chat, myUsername: string): Promise<ViewMessage> {
  const meta = envelopeMeta(env);
  let rawKey: Uint8Array | null = null;
  try {
    if (meta.scheme === 'server') {
      rawKey = (await getServerChatKey(chat.id, meta.keyVersion)).key;
    } else {
      const keys = await requireKeys();
      rawKey = keys ? await loadChatKey(chat.id, keys) : null;
    }
  } catch {
    rawKey = null;
  }
  return decryptWithKey(env, rawKey, myUsername);
}

export async function loadChatMessages(chat: Chat, myUsername: string, limit = 60): Promise<ViewMessage[]> {
  const keys = await requireKeys();
  // Ошибку сети не глотаем: вызывающий слой подставит сохранённую ленту,
  // а не затрёт кэш пустым массивом.
  const envs = await api.api.listMessages(chat.id, { limit });
  const meId = await currentUserId();
  const out: ViewMessage[] = [];
  for (const env of envs) {
    out.push(await decryptEnvelopeAuto(env, chat, myUsername));
    if (env.senderUserId && env.senderUserId !== meId) {
      await api.api.postReceipt(chat.id, env.id).catch(() => undefined);
    }
  }

  // серверные ключи не требуют локального E2E-ключа; topUp делаем только для E2E
  const hasE2e = envs.some((env) => envelopeMeta(env).scheme === 'e2e');
  if (hasE2e && keys) {
    const rawKey = await loadChatKey(chat.id, keys);
    if (rawKey) await topUpAllKeys(chat.id, rawKey);
    else await dbSet('chatKey_missing:' + chat.id, '1');
  }

  // Локальные сообщения, которые ещё не подтверждены Hub (отправлены через
  // mesh, лежат в очереди или не успели уйти), обязаны оставаться в ленте
  // после повторного входа в чат. Раньше refetch затирал их кэшем сервера.
  const confirmedClients = new Set(out.map((m) => m.clientId).filter((v): v is string => Boolean(v)));
  const serverIds = new Set(out.map((m) => m.id));
  const pending: ViewMessage[] = [];
  try {
    for (const item of await listOutbox()) {
      if (item.chatId !== chat.id || !item.clientId || confirmedClients.has(item.clientId)) continue;
      const extra = item as OutboxItem & { text?: string; file?: ViewMessage['file']; replyTo?: string };
      pending.push({
        id: item.clientId,
        clientId: item.clientId,
        seq: 0,
        senderUsername: myUsername,
        mine: true,
        createdAt: item.createdAt,
        kind: item.kind,
        text: extra.text,
        file: extra.file,
        replyTo: extra.replyTo ?? null,
        scheme: 'server',
        reactions: [],
        delivered: false,
        pending: true,
        failed: item.state === 'failed',
      });
    }
  } catch {
    /* очередь недоступна — не мешаем истории */
  }
  // Плюс оптимистичные сообщения из локального кэша, которых уже нет в
  // очереди (например, отправленные через mesh и ожидающие синхронизации).
  const cached = (await loadCachedMessages(chat.id).catch(() => null)) as ViewMessage[] | null;
  if (Array.isArray(cached)) {
    for (const m of cached) {
      if (!m || (!m.pending && !m.failed && m.seq > 0)) continue;
      if (m.clientId && confirmedClients.has(m.clientId)) continue;
      if (m.id && serverIds.has(m.id)) continue;
      if (pending.some((p) => p.clientId && p.clientId === m.clientId)) continue;
      pending.push({ ...m, pending: true, delivered: false });
    }
  }
  if (!pending.length) return out;
  return [...out, ...pending].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/* ------------------------------------------------------- поиск сообщений -- */

export interface MessageSearchHit {
  chatId: string;
  chatTitle: string;
  message: ViewMessage;
}

/**
 * Клиентский поиск по сообщениям без серверной индексации.
 * Просматривает последние `limitPerChat` сообщений каждого чата (по умолчанию 40),
 * расшифровывая их на устройстве. Квитанции не отправляются, ключи не
 * доливаются, в БД ничего не пишется. Ошибка одного чата не мешает остальным.
 */
export async function searchMessagesAcrossChats(
  chats: { id: string; title: string }[],
  query: string,
  myUsername: string,
  limitPerChat = 40,
): Promise<MessageSearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const maxResults = 50;
  const limit = Math.max(1, Math.min(200, Math.floor(limitPerChat)));
  const hits: MessageSearchHit[] = [];

  for (const chat of chats) {
    if (hits.length >= maxResults) break;
    try {
      const envs = await api.api.listMessages(chat.id, { limit });
      // decryptEnvelopeAuto использует только id чата (для ключей),
      // поэтому достаточно минимального объекта Chat.
      const chatStub = { id: chat.id, encryption: 'server' } as Chat;
      for (const env of envs) {
        if (hits.length >= maxResults) break;
        try {
          const message = await decryptEnvelopeAuto(env, chatStub, myUsername);
          const textMatch = (message.text ?? '').toLowerCase().includes(needle);
          const fileMatch = (message.file?.name ?? '').toLowerCase().includes(needle);
          if (textMatch || fileMatch) {
            hits.push({ chatId: chat.id, chatTitle: chat.title, message });
          }
        } catch {
          // отдельное сообщение не расшифровалось — пропускаем
        }
      }
    } catch {
      // чат недоступен/не расшифровался — продолжаем поиск по остальным
    }
  }

  // Свежие находки сверху.
  hits.sort((a, b) => new Date(b.message.createdAt).getTime() - new Date(a.message.createdAt).getTime());
  return hits;
}

/* ------------------------------------------------------- редактирование --- */

/** Отредактировать своё сообщение: новый конверт + тот же режим шифрования. */
export async function editMessage(
  chatId: string,
  messageId: string,
  payload: MessagePayload,
  myUsername: string,
): Promise<void> {
  void myUsername;
  const keys = await requireKeys();
  if (!keys) throw new Error('device_keys_missing');
  const chat = await api.api.getChat(chatId);
  const { ciphertext, nonce, header } = await encryptForChat(
    { id: chat.id, encryption: chat.encryption === 'e2e' ? 'e2e' : 'server' },
    payload,
    keys,
  );
  const uploaded = await uploadEnvelope(fromB64u(ciphertext));
  await api.api.editMessage(chatId, messageId, { objectId: uploaded.objectId, nonce, header });
}

export async function currentUserId(): Promise<string | null> {
  const s = api.getSession();
  return s?.userId ?? null;
}

export function envelopeToView(
  env: Envelope,
  payload: MessagePayload | null,
  myUsername: string,
): ViewMessage {
  return {
    id: env.id,
    seq: env.seq,
    senderUsername: env.senderUsername,
    mine: env.senderUsername === myUsername,
    createdAt: env.createdAt,
    kind: env.kind,
    text: payload?.text ?? '',
    file: payload?.file,
    delivered: true,
    failed: !payload,
    pending: false,
    clientId: env.clientId ?? undefined,
  };
}

/* ------------------------------------------------------------------- файлы */

/** Небольшой data URI для мгновенного превью в web/нативном Image. */
function bytesToDataUri(bytes: Uint8Array, mime: string): string | undefined {
  if (!mime.toLowerCase().startsWith('image/')) return undefined;
  if (typeof btoa !== 'function') return undefined;
  try {
    const max = 1_200_000;
    const slice = bytes.length > max ? bytes.subarray(0, max) : bytes;
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < slice.length; i += chunk) {
      const part = slice.subarray(i, i + chunk);
      for (let j = 0; j < part.length; j += 1) binary += String.fromCharCode(part[j]);
    }
    return `data:${mime};base64,${btoa(binary)}`;
  } catch {
    return undefined;
  }
}

/**
 * Отправка медиа с оптимистичным превью и прогрессом:
 * сжатие → шифрование → раскладка по узлам → регистрация сообщения.
 * Сжатие всегда до шифрования, поэтому E2EE не страдает.
 */
export async function attachAndSendWithProgress(
  chatId: string,
  file: { bytes: Uint8Array; name: string; mime: string },
  myUsername: string,
  opts: AttachSendOptions = {},
  callbacks: AttachProgressCallbacks = {},
): Promise<ViewMessage> {
  try {
    assertMediaTransport();
    if (opts.signal?.aborted) throw abortError();
    callbacks.onStage?.('compress');
    callbacks.onProgress?.(0);
    const originalPreview = bytesToDataUri(file.bytes, file.mime);
    if (originalPreview) callbacks.onPreview?.(originalPreview);

    let compressed: { bytes: Uint8Array; mime: string } = { bytes: file.bytes, mime: file.mime };
    if (file.mime.toLowerCase().startsWith('image/')) {
      try {
        const res = await compressImage(file.bytes, file.mime, { avatar: opts.avatar });
        compressed = { bytes: res.bytes, mime: res.mime };
        // Превью из сжатых байтов меньше по размеру — обновляем, если получилось.
        if (res.bytes !== file.bytes) {
          const preview = bytesToDataUri(res.bytes, res.mime);
          if (preview) callbacks.onPreview?.(preview);
        }
      } catch {
        // не удалось сжать — отправляем оригинал
        compressed = { bytes: file.bytes, mime: file.mime };
      }
    }
    if (opts.signal?.aborted) throw abortError();
    callbacks.onProgress?.(0.15);

    callbacks.onStage?.('encrypt');
    const encrypted = encryptFileBytes(compressed.bytes);
    if (opts.signal?.aborted) throw abortError();
    callbacks.onProgress?.(0.25);

    const uploaded = await uploadBytesWithProgress(encrypted.bytes, {
      onStage: (stage) => callbacks.onStage?.(stage),
      onProgress: (progress) => callbacks.onProgress?.(progress),
      signal: opts.signal,
    });

    // payload с размерами уже сжатого файла; конверт сообщения грузится
    // существующим путём sendMessage — повторной загрузки файла нет.
    const payload: MessagePayload = {
      text: '',
      file: {
        id: uploaded.objectId,
        key: toB64u(encrypted.rawKey),
        name: file.name,
        mime: compressed.mime,
        size: compressed.bytes.length,
      },
    };
    const message = await sendMessage(chatId, payload, 'media', myUsername, {
      replyTo: opts.replyTo,
      clientId: opts.clientId,
      signal: opts.signal,
      asChannel: opts.asChannel,
    });
    callbacks.onDone?.(message);
    return message;
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    callbacks.onError?.(err);
    throw err;
  }
}

export async function attachAndSend(
  chatId: string,
  fileBytes: Uint8Array,
  fileName: string,
  mime: string,
  myUsername: string,
): Promise<ViewMessage> {
  assertMediaTransport();
  const encrypted = encryptFileBytes(fileBytes);
  const uploaded = await uploadEnvelope(encrypted.bytes);
  return sendMessage(
    chatId,
    {
      text: '',
      file: { id: uploaded.objectId, key: toB64u(encrypted.rawKey), name: fileName, mime, size: encrypted.size },
    },
    'media',
    myUsername,
  );
}

export async function openMessageFile(vm: ViewMessage): Promise<{ bytes: Uint8Array; mime: string; name: string } | null> {
  if (!vm.file) return null;
  const bytes = await downloadObject(vm.file.id);
  if (!bytes) return null;
  const plain = decryptFileBytes(fromB64u(vm.file.key), bytes);
  return { bytes: plain, mime: vm.file.mime, name: vm.file.name };
}

export const dbHelpers = { dbGet, dbSet };
