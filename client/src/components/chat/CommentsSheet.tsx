/**
 * Обсуждение под постом канала.
 *
 * Комментарии живут отдельно от ленты канала: список приходит из data-слоя
 * (`channelComments`), текст расшифровывается тем же серверным ключом чата.
 * Отправка повторяет путь сообщения: encryptPayload → uploadEnvelope → Hub.
 * Если data-слой ещё не содержит хуков, используется локальный фолбэк на api.
 */
import React from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { Avatar } from '../Avatar';
import { SkeletonBlock } from '../skeletons/Skeleton';
import * as api from '../../data/api';
import * as queries from '../../data/queries';
import { humanError } from '../../data/queries';
import { decryptPayload, downloadObject, encryptPayload, getServerChatKey, uploadEnvelope } from '../../data/chatkit';
import { fromB64u, storage, toB64 } from '../../crypto/core';
import { useStore } from '../../state/useStore';

/** Комментарий в том виде, в котором его отдаёт data-слой. */
export interface ChannelComment {
  id: string;
  messageId: string;
  userId: string;
  username: string;
  createdAt: string;
  objectId?: string | null;
  nonce?: string;
  header?: unknown;
  canDelete?: boolean;
  /** Расшифрованный текст: data-слой может добавлять его сразу. */
  text?: string;
}

/** Пост, под которым открыто обсуждение. */
export interface CommentsPost {
  id: string;
  text?: string;
  senderUsername: string;
  createdAt?: string;
  kind?: string;
}

export type InviteEncryption = 'server' | 'e2e';

type CommentsResult = {
  data?: ChannelComment[];
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  refetch?: () => unknown;
};

/** Запасной вариант, пока data-слой не отдаёт useChannelComments. */
function useCommentsFallback(chatId: string, messageId: string, enabled: boolean): CommentsResult {
  return useQuery<ChannelComment[]>({
    queryKey: ['channel-comments', chatId, messageId],
    enabled: enabled && Boolean(chatId) && Boolean(messageId),
    staleTime: 0,
    queryFn: async () => {
      const fn = (api.api as unknown as {
        channelComments?: (chatId: string, messageId: string) => Promise<ChannelComment[]>;
      }).channelComments;
      if (typeof fn !== 'function') throw new Error('Комментарии пока недоступны');
      const list = await fn(chatId, messageId);
      return Array.isArray(list) ? list : [];
    },
  });
}

/** Берём хук data-слоя, если он уже появился; иначе — локальный фолбэк. */
const useComments =
  (queries as unknown as { useChannelComments?: typeof useCommentsFallback }).useChannelComments ??
  useCommentsFallback;

/** Кэш расшифрованного текста: objectId → текст (комментарии не меняются). */
const decryptedCache = new Map<string, string>();

/** Текст ошибки: русские сообщения ApiError + собственные понятные причины. */
function errorText(err: unknown): string {
  if (err instanceof api.ApiError) return humanError(err);
  if (err instanceof Error && err.message) return err.message;
  return humanError(err);
}

