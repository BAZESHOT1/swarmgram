/**
 * Кросс-платформенные события списка чатов.
 * Позволяет навигации (сайдбар/док) вызывать действия страницы чатов
 * без глобальных DOM-событий (работает и на iOS/Android).
 */
const readAllListeners = new Set<() => void>();

export function onReadAllRequest(fn: () => void): () => void {
  readAllListeners.add(fn);
  return () => {
    readAllListeners.delete(fn);
  };
}

export function requestReadAll(): void {
  for (const fn of Array.from(readAllListeners)) {
    try {
      fn();
    } catch {
      /* один подписчик не должен ломать остальные */
    }
  }
}
