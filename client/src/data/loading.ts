/**
 * Глобальный счётчик активных сетевых запросов.
 * Верхний прогресс-бар подписывается на него и показывает активность,
 * пока count > 0.
 */
let count = 0;
const listeners = new Set<(n: number) => void>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn(count);
    } catch {
      // слушатель не должен ломать учёт запросов
    }
  }
}

/** Отметить начало запроса. */
export function beginRequest(): void {
  count += 1;
  emit();
}

/** Отметить завершение запроса (парный к beginRequest, вызывать в finally). */
export function endRequest(): void {
  count = Math.max(0, count - 1);
  emit();
}

/** Подписка на изменение числа активных запросов; возвращает отписку. */
export function subscribeLoading(fn: (n: number) => void): () => void {
  listeners.add(fn);
  // сразу отдаём текущее значение, чтобы бар не ждал первого события
  fn(count);
  return () => {
    listeners.delete(fn);
  };
}

/** Текущее число активных запросов. */
export function getLoadingCount(): number {
  return count;
}
