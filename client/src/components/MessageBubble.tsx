import React from 'react';
import { Alert, Animated, Platform, Pressable, Text, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../theme/useTheme';
import { Avatar } from './Avatar';
import { useReducedMotion } from './useReducedMotion';
import { PressableScale } from './chat/PressableScale';
import { motion } from '../theme/motion';
import type { ViewMessage } from '../data/messaging';
import { MediaMessage } from './chat/MediaMessage';
import { roleColor } from './chat/roles';

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Подписи этапов оптимистичной отправки медиа. */
const STAGE_LABEL: Record<'compress' | 'encrypt' | 'upload' | 'register', string> = {
  compress: 'Сжимаем',
  encrypt: 'Шифруем',
  upload: 'Загружаем',
  register: 'Регистрируем',
};

/** Позиция сообщения внутри группы одного отправителя (Telegram-style). */
export type BubbleGroup = 'single' | 'first' | 'middle' | 'last';

/** Дополнительные поля ViewMessage из нового контракта data-слоя. */
type ViewMessageExt = ViewMessage & {
  replyTo?: string | null;
  edited?: boolean;
  reactions?: { emoji: string; count: number; mine: boolean }[];
  scheme?: 'server' | 'e2e';
  viewsCount?: number;
  asChannel?: boolean;
};

/** Компактная цитата сообщения, на которое отвечают. */
export interface QuotedMessage {
  id: string;
  username: string;
  text: string;
}

const MENTION_RE = /(@[A-Za-z0-9_]+)/g;

/** Подсветка совпадений поиска внутри фрагмента (без вложенного контейнера Text). */
function highlightChunk(text: string, query: string, accent: string, accentSoft: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'ig'));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <Text key={i} style={{ backgroundColor: accentSoft, color: accent, fontWeight: '700' }}>
        {part}
      </Text>
    ) : (
      part
    ),
  );
}

/**
 * Текст сообщения с подсветкой @упоминаний (акцент) и совпадений поиска.
 * Упоминания — простой regex-парсер, без серверной разметки.
 */
function richText(text: string, query: string, baseColor: string, accent: string, accentSoft: string, mine: boolean) {
  const chunks = text.split(MENTION_RE);
  return (
    <Text style={[styles.text, { color: baseColor }]}>
      {chunks.map((chunk, i) => {
        if (i % 2 === 1 && chunk.length > 1) {
          return (
            <Text
              key={i}
              style={{
                color: mine ? '#FFFFFF' : accent,
                backgroundColor: mine ? 'rgba(255,255,255,0.2)' : accentSoft,
                fontWeight: '700',
              }}
            >
              {chunk}
            </Text>
          );
        }
        return <React.Fragment key={i}>{highlightChunk(chunk, query, accent, accentSoft)}</React.Fragment>;
      })}
    </Text>
  );
}

/**
 * Системное сообщение о событии группы: без аватара и пузыря, по центру.
 * Имена участников подсвечиваются акцентом и могут открывать профиль.
 */
export function SystemMessage({
  item,
  onOpenMenu,
  onUsernamePress,
}: {
  item: ViewMessage;
  /** Долгое нажатие открывает обычный action sheet сообщения (удаление). */
  onOpenMenu?: () => void;
  onUsernamePress?: (username: string) => void;
}) {
  const theme = useTheme();
  const text = item.text ?? '';
  const names = React.useMemo(
    () => Array.from(new Set([item.systemActor, item.systemTarget].filter((n): n is string => Boolean(n)))),
    [item.systemActor, item.systemTarget],
  );
  const chunks = React.useMemo(() => {
    if (!names.length) return [{ text, name: false }];
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'));
    return parts.filter(Boolean).map((part) => ({
      text: part,
      name: names.some((n) => n.toLowerCase() === part.toLowerCase()),
    }));
  }, [text, names]);

  return (
    <View style={styles.systemRow}>
      <Pressable
        onLongPress={onOpenMenu}
        delayLongPress={400}
        disabled={!onOpenMenu}
        accessibilityRole="button"
        accessibilityLabel={`Системное сообщение: ${text}`}
        style={({ pressed }) => [styles.systemPress, { opacity: pressed && onOpenMenu ? 0.65 : 1 }]}
      >
        <Text style={[styles.systemText, { color: theme.textSecondary }]}>
          {chunks.map((chunk, i) =>
            chunk.name ? (
              <Text
                key={i}
                onPress={onUsernamePress ? () => onUsernamePress(chunk.text) : undefined}
                accessibilityRole={onUsernamePress ? 'link' : undefined}
                style={{ color: theme.accent, fontWeight: '700' }}
              >
                {chunk.text}
              </Text>
            ) : (
              <React.Fragment key={i}>{chunk.text}</React.Fragment>
            ),
          )}
        </Text>
        <Text style={[styles.systemTime, { color: theme.textSecondary }]}>{fmtTime(item.createdAt)}</Text>
      </Pressable>
    </View>
  );
}

