/**
 * События сервисных RPC KMesh_v1: поиск, лента, история.
 *
 * Hub присылает ответы через downlink, KMeshV1Client разбирает их и
 * публикует здесь. UI может подписаться и показать результаты без HTTP.
 */
import type { FeedEntry, HistoryEntry, SearchResult } from './protocol';

type SearchEvent = { reqId: number; results: SearchResult[]; more: boolean };
type FeedEvent = { entries: FeedEntry[]; more: boolean };
type HistoryEvent = { chatRef: number; messages: HistoryEntry[]; more: boolean };

const searchListeners = new Set<(event: SearchEvent) => void>();
const feedListeners = new Set<(event: FeedEvent) => void>();
const historyListeners = new Set<(event: HistoryEvent) => void>();

export function emitKmeshSearch(event: SearchEvent): void {
  for (const listener of searchListeners) listener(event);
}
export function emitKmeshFeed(event: FeedEvent): void {
  for (const listener of feedListeners) listener(event);
}
export function emitKmeshHistory(event: HistoryEvent): void {
  for (const listener of historyListeners) listener(event);
}

export function onKmeshSearch(listener: (event: SearchEvent) => void): () => void {
  searchListeners.add(listener);
  return () => searchListeners.delete(listener);
}
export function onKmeshFeed(listener: (event: FeedEvent) => void): () => void {
  feedListeners.add(listener);
  return () => feedListeners.delete(listener);
}
export function onKmeshHistory(listener: (event: HistoryEvent) => void): () => void {
  historyListeners.add(listener);
  return () => historyListeners.delete(listener);
}
