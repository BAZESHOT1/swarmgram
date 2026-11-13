/**
 * Мост между приложением и подключённым модулем.
 *
 * Когда интернет недоступен, messaging.ts кладёт шифротекст в модуль
 * (USB/BLE → mesh). Входящие mesh-конверты ModuleProvider отдаёт сюда,
 * а RealtimeBridge обрабатывает их так же, как WebSocket-события.
 */
import type { Envelope } from '../data/api';

type MeshSender = (chatId: string, envelope: unknown) => Promise<void>;
type MeshListener = (envelope: Envelope) => void;

let sender: MeshSender | null = null;
const listeners = new Set<MeshListener>();

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

export function canSendViaMesh(): boolean {
  return sender !== null;
}

/** Отправить конверт через модуль. false — модуль не подключён или ошибка. */
export async function sendViaMesh(chatId: string, envelope: unknown): Promise<boolean> {
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
