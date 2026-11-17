/**
 * Мост между приложением и подключённым модулем.
 *
 * Когда интернет недоступен, messaging.ts кладёт шифротекст в модуль
 * (USB/BLE → mesh). Входящие mesh-конверты ModuleProvider отдаёт сюда,
 * а RealtimeBridge обрабатывает их так же, как WebSocket-события.
 */
import type { Envelope } from '../data/api';

type MeshSender = (chatId: string, envelope: unknown) => Promise<void>;
type MeshV1Sender = (chatId: string, text: string, clientId?: string) => Promise<boolean>;
type MeshListener = (envelope: Envelope) => void;

let sender: MeshSender | null = null;
let v1Sender: MeshV1Sender | null = null;
const listeners = new Set<MeshListener>();
/** Текст, отправленный во время переподключения: уйдёт, как только модуль будет готов. */
const pendingV1: Array<{ chatId: string; text: string; clientId?: string; attempts: number; paused?: boolean }> = [];
/** После стольких неудач перестаём долбить модуль: сообщение остаётся в outbox. */
const MAX_V1_ATTEMPTS = 3;
const giveUpListeners = new Set<(item: { chatId: string; text: string; clientId?: string }) => void>();

/** Подписка на отказ от повторной отправки (UI снимает «Подготовка KMesh…»). */
export function onMeshTextGaveUp(
  listener: (item: { chatId: string; text: string; clientId?: string }) => void,
): () => void {
  giveUpListeners.add(listener);
  return () => giveUpListeners.delete(listener);
}

function giveUp(item: { chatId: string; text: string; clientId?: string }): void {
  console.warn('[kmesh]', 'text send gave up, kept in outbox', item.chatId);
  for (const listener of giveUpListeners) {
    try {
      listener(item);
    } catch {
      /* ignore */
    }
  }
}
let flushingV1 = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;

async function flushV1Queue(): Promise<void> {
  if (!v1Sender || flushingV1) return;
  flushingV1 = true;
  try {
    while (pendingV1.length) {
      const item = pendingV1.find((entry) => !entry.paused);
      if (!item) break;
      try {
        const ok = await v1Sender(item.chatId, item.text, item.clientId);
        if (!ok) {
          item.attempts += 1;
          if (item.attempts >= MAX_V1_ATTEMPTS) {
            // Не выбрасываем: ждём нового подключения модуля (setMeshV1Sender).
            item.paused = true;
            giveUp(item);
            continue;
          }
          break;
        }
        pendingV1.splice(pendingV1.indexOf(item), 1);
        console.log('[kmesh]', 'queued text sent', item.chatId);
      } catch {
        item.attempts += 1;
        if (item.attempts >= MAX_V1_ATTEMPTS) {
          item.paused = true;
          giveUp(item);
          continue;
        }
        break;
      }
    }
  } finally {
    flushingV1 = false;
  }
}

function ensureFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    if (!v1Sender || !pendingV1.length) return;
    void flushV1Queue();
  }, 4000);
}

/** Возможности mesh на текущем подключении (для политики трафика). */
let capabilities = { connected: false, gateway: false, queue: 0, neighbors: 0 };

export function setMeshCapabilities(next: Partial<typeof capabilities>): void {
  capabilities = { ...capabilities, ...next };
}

export function getMeshCapabilities(): typeof capabilities {
  return capabilities;
}

/** Перегружена ли сеть модулей: медиа в таком состоянии не отправляем. */
export function isMeshCongested(queueThreshold = 150): boolean {
  return capabilities.connected && capabilities.queue > queueThreshold;
}

/** Установить/снять активный транспорт модуля (вызывает ModuleProvider). */
export function setMeshSender(next: MeshSender | null): void {
  sender = next;
}

/** Бинарный KMesh_v1: приоритетнее legacy-конвертов. */
export function setMeshV1Sender(next: MeshV1Sender | null): void {
  v1Sender = next;
  if (next) {
    // Новое подключение модуля: приостановленные тексты пробуем заново.
    for (const item of pendingV1) {
      item.paused = false;
      item.attempts = 0;
    }
    ensureFlushTimer();
    void flushV1Queue();
  }
}

export function canSendViaMesh(): boolean {
  return sender !== null || v1Sender !== null || pendingV1.length > 0;
}

/** Отправка текста только через KMesh_v1 (без legacy-конверта). */
export async function sendTextViaMesh(
  chatId: string,
  text: string,
  clientId?: string,
): Promise<boolean> {
  if (!text) return false;
  if (!v1Sender) {
    // Модуль переподключается: не теряем сообщение, отправим после connect.
    pendingV1.push({ chatId, text, clientId, attempts: 0 });
    console.log('[kmesh]', 'text queued until module connects', chatId);
    return true;
  }
  try {
    const ok = await v1Sender(chatId, text, clientId);
    if (!ok) {
      pendingV1.push({ chatId, text, clientId, attempts: 1 });
      return true;
    }
    return true;
  } catch (error) {
    console.warn('[kmesh]', 'sendTextViaMesh failed', String(error));
    pendingV1.push({ chatId, text, clientId, attempts: 0 });
    return true;
  }
}

/** Отправить конверт через модуль. false — модуль не подключён или ошибка. */
export async function sendViaMesh(chatId: string, envelope: unknown): Promise<boolean> {
  const item = (envelope ?? {}) as { text?: unknown; kind?: unknown; clientId?: unknown };
  const text = typeof item.text === 'string' ? item.text : '';
  const clientId = typeof item.clientId === 'string' ? item.clientId : undefined;
  if (text) {
    // Тексты всегда идут бинарным KMesh_v1; при отсутствии модуля — в очередь.
    return sendTextViaMesh(chatId, text, clientId);
  }
  if (!sender) return false;
  try {
    await sender(chatId, envelope);
    return true;
  } catch {
    return false;
  }
}

/**
 * ModuleProvider вызывает при входящем mesh DATA_DOWN.
 *
 * Внутри одного mesh-конверта едут разные формы: сообщение (chatId +
 * envelopeB64) и служебный KMT-ответ (kind:'http_resp' без chatId).
 * Раньше guard требовал chatId и молча выбрасывал все http_resp, поэтому
 * API-туннель никогда не завершался. Слушатели сами проверяют свою форму.
 */
export function emitMeshEnvelope(envelope: Envelope): void {
  if (!envelope || typeof envelope !== 'object') return;
  for (const listener of listeners) {
    try {
      listener(envelope);
    } catch {
      /* один слушатель не должен ломать остальные */
    }
  }
}

export function onMeshEnvelope(listener: MeshListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
