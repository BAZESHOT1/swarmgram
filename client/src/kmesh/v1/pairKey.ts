/**
 * Ключ пары пользователей для личных чатов в KMesh без Hub.
 *
 * Если серверного ключа чата нет в кэше, а Hub недоступен, сообщение нельзя отправлять под одним лишь
 * общим ключом кластера (его знает каждый модуль). Вместо этого обе стороны выводят один и тот же ключ
 * через ECDH ключей аккаунтов (p256): ECDH(мой accountPriv, accountPub собеседника) + HKDF по chatId.
 * Модули и Hub этот ключ не знают. Когда Hub станет доступен, отправитель выгружает сообщение уже под
 * постоянным серверным ключом чата (outbox → /kmesh/v1/sync), и серверная копия заменяет mesh-копию.
 *
 * Публичный ключ аккаунта собеседника кэшируется заранее, пока есть интернет.
 */
import { storage, derivePairKey } from '../../crypto/core';
import { kv } from '../../crypto/storage';
import { api, type Chat } from '../../data/api';

const PEER_KEY = (chatId: string) => `sg:peer-account-pub:${chatId}`;

/** Пока есть интернет — запомнить accountPub собеседников личных чатов. */
export async function cachePeerAccountKeys(chats: Chat[], myUsername: string): Promise<void> {
  for (const chat of chats) {
    if (chat.type !== 'direct') continue;
    const peer = (chat.members ?? []).find((m) => m.username && m.username !== myUsername);
    if (!peer) continue;
    try {
      if (await kv.get(PEER_KEY(chat.id))) continue;
      const res = await api.userAccountKey(peer.username);
      if (res?.accountPub) await kv.set(PEER_KEY(chat.id), res.accountPub);
    } catch {
      /* офлайн — попробуем при следующем обновлении списка */
    }
  }
}

/** Ключ пары для чата или null (нет своего ключа аккаунта или собеседник ещё не закэширован). */
export async function pairKeyFor(chatId: string): Promise<Uint8Array | null> {
  try {
    const priv = await storage.loadAccountPriv();
    const peerPub = await kv.get(PEER_KEY(chatId));
    if (!priv || !peerPub) return null;
    return derivePairKey(priv, peerPub, chatId);
  } catch {
    return null;
  }
}