export function MessageBubble({
  item,
  group = 'single',
  onCopy,
  onReply,
  onDelete,
  onOpenMenu,
  quoted,
  onQuotePress,
  highlight = '',
  highlightActive,
  flash,
  onReactionPress,
  onAvatarPress,
  onOpenComments,
  commentsCount,
  nodeOnline,
  moduleOnline,
  avatar,
  uploadProgress,
  uploadStage,
  localPreview,
  onRetryUpload,
  onCancelUpload,
  failed,
  role,
  asChannelTitle,
  secret,
  viewsCount,
}: {
  item: ViewMessage;
  group?: BubbleGroup;
  onCopy: (text: string) => void;
  onReply: () => void;
  onDelete: () => void;
  /** Кастомное меню (долгое нажатие). Если не задано — системный Alert. */
  onOpenMenu?: () => void;
  quoted?: QuotedMessage | null;
  onQuotePress?: () => void;
  /** Поисковый запрос для подсветки совпадений. */
  highlight?: string;
  /** Текущее совпадение — пузырь получает акцентную рамку. */
  highlightActive?: boolean;
  /** Короткая вспышка фона для нового входящего сообщения. */
  flash?: boolean;
  onReactionPress?: (emoji: string) => void;
  /** Тап по аватару отправителя (только для входящих) открывает профиль. */
  onAvatarPress?: () => void;
  /** Посты канала: открыть обсуждение под сообщением. */
  onOpenComments?: () => void;
  /** Число комментариев под постом канала. */
  commentsCount?: number;
  /** Онлайн-узел отправителя (оранжевое кольцо на аватаре). */
  nodeOnline?: boolean;
  /** Онлайн-модуль отправителя (зелёное кольцо на аватаре). */
  moduleOnline?: boolean;
  avatar?: { objectId: string; key: string; mime: string } | null;
  /** Оптимистичная отправка: общий прогресс 0..1. */
  uploadProgress?: number;
  /** Текущий этап загрузки. */
  uploadStage?: 'compress' | 'encrypt' | 'upload' | 'register' | null;
  /** Локальный data URI превью до загрузки/расшифровки. */
  localPreview?: string;
  /** Повторить неудачную отправку медиа. */
  onRetryUpload?: () => void;
  /** Отменить загрузку/убрать неудачное сообщение. */
  onCancelUpload?: () => void;
  /** Явный флаг ошибки отправки (иначе берётся item.failed). */
  failed?: boolean;
  /** Роль отправителя в чате — определяет цвет имени. */
  role?: string | null;
  /** Пост «от имени канала»: вместо автора показываем название канала. */
  asChannelTitle?: string | null;
  /** Секретный чат: скрываем копирование в меню. */
  secret?: boolean;
  /** Просмотры поста канала. */
  viewsCount?: number;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const ext = item as ViewMessageExt;
  // Локальное превью запоминаем: после подтверждения сервером проп localPreview
  // исчезает, но картинка не должна мигать/пропадать до расшифровки файла.
  const [cachedPreview, setCachedPreview] = React.useState<string | undefined>(localPreview);
  React.useEffect(() => {
    if (localPreview) setCachedPreview(localPreview);
  }, [localPreview]);
  const flashAnim = React.useRef(new Animated.Value(0)).current;
  // Подтверждение своего сообщения: короткая зелёная вспышка после доставки.
  const confirmAnim = React.useRef(new Animated.Value(0)).current;
  const prevDelivered = React.useRef(item.delivered);
  const isFailed = failed ?? item.failed;
  // Лёгкое сжатие пузыря только на время нажатия.
  const pressScale = React.useRef(new Animated.Value(1)).current;

  const setPressed = React.useCallback(
    (pressed: boolean) => {
      if (reduced) {
        pressScale.setValue(pressed ? 0.99 : 1);
        return;
      }
      Animated.spring(pressScale, {
        toValue: pressed ? 0.99 : 1,
        damping: motion.pressSpring.damping,
        stiffness: motion.pressSpring.stiffness,
        mass: motion.pressSpring.mass,
        useNativeDriver: true,
      }).start();
    },
    [pressScale, reduced],
  );

  // Новое входящее — короткая вспышка акцентным фоном.
  React.useEffect(() => {
    if (!flash) return;
    flashAnim.setValue(1);
    Animated.timing(flashAnim, { toValue: 0, duration: 1300, useNativeDriver: false }).start();
  }, [flash, flashAnim]);

  // Своё сообщение подтвердилось сервером — мягкий зелёный pulse.
  React.useEffect(() => {
    if (item.mine && item.delivered && !prevDelivered.current && !reduced) {
      confirmAnim.setValue(0.55);
      Animated.timing(confirmAnim, { toValue: 0, duration: 900, useNativeDriver: false }).start();
    }
    prevDelivered.current = item.delivered;
  }, [item.mine, item.delivered, reduced, confirmAnim]);

  const previewUri = localPreview ?? cachedPreview;
  const uploading = item.mine && item.pending && (uploadStage != null || (uploadProgress != null && uploadProgress < 1));
  const progressPct = Math.round(Math.max(0, Math.min(1, uploadProgress ?? 0)) * 100);
  const asChannel = Boolean(ext.asChannel || asChannelTitle);

  const menu = () => {
    const buttons: { text: string; onPress?: () => void; style?: 'destructive' | 'cancel' }[] = [];
    // В секретном чате копирование (как и пересылка) запрещено.
    if (!secret) buttons.push({ text: 'Копировать', onPress: () => onCopy(item.text ?? '') });
    buttons.push({ text: 'Ответить', onPress: onReply });
    if (item.mine) buttons.push({ text: 'Удалить', style: 'destructive', onPress: onDelete });
    buttons.push({ text: 'Отмена', style: 'cancel' });
    Alert.alert('Сообщение', undefined, buttons);
  };

  const bubbleColor = item.mine ? theme.bubbleMine : theme.bubbleOther;
  const first = group === 'single' || group === 'first';
  const last = group === 'single' || group === 'last';
  // Крупные скругления без «хвостиков»: 20 снаружи, 8 между сообщениями группы.
  const R = 20;
  const r = 8;

  const radii = item.mine
    ? {
        borderTopLeftRadius: R,
        borderBottomLeftRadius: R,
        borderTopRightRadius: first ? R : r,
        borderBottomRightRadius: last ? R : r,
      }
    : {
        borderTopRightRadius: R,
        borderBottomRightRadius: R,
        borderTopLeftRadius: first ? R : r,
        borderBottomLeftRadius: last ? R : r,
      };

  const reactions = ext.reactions ?? [];
  const senderColor = asChannel ? theme.accent : roleColor(theme, role);
  const senderName = asChannel ? asChannelTitle ?? 'Канал' : item.senderUsername;
  const showAvatar = !item.mine && (Boolean(onAvatarPress) || asChannel);

  return (
    <MotiView
      from={reduced ? { opacity: 1 } : { opacity: 0, translateY: item.mine ? 26 : 10, scale: item.mine ? 0.94 : 0.98 }}
      animate={{ opacity: 1, translateY: 0, scale: 1 }}
      transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
      style={[styles.row, item.mine && styles.rowMine, { marginTop: first ? 8 : 2 }]}
    >
      {showAvatar ? (
        first ? (
          <Pressable
            onPress={onAvatarPress}
            disabled={!onAvatarPress}
            accessibilityRole="button"
            accessibilityLabel={`Профиль ${senderName}`}
            hitSlop={4}
            style={({ pressed }) => [styles.avatarBtn, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Avatar
              name={senderName || '?'}
              size={28}
              nodeOnline={nodeOnline}
              moduleOnline={moduleOnline}
              avatar={asChannel ? null : avatar}
            />
            {asChannel ? (
              <View style={[styles.megaphoneBadge, { backgroundColor: theme.accent }]}>
                <Ionicons name="megaphone" size={8} color={theme.onAccent} />
              </View>
            ) : null}
          </Pressable>
        ) : (
          <View style={styles.avatarSpacer} />
        )
      ) : null}
      <Animated.View
        style={{
          maxWidth: showAvatar ? '78%' : '86%',
          transform: [{ scale: pressScale }],
        }}
      >
        <Pressable
          onLongPress={onOpenMenu ?? menu}
          onPressIn={() => setPressed(true)}
          onPressOut={() => setPressed(false)}
          delayLongPress={400}
          {...(Platform.OS === 'web'
            ? { onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault() }
            : null)}
          accessibilityRole="button"
          accessibilityLabel={
            item.mine
              ? `Моё сообщение, долгое нажатие меню, ${fmtTime(item.createdAt)}`
              : `Сообщение от ${senderName}, долгое нажатие меню`
          }
          style={({ pressed }) => [
            styles.bubble,
            Platform.OS === 'web' ? styles.webNoSelect : null,
            radii,
            {
              backgroundColor: pressed ? theme.surfacePressed : bubbleColor,
              borderColor: highlightActive ? theme.accent : item.mine ? 'transparent' : theme.line,
              borderWidth: highlightActive ? 1.5 : 1,
            },
            first && styles.bubbleFirst,
            item.kind === 'media' && styles.bubbleMedia,
          ]}
        >
          {/* Вспышка нового входящего поверх пузыря */}
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { ...radii, backgroundColor: theme.accentSoft, opacity: flashAnim },
            ]}
          />
          {/* Подтверждение своего сообщения (доставлено) */}
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { ...radii, backgroundColor: theme.successSoft, opacity: confirmAnim },
            ]}
          />

          {first && !item.mine ? (
            <View style={styles.whoRow}>
              {asChannel ? <Ionicons name="megaphone" size={12} color={senderColor} /> : null}
              <Text style={[styles.who, { color: senderColor }]} numberOfLines={1}>
                {senderName}
              </Text>
            </View>
          ) : null}

          {quoted || ext.replyTo ? (
            <Pressable
              onPress={onQuotePress}
              accessibilityRole="button"
              accessibilityLabel="Перейти к сообщению, на которое ответили"
              style={[styles.quote, { borderLeftColor: theme.accent, backgroundColor: item.mine ? 'rgba(0,0,0,0.16)' : theme.surfacePressed }]}
            >
              <Text style={{ color: item.mine ? theme.onAccent : theme.accent, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>
                {quoted?.username ?? 'Ответ'}
              </Text>
              <Text style={{ color: item.mine ? 'rgba(26,18,6,0.72)' : theme.textSecondary, fontSize: 12.5 }} numberOfLines={1}>
                {quoted?.text || 'Сообщение'}
              </Text>
            </Pressable>
          ) : null}

          {item.kind === 'media' ? (
            <MediaMessage
              item={item}
              previewUri={previewUri}
              uploading={uploading}
              progressPct={progressPct}
              stageLabel={uploadStage ? STAGE_LABEL[uploadStage] : null}
            />
          ) : item.text ? (
            richText(
              item.text,
              highlight,
              item.mine ? theme.onAccent : theme.textPrimary,
              item.mine ? theme.onAccent : theme.accent,
              item.mine ? 'rgba(255,255,255,0.3)' : theme.accentSoft,
              item.mine,
            )
          ) : (
            <Text style={[styles.text, { color: item.mine ? theme.onAccent : theme.textSecondary, fontStyle: 'italic' }]}>🔒 Зашифрованное сообщение</Text>
          )}

          {/* Тонкий прогресс-бар внизу пузыря во время загрузки */}
          {item.mine && item.pending && uploadProgress != null && uploadProgress < 1 ? (
            <View style={[styles.progressTrack, { backgroundColor: item.mine ? 'rgba(0,0,0,0.18)' : theme.line }]}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.max(4, progressPct)}%`, backgroundColor: item.mine ? theme.onAccent : theme.accent },
                ]}
              />
            </View>
          ) : null}

          {item.mine && uploading && onCancelUpload ? (
            <Pressable onPress={onCancelUpload} accessibilityRole="button" accessibilityLabel="Отменить загрузку" hitSlop={6} style={styles.cancelRow}>
              <Text style={{ color: item.mine ? 'rgba(26,18,6,0.72)' : theme.textSecondary, fontSize: 11, fontWeight: '700' }}>
                Отмена
              </Text>
            </Pressable>
          ) : null}

          {/* Ошибка оптимистичной отправки: повторить/убрать */}
          {isFailed && item.mine && (onRetryUpload || onCancelUpload) ? (
            <View style={styles.failRow}>
              <Ionicons name="alert-circle" size={13} color={theme.danger} />
              <Text style={[styles.failText, { color: theme.danger }]}>Ошибка отправки</Text>
              {onRetryUpload ? (
                <Pressable onPress={onRetryUpload} accessibilityRole="button" accessibilityLabel="Повторить отправку" hitSlop={6}>
                  <Text style={[styles.failAction, { color: theme.accent }]}>Повторить</Text>
                </Pressable>
              ) : null}
              {onCancelUpload ? (
                <Pressable onPress={onCancelUpload} accessibilityRole="button" accessibilityLabel="Убрать сообщение" hitSlop={6}>
                  <Text style={[styles.failAction, { color: theme.textSecondary }]}>Отмена</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <View style={styles.metaRow}>
            {ext.scheme === 'e2e' ? <Ionicons name="lock-closed" size={10} color={item.mine ? 'rgba(26,18,6,0.62)' : theme.accent} /> : null}
            {viewsCount != null ? (
              <>
                <Ionicons name="eye-outline" size={12} color={item.mine ? 'rgba(26,18,6,0.62)' : theme.textSecondary} />
                <Text style={[styles.meta, { color: item.mine ? 'rgba(26,18,6,0.62)' : theme.textSecondary }]}>{viewsCount}</Text>
              </>
            ) : null}
            <Text style={[styles.meta, { color: item.mine ? 'rgba(26,18,6,0.62)' : theme.textSecondary }]}>
              {fmtTime(item.createdAt)}
              {ext.edited ? ' · изменено' : ''}
            </Text>
            {item.pending ? <Ionicons name="time-outline" size={11} color={theme.warning} /> : null}
            {!item.pending && isFailed ? <Ionicons name="close-circle" size={11} color={theme.danger} /> : null}
            {!item.pending && !isFailed && item.mine ? (
              <Ionicons name={item.delivered ? 'checkmark-done' : 'checkmark'} size={12} color="rgba(26,18,6,0.62)" />
            ) : null}
            {secret ? <Ionicons name="lock-closed" size={9} color={item.mine ? 'rgba(26,18,6,0.62)' : theme.accent} /> : null}
          </View>
        </Pressable>

        {reactions.length ? (
          <View style={[styles.reactRow, item.mine ? { justifyContent: 'flex-end' } : { justifyContent: 'flex-start' }]}>
            {reactions.map((reaction) => (
              <MotiView
                key={`${reaction.emoji}-${reaction.count}-${reaction.mine ? 'm' : 'o'}`}
                from={{ scale: 0.7, opacity: 0.6 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={
                  reduced
                    ? { type: 'timing', duration: 0 }
                    : { damping: 14, stiffness: 340, mass: 0.7, type: 'spring' as const }
                }
              >
                <PressableScale
                  pressedScale={0.92}
                  onPress={() => onReactionPress?.(reaction.emoji)}
                  disabled={!onReactionPress}
                  accessibilityRole="button"
                  accessibilityLabel={`Реакция ${reaction.emoji}, ${reaction.count}`}
                  style={[
                    styles.reaction,
                    {
                      backgroundColor: reaction.mine ? theme.accentSoft : theme.surface,
                      borderColor: reaction.mine ? theme.accent : theme.line,
                    },
                  ]}
                >
                  <Text style={{ fontSize: 12.5 }}>{reaction.emoji}</Text>
                  <Text style={{ fontSize: 11.5, fontWeight: '700', color: reaction.mine ? theme.accent : theme.textSecondary }}>{reaction.count}</Text>
                </PressableScale>
              </MotiView>
            ))}
          </View>
        ) : null}

        {/* Пост канала: строка обсуждения под пузырём */}
        {onOpenComments ? (
          <Pressable
            onPress={onOpenComments}
            accessibilityRole="button"
            accessibilityLabel={
              commentsCount ? `Обсуждение, ${commentsCount} комментариев` : 'Открыть обсуждение поста'
            }
            hitSlop={6}
            style={({ pressed }) => [
              styles.commentsRow,
              item.mine ? { justifyContent: 'flex-end' } : { justifyContent: 'flex-start' },
              { opacity: pressed ? 0.65 : 1 },
            ]}
          >
            <Ionicons name="chatbubble-outline" size={13} color={theme.accent} />
            <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>
              {commentsCount && commentsCount > 0 ? `Обсуждение · ${commentsCount}` : 'Комментировать'}
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </MotiView>
  );
}

const styles = StyleSheet.create({
  systemRow: { alignItems: 'center', paddingHorizontal: 28, marginVertical: 7 },
  systemPress: { alignItems: 'center', maxWidth: 560 },
  systemText: { fontSize: 12.5, lineHeight: 17, textAlign: 'center' },
  systemTime: { fontSize: 10.5, marginTop: 2, opacity: 0.75 },
  row: { flexDirection: 'row', paddingHorizontal: 6, alignItems: 'flex-end' },
  rowMine: { justifyContent: 'flex-end' },
  avatarBtn: { marginRight: 6, marginBottom: 2 },
  avatarSpacer: { width: 34 },
  megaphoneBadge: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 13,
    height: 13,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubble: {
    paddingVertical: 7,
    paddingHorizontal: 12,
    minWidth: 64,
    borderWidth: 1,
  },
  bubbleFirst: { paddingTop: 8 },
  bubbleMedia: { paddingVertical: 5, paddingHorizontal: 5, minWidth: 0 },
  whoRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3, paddingHorizontal: 1 },
  who: { fontSize: 12.5, fontWeight: '700' },
  text: { fontSize: 15.5, lineHeight: 21 },
  quote: {
    borderLeftWidth: 3,
    borderRadius: 8,
    paddingLeft: 7,
    paddingRight: 6,
    paddingVertical: 3,
    marginBottom: 5,
    minWidth: 140,
  },
  progressTrack: { height: 3, borderRadius: 2, overflow: 'hidden', marginTop: 6 },
  progressFill: { height: 3, borderRadius: 2 },
  cancelRow: { alignSelf: 'flex-end', marginTop: 4, paddingHorizontal: 2, paddingVertical: 1 },
  failRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' },
  failText: { fontSize: 11.5, fontWeight: '700' },
  failAction: { fontSize: 11.5, fontWeight: '700', textDecorationLine: 'underline' },
  metaRow: { flexDirection: 'row', gap: 4, marginTop: 3, alignItems: 'center', justifyContent: 'flex-end' },
  meta: { fontSize: 10.5 },
  reactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3, paddingHorizontal: 2 },
  commentsRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, paddingHorizontal: 4, paddingVertical: 2 },
  reaction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  // На web запрещаем выделение текста: долгое нажатие открывает реакции.
  webNoSelect: {
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
  } as object,
});
