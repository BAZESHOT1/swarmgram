/**
 * Синхронное состояние чатов для мгновенного первого кадра:
 * last_read_msg_id, позиции скролла, черновики и кэш метаданных.
 */
import { syncKv } from './kv';

const READ_PREFIX = 'chat:read:';
const SCROLL_PREFIX = 'chat:scroll:';
const DRAFT_PREFIX = 'chat:draft:';
const META_PREFIX = 'chat:meta:';
const PINNED_PREFIX = 'chat:pinned:';

export function getLastReadMessageId(chatId: string): string | null {
  return syncKv.getString(READ_PREFIX + chatId);
}

export function setLastReadMessageId(chatId: string, messageId: string): void {
  syncKv.setString(READ_PREFIX + chatId, messageId);
}

export function getSavedScrollOffset(chatId: string): number | null {
  const raw = syncKv.getString(SCROLL_PREFIX + chatId);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function setSavedScrollOffset(chatId: string, offset: number): void {
  syncKv.setString(SCROLL_PREFIX + chatId, String(Math.max(0, offset)));
}

export function getDraft(chatId: string): string {
  return syncKv.getString(DRAFT_PREFIX + chatId) ?? '';
}

export function setDraft(chatId: string, text: string): void {
  if (text) syncKv.setString(DRAFT_PREFIX + chatId, text);
  else syncKv.delete(DRAFT_PREFIX + chatId);
}

export function getChatMeta<T>(chatId: string): T | null {
  return syncKv.getJSON<T>(META_PREFIX + chatId);
}

export function setChatMeta<T>(chatId: string, meta: T): void {
  syncKv.setJSON(META_PREFIX + chatId, meta);
}

export function isChatPinned(chatId: string): boolean {
  return syncKv.getBool(PINNED_PREFIX + chatId, false);
}

export function setChatPinned(chatId: string, pinned: boolean): void {
  syncKv.setBool(PINNED_PREFIX + chatId, pinned);
}
