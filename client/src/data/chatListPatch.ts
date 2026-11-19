/**
 * Локальное обновление списка чатов при входящем сообщении (в том числе через kMesh без интернета):
 * чат поднимается наверх, растёт счётчик непрочитанных. Сервер для этого не нужен.
 */
import type { QueryClient } from '@tanstack/react-query';
import { useStore } from '../state/useStore';

export function bumpChatInList(qc: QueryClient, chatId: string, createdAt: string, mine: boolean): void {
  const activeId = useStore.getState().activeChat?.id;
  qc.setQueriesData<unknown[]>({ queryKey: ['chats'] }, (prev) => {
    if (!Array.isArray(prev)) return prev;
    let found = false;
    const next = prev.map((row) => {
      const c = row as { id?: string; unread?: number; updatedAt?: string };
      if (c?.id !== chatId) return row;
      found = true;
      const newer = !c.updatedAt || new Date(createdAt).getTime() > new Date(c.updatedAt).getTime();
      return {
        ...(row as object),
        updatedAt: newer ? createdAt : c.updatedAt,
        unread: activeId === chatId || mine ? c.unread ?? 0 : (c.unread ?? 0) + 1,
      };
    });
    if (!found) return prev;
    return [...next].sort(
      (a, b) =>
        new Date((b as { updatedAt?: string }).updatedAt ?? 0).getTime() -
        new Date((a as { updatedAt?: string }).updatedAt ?? 0).getTime(),
    );
  });
}
