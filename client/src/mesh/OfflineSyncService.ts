/**
 * OfflineSyncService — подписанный батчевый flush офлайн-очереди.
 *
 * Каждый элемент outbox превращается в пакет, подписанный временным ключом
 * (ESK), и отправляется на сервер одним запросом. Сервер проверяет подпись,
 * переподписывает сообщения постоянным ключом пользователя и сообщает, какие
 * clientId приняты, а какие отклонены. После полного успеха ESK уничтожается.
 *
 * Сервис никогда не бросает исключений: все ошибки возвращаются в результате.
 */
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { listOutbox } from '../data/db';
import { api } from '../data/api';
import { destroyEphemeralKey, hasEphemeralKey, signOfflineDigest } from './OfflineCryptoService';

export const SIGNED_OFFLINE_BATCH_SIZE = 20;

export interface OfflinePacketPayload {
  clientId: string;
  chatId: string;
  createdAt: string;
  kind: string;
}

export interface SignedOfflineBatchPacket {
  clientId: string;
  chatId: string;
  createdAt: string;
  payloadHash: string;
  ephemeralPubkey: string;
  signature: string;
}

export interface OfflineBatchRejection {
  clientId: string;
  reason: string;
}

export interface SignedOfflineFlushResult {
  /** Сколько пакетов было подготовлено и отправлено. */
  flushed: number;
  /** Сколько пакетов сервер принял. */
  accepted: number;
  /** Сколько пакетов сервер отклонил. */
  rejected: number;
  /** Причины отклонения / локальные ошибки. */
  errors: OfflineBatchRejection[];
  /** Уничтожен ли временный ключ после полного успеха. */
  destroyedKey: boolean;
  /** Доступна ли сеть на момент вызова. */
  online: boolean;
}

export interface SignedOfflineBatchSize {
  outbox: number;
  hasKey: boolean;
}

let flushing: Promise<SignedOfflineFlushResult> | null = null;

function isOnline(): boolean {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
  } catch {
    /* окружение без navigator — считаем сеть доступной */
  }
  return true;
}

function payloadHashOf(payload: OfflinePacketPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return bytesToHex(sha256(bytes));
}

function emptyResult(): SignedOfflineFlushResult {
  return { flushed: 0, accepted: 0, rejected: 0, errors: [], destroyedKey: false, online: true };
}

/**
 * Подписывает и отправляет до 20 элементов outbox одним батчем.
 * Повторный вызов во время отправки возвращает текущий промис.
 */
export async function flushSignedOfflineBatch(): Promise<SignedOfflineFlushResult> {
  if (flushing) return flushing;

  flushing = (async (): Promise<SignedOfflineFlushResult> => {
    const online = isOnline();
    if (!online) {
      return {
        flushed: 0,
        accepted: 0,
        rejected: 0,
        errors: [{ clientId: '', reason: 'offline' }],
        destroyedKey: false,
        online: false,
      };
    }

    let items: Awaited<ReturnType<typeof listOutbox>>;
    try {
      items = await listOutbox();
    } catch (error) {
      return {
        ...emptyResult(),
        errors: [{ clientId: '', reason: `outbox_unavailable: ${errorMessage(error)}` }],
      };
    }

    const batch = items.slice(0, SIGNED_OFFLINE_BATCH_SIZE);
    if (!batch.length) {
      return { ...emptyResult(), online };
    }

    const packets: SignedOfflineBatchPacket[] = [];
    const localErrors: OfflineBatchRejection[] = [];

    for (const item of batch) {
      const clientId = item.clientId ?? item.id;
      try {
        const payload: OfflinePacketPayload = {
          clientId,
          chatId: item.chatId,
          createdAt: item.createdAt,
          kind: item.kind,
        };
        const payloadHash = payloadHashOf(payload);
        const signed = await signOfflineDigest(payloadHash);
        packets.push({
          clientId,
          chatId: payload.chatId,
          createdAt: payload.createdAt,
          payloadHash,
          ephemeralPubkey: signed.ephemeralPubkey,
          signature: signed.signature,
        });
      } catch (error) {
        localErrors.push({ clientId, reason: `sign_failed: ${errorMessage(error)}` });
      }
    }

    if (!packets.length) {
      return { ...emptyResult(), rejected: localErrors.length, errors: localErrors, online };
    }

    let accepted = 0;
    const errors: OfflineBatchRejection[] = [...localErrors];

    try {
      const response = await api.flushOfflineBatch(packets);
      accepted = typeof response?.accepted === 'number' ? response.accepted : 0;
      if (Array.isArray(response?.rejected)) {
        for (const rejection of response.rejected) {
          errors.push({
            clientId: rejection?.clientId ?? '',
            reason: rejection?.reason ?? 'rejected',
          });
        }
      }
    } catch (error) {
      errors.push({ clientId: '', reason: `flush_failed: ${errorMessage(error)}` });
    }

    const rejected = Math.max(packets.length - accepted, 0) + localErrors.length;
    let destroyedKey = false;

    if (accepted === packets.length) {
      let outboxEmpty = false;
      try {
        outboxEmpty = (await listOutbox()).length === 0;
      } catch {
        outboxEmpty = false;
      }
      if (outboxEmpty) {
        try {
          await destroyEphemeralKey();
          destroyedKey = true;
        } catch (error) {
          errors.push({ clientId: '', reason: `destroy_key_failed: ${errorMessage(error)}` });
        }
      }
    }

    return {
      flushed: packets.length,
      accepted,
      rejected,
      errors,
      destroyedKey,
      online: isOnline(),
    };
  })()
    .catch((error): SignedOfflineFlushResult => ({
      ...emptyResult(),
      errors: [{ clientId: '', reason: `unexpected: ${errorMessage(error)}` }],
    }))
    .finally(() => {
      flushing = null;
    });

  return flushing;
}

/** Текущая глубина outbox и наличие временного ключа. */
export async function signedOfflineBatchSize(): Promise<SignedOfflineBatchSize> {
  const [outbox, hasKey] = await Promise.all([
    listOutbox()
      .then((items) => items.length)
      .catch(() => 0),
    hasEphemeralKey().catch(() => false),
  ]);
  return { outbox, hasKey };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