function parseHeader(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function fmtWhen(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

function postPreview(post: CommentsPost | null): string {
  if (!post) return '';
  if (post.text) return post.text;
  return post.kind === 'media' ? 'Вложение' : 'Зашифрованное сообщение';
}

export function CommentsSheet({
  visible,
  chatId,
  post,
  encryption,
  onClose,
  onChanged,
}: {
  visible: boolean;
  chatId: string;
  post: CommentsPost | null;
  /** Секретные каналы комментарии не поддерживают. */
  encryption?: InviteEncryption;
  onClose: () => void;
  /** Вызывается после успешной отправки/удаления — обновляет счётчики в ленте. */
  onChanged?: () => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const qc = useQueryClient();
  const pushToast = useStore((s) => s.pushToast);
  const myUsername = useStore((s) => s.session?.username ?? '');
  const myUserId = useStore((s) => s.session?.userId ?? '');

  const messageId = post?.id ?? '';
  const secretsOnly = encryption === 'e2e';
  const open = visible && Boolean(post) && !secretsOnly;

  const comments = useComments(chatId, messageId, open);

  const [text, setText] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [texts, setTexts] = React.useState<Record<string, string>>({});
  const inputRef = React.useRef<TextInput | null>(null);

  const list = comments.data ?? [];

  // Расшифровка комментариев, у которых нет готового text (контракт data-слоя).
  React.useEffect(() => {
    if (!open) return undefined;
    const need = list.filter((c) => c.text === undefined && c.objectId && c.nonce);
    if (!need.length) return undefined;
    let cancelled = false;
    void (async () => {
      const patch: Record<string, string> = {};
      for (const item of need) {
        const objectId = item.objectId as string;
        const cached = decryptedCache.get(objectId);
        if (cached !== undefined) {
          patch[item.id] = cached;
          continue;
        }
        try {
          const header = parseHeader(item.header);
          const version = typeof header.keyVersion === 'number' ? header.keyVersion : undefined;
          const { key } = await getServerChatKey(chatId, version);
          const bytes = await downloadObject(objectId);
          const payload = bytes ? await decryptPayload(key, toB64(bytes), item.nonce as string) : null;
          const value = payload?.text ?? '';
          decryptedCache.set(objectId, value);
          patch[item.id] = value;
        } catch {
          patch[item.id] = '';
        }
      }
      if (!cancelled && Object.keys(patch).length) {
        setTexts((prev) => ({ ...prev, ...patch }));
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, list, chatId]);

  // При открытии другого поста очищаем недописанный текст.
  React.useEffect(() => {
    if (!visible) {
      setText('');
      setSending(false);
      setDeletingId(null);
    }
  }, [visible, messageId]);

  async function refresh() {
    await Promise.resolve(comments.refetch?.()).catch(() => undefined);
    void qc.invalidateQueries({ queryKey: ['channel-comments'] });
    void qc.invalidateQueries({ queryKey: ['messages', chatId] });
    onChanged?.();
  }

  async function onSend() {
    const body = text.trim();
    if (!body || sending || !post) return;
    setSending(true);
    try {
      const keys = await storage.loadKeys();
      if (!keys) throw new Error('Нет ключей устройства');
      const chat = await api.api.getChat(chatId);
      if (chat.encryption === 'e2e') throw new Error('Обсуждения недоступны для секретных каналов');
      const { key, version } = await getServerChatKey(chatId);
      const { ciphertext, nonce } = await encryptPayload(key, { text: body });
      const uploaded = await uploadEnvelope(fromB64u(ciphertext));
      const create = (api.api as unknown as {
        createChannelComment?: (
          chatId: string,
          messageId: string,
          body: { objectId: string; nonce: string; header: unknown },
        ) => Promise<unknown>;
      }).createChannelComment;
      if (typeof create !== 'function') throw new Error('Комментарии пока недоступны');
      await create(chatId, post.id, {
        objectId: uploaded.objectId,
        nonce,
        header: { scheme: 'server', keyVersion: version, nonce },
      });
      setText('');
      await refresh();
      pushToast({ kind: 'success', message: 'Комментарий отправлен' });
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: errorText(e) });
    } finally {
      setSending(false);
    }
  }

  async function doDelete(comment: ChannelComment) {
    setDeletingId(comment.id);
    try {
      const remove = (api.api as unknown as {
        deleteChannelComment?: (chatId: string, messageId: string, commentId: string) => Promise<unknown>;
      }).deleteChannelComment;
      if (typeof remove !== 'function') throw new Error('Удаление пока недоступно');
      await remove(chatId, post?.id ?? messageId, comment.id);
      await refresh();
      pushToast({ kind: 'success', message: 'Комментарий удалён' });
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: errorText(e) });
    } finally {
      setDeletingId(null);
    }
  }

  function confirmDelete(comment: ChannelComment) {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (window.confirm('Удалить комментарий?')) void doDelete(comment);
      return;
    }
    Alert.alert('Удалить комментарий?', 'Он исчезнет из обсуждения без возможности восстановления.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => void doDelete(comment) },
    ]);
  }

  function commentText(comment: ChannelComment): string {
    if (typeof comment.text === 'string') return comment.text;
    return texts[comment.id] ?? '';
  }

  const canSend = !secretsOnly && Boolean(post) && Boolean(text.trim()) && !sending;

  return (
    <Modal visible={visible && Boolean(post)} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Закрыть обсуждение"
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 24 : 0}
          style={styles.keyboardWrap}
        >
          <MotiView
            from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 46, scale: 0.98 }}
            animate={{ opacity: 1, translateY: 0, scale: 1 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
            style={[styles.sheet, { backgroundColor: theme.surfaceElevated, borderColor: theme.line, ...theme.shadow }]}
          >
            <View style={styles.grabber}>
              <View style={{ width: 38, height: 4, borderRadius: 2, backgroundColor: theme.line }} />
            </View>

            <View style={styles.head}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 17, fontWeight: '800' }} numberOfLines={1}>
                  Обсуждение
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                  {list.length ? `${list.length} ${plural(list.length, 'комментарий', 'комментария', 'комментариев')}` : 'Под постом'}
                </Text>
              </View>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel="Закрыть"
                hitSlop={8}
                style={({ pressed }) => [styles.close, { backgroundColor: pressed ? theme.surfacePressed : theme.surface }]}
              >
                <Ionicons name="close" size={18} color={theme.textSecondary} />
              </Pressable>
            </View>

            {post ? (
              <View style={[styles.post, { backgroundColor: theme.surface, borderColor: theme.line }]}>
                <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>
                  {post.senderUsername}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18 }} numberOfLines={3}>
                  {postPreview(post)}
                </Text>
              </View>
            ) : null}

            {secretsOnly ? (
              <View style={styles.secret}>
                <Ionicons name="lock-closed" size={18} color={theme.warning} />
                <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 18, flex: 1 }}>
                  Обсуждения недоступны для секретных каналов.
                </Text>
              </View>
            ) : (
              <>
                <ScrollView
                  style={styles.list}
                  contentContainerStyle={{ paddingVertical: 6, gap: 4 }}
                  keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false}
                >
                  {comments.isLoading ? (
                    <View style={{ gap: 12, paddingVertical: 8 }}>
                      {[0, 1, 2].map((i) => (
                        <View key={i} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
                          <SkeletonBlock width={30} height={30} radius={15} />
                          <View style={{ flex: 1, gap: 6 }}>
                            <SkeletonBlock width="42%" height={11} radius={5} />
                            <SkeletonBlock width={i % 2 ? '88%' : '72%'} height={10} radius={5} />
                          </View>
                        </View>
                      ))}
                    </View>
                  ) : comments.isError ? (
                    <View style={{ paddingVertical: 16, gap: 8, alignItems: 'center' }}>
                      <Text style={{ color: theme.danger, fontSize: 13, textAlign: 'center' }}>
                        {errorText(comments.error)}
                      </Text>
                      <Pressable
                        onPress={() => void refresh()}
                        accessibilityRole="button"
                        accessibilityLabel="Повторить загрузку комментариев"
                        style={({ pressed }) => [
                          styles.retry,
                          { borderColor: theme.line, backgroundColor: pressed ? theme.surfacePressed : theme.surface },
                        ]}
                      >
                        <Text style={{ color: theme.accent, fontSize: 12.5, fontWeight: '700' }}>Повторить</Text>
                      </Pressable>
                    </View>
                  ) : list.length === 0 ? (
                    <View style={styles.empty}>
                      <Ionicons name="chatbubbles-outline" size={26} color={theme.textDisabled} />
                      <Text style={{ color: theme.textSecondary, fontSize: 13.5, fontWeight: '600' }}>Пока нет комментариев</Text>
                      <Text style={{ color: theme.textDisabled, fontSize: 12, textAlign: 'center' }}>
                        Напишите первым — обсуждение появится под постом.
                      </Text>
                    </View>
                  ) : (
                    list.map((comment, index) => {
                      const body = commentText(comment);
                      const mine = comment.userId === myUserId || comment.username === myUsername;
                      const removable = comment.canDelete ?? mine;
                      return (
                        <MotiView
                          key={comment.id}
                          from={reduced ? { opacity: 1 } : { opacity: 0, translateY: 8 }}
                          animate={{ opacity: 1, translateY: 0 }}
                          transition={
                            reduced
                              ? { type: 'timing', duration: 0 }
                              : { ...motion.spring, delay: Math.min(index, 8) * motion.staggerStepMs }
                          }
                          style={styles.commentRow}
                        >
                          <Avatar name={comment.username || '?'} size={30} hasModule={false} hasNode={false} />
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '700', flexShrink: 1 }} numberOfLines={1}>
                                {comment.username}
                              </Text>
                              <Text style={{ color: theme.textDisabled, fontSize: 11 }}>{fmtWhen(comment.createdAt)}</Text>
                            </View>
                            <Text style={{ color: theme.textPrimary, fontSize: 14, lineHeight: 19, marginTop: 1 }}>
                              {body || '…'}
                            </Text>
                          </View>
                          {removable ? (
                            <Pressable
                              onPress={() => confirmDelete(comment)}
                              disabled={deletingId === comment.id}
                              accessibilityRole="button"
                              accessibilityLabel="Удалить комментарий"
                              hitSlop={6}
                              style={({ pressed }) => [styles.deleteBtn, { opacity: deletingId === comment.id ? 0.5 : pressed ? 0.6 : 1 }]}
                            >
                              {deletingId === comment.id ? (
                                <ActivityIndicator size="small" color={theme.danger} />
                              ) : (
                                <Ionicons name="trash-outline" size={16} color={theme.textDisabled} />
                              )}
                            </Pressable>
                          ) : null}
                        </MotiView>
                      );
                    })
                  )}
                </ScrollView>

                <View style={[styles.composer, { borderTopColor: theme.line }]}>
                  <TextInput
                    ref={inputRef}
                    value={text}
                    onChangeText={setText}
                    multiline
                    placeholder="Комментарий"
                    placeholderTextColor={theme.textDisabled}
                    accessibilityLabel="Текст комментария"
                    maxLength={2000}
                    style={[
                      styles.input,
                      { backgroundColor: theme.surface, color: theme.textPrimary, borderColor: theme.line },
                    ]}
                  />
                  <Pressable
                    onPress={() => void onSend()}
                    disabled={!canSend}
                    accessibilityRole="button"
                    accessibilityLabel="Отправить комментарий"
                    style={({ pressed }) => [
                      styles.send,
                      { backgroundColor: theme.accent, opacity: !canSend ? 0.45 : pressed ? 0.85 : 1 },
                    ]}
                  >
                    {sending ? (
                      <ActivityIndicator size="small" color={theme.onAccent} />
                    ) : (
                      <Ionicons name="paper-plane" size={16} color={theme.onAccent} />
                    )}
                  </Pressable>
                </View>
              </>
            )}
          </MotiView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  keyboardWrap: { width: '100%', maxWidth: 560, justifyContent: 'flex-end' },
  sheet: {
    width: '100%',
    maxHeight: '86%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 12,
    paddingBottom: Platform.OS === 'ios' ? 22 : 12,
    paddingTop: 6,
  },
  grabber: { alignItems: 'center', paddingVertical: 6 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 2, paddingBottom: 8 },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  post: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
  secret: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 26,
    paddingHorizontal: 8,
  },
  list: { maxHeight: 420, minHeight: 120, marginTop: 4 },
  commentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingVertical: 7, paddingHorizontal: 2 },
  deleteBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', gap: 6, paddingVertical: 26, paddingHorizontal: 18 },
  retry: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, borderTopWidth: 1, paddingTop: 9, marginTop: 2 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 9,
    minHeight: 40,
    maxHeight: 110,
    textAlignVertical: 'top',
    fontSize: 14.5,
  },
  send: { width: 40, height: 40, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
});
