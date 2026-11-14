/**
 * Глобальный флаг полноэкранного поиска. Нужен, чтобы нижний док
 * полностью скрывался под оверлеем результатов на всех платформах.
 */
import { useSyncExternalStore } from 'react';

let active = false;
const listeners = new Set<() => void>();

export function setChatSearchActive(value: boolean): void {
  if (active === value) return;
  active = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChatSearchActive(): boolean {
  return useSyncExternalStore(subscribe, () => active, () => false);
}
