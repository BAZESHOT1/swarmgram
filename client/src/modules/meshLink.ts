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

/** ModuleProvider вызывает при входящем mesh DATA_DOWN. */
export function emitMeshEnvelope(envelope: Envelope): void {
  if (!envelope || typeof envelope.chatId !== 'string') return;
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
