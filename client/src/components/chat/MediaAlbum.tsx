import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import { Avatar } from '../Avatar';
import { openMessageFile, type ViewMessage } from '../../data/messaging';
import { bytesToDataUri, MediaLightbox } from './MediaMessage';
import { roleColor } from './roles';

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Одна плитка альбома: лениво расшифровывает изображение и сообщает URI наверх. */
function AlbumTile({
  message,
  size,
  radius,
  onLoaded,
  onOpen,
}: {
  message: ViewMessage;
  size: number;
  radius: number;
  onLoaded: (id: string, uri: string) => void;
  onOpen: (id: string, uri: string) => void;
}) {
  const theme = useTheme();
  const [uri, setUri] = React.useState<string | null>(message.localPreview ?? null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (message.localPreview) {
      setUri(message.localPreview);
      onLoaded(message.id, message.localPreview);
      return undefined;
    }
    if (!message.file?.id) return undefined;
    void (async () => {
      try {
        const opened = await openMessageFile(message);
        if (!opened || cancelled) return;
        if (!opened.mime.toLowerCase().startsWith('image/')) return;
        const next = bytesToDataUri(opened.bytes, opened.mime);
        setUri(next);
        onLoaded(message.id, next);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // onLoaded намеренно не в зависимостях: загрузка идёт один раз на сообщение.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id, message.localPreview, message.file?.id]);

  const uploading = message.mine && message.pending && (message.uploadStage != null || (message.uploadProgress != null && message.uploadProgress < 1));

  return (
    <Pressable
      onPress={() => uri && onOpen(message.id, uri)}
      accessibilityRole="imagebutton"
      accessibilityLabel="Открыть фотографию из альбома"
      style={({ pressed }) => [
        { width: size, height: size, borderRadius: radius, overflow: 'hidden', backgroundColor: theme.surface, opacity: pressed ? 0.9 : 1 },
      ]}
    >
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFillObject as never} resizeMode="cover" />
      ) : failed ? (
        <View style={styles.tileCenter}>
          <Ionicons name="alert-circle-outline" size={20} color={theme.warning} />
        </View>
      ) : (
        <View style={styles.tileCenter}>
          <ActivityIndicator size="small" color={theme.accent} />
        </View>
      )}
      {uploading ? (
        <View style={[StyleSheet.absoluteFillObject, styles.tileOverlay]}>
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>
            {Math.round(Math.max(0, Math.min(1, message.uploadProgress ?? 0)) * 100)}%
          </Text>
        </View>
      ) : null}
      {message.file?.mime?.toLowerCase().startsWith('video/') ? (
        <View style={styles.playBadge}>
          <Ionicons name="play" size={13} color="#fff" />
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * Альбом: подряд идущие фото одного отправителя в одном блоке-сетке.
 * Показывает имя/роль один раз, общие время и просмотры, агрегированные реакции.
 */
export function MediaAlbum({
  messages,
  mine,
  role,
  channelTitle,
  viewsCount,
  onReactionPress,
  onOpenComments,
  commentsCount,
  avatar,
  nodeOnline,
  moduleOnline,
}: {
  messages: ViewMessage[];
  mine: boolean;
  role?: string | null;
  /** Заголовок канала для постов «от имени канала». */
  channelTitle?: string | null;
  viewsCount?: number;
  onReactionPress?: (emoji: string, message: ViewMessage) => void;
  onOpenComments?: () => void;
  commentsCount?: number;
  avatar?: { objectId: string; key: string; mime: string } | null;
  nodeOnline?: boolean;
  moduleOnline?: boolean;
}) {
  const theme = useTheme();
  const { width: screenW } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [uris, setUris] = React.useState<Record<string, string>>({});
  const [viewer, setViewer] = React.useState<{ id: string } | null>(null);

  const sender = messages[0]?.senderUsername ?? '';
  const asChannel = Boolean(channelTitle);
  const last = messages[messages.length - 1];
  const first = messages[0];

  const columns = messages.length === 2 ? 2 : messages.length === 3 ? 3 : messages.length === 4 ? 2 : 3;
  const albumW = Math.min(300, Math.max(190, screenW - 104));
  const gap = 3;
  const tile = Math.floor((albumW - gap * (columns - 1)) / columns);

  const items = messages
    .filter((m) => uris[m.id])
    .map((m) => ({ id: m.id, uri: uris[m.id], name: m.file?.name }));
  const viewerIndex = viewer ? Math.max(0, items.findIndex((it) => it.id === viewer.id)) : null;

  // Агрегируем реакции по всем фото альбома.
  const reactions = React.useMemo(() => {    const map = new Map<string, { emoji: string; count: number; mine: boolean }>();
    for (const m of messages) {
      for (const r of m.reactions ?? []) {
        const cur = map.get(r.emoji);
        if (cur) {
          cur.count += r.count;
          cur.mine = cur.mine || r.mine;
        } else {
          map.set(r.emoji, { emoji: r.emoji, count: r.count, mine: r.mine });
        }
      }
    }
    return Array.from(map.values());
  }, [messages]);

  // Длительность видео (если в альбоме есть видео) недоступна без загрузки — показываем только фото.
  return (
    <MotiView
      from={reduced ? { opacity: 1 } : { opacity: 0, translateY: mine ? 18 : 8 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : { type: 'spring', damping: 24, stiffness: 260 }}
      style={[styles.row, mine ? styles.rowMine : null]}
    >
      {!mine ? (
        <View style={styles.albumAvatar}>
          <Avatar
            name={(asChannel ? channelTitle : sender) || '?'}
            size={28}
            nodeOnline={nodeOnline}
            moduleOnline={moduleOnline}
            avatar={asChannel ? null : avatar}
          />
        </View>
      ) : null}
      <View style={[styles.content, { maxWidth: mine ? '86%' : '76%' }, mine ? { alignItems: 'flex-end' } : { alignItems: 'flex-start' }]}>
        {!mine && (asChannel || sender) ? (
          <View style={styles.whoRow}>
            {asChannel ? <Ionicons name="megaphone" size={12} color={theme.accent} /> : null}
            <Text
              style={{ color: asChannel ? theme.accent : roleColor(theme, role), fontSize: 12.5, fontWeight: '700' }}
              numberOfLines={1}
            >
              {asChannel ? channelTitle : sender}
            </Text>
          </View>
        ) : null}

        <View style={[styles.grid, { width: albumW, gap }]}>
          {messages.map((m) => (
            <AlbumTile
              key={m.id}
              message={m}
              size={tile}
              radius={10}
              onLoaded={(id, uri) =>
                setUris((prev) => (prev[id] === uri ? prev : { ...prev, [id]: uri }))
              }
              onOpen={(id) => setViewer({ id })}
            />
          ))}
        </View>

        <View style={[styles.metaRow, mine ? { justifyContent: 'flex-end' } : null]}>
          {viewsCount != null ? (
            <>
              <Ionicons name="eye-outline" size={12} color={theme.textSecondary} />
              <Text style={{ color: theme.textSecondary, fontSize: 11 }}>{viewsCount}</Text>
            </>
          ) : null}
          {first?.scheme === 'e2e' ? <Ionicons name="lock-closed" size={10} color={theme.accent} /> : null}
          <Text style={{ color: theme.textSecondary, fontSize: 10.5 }}>
            {fmtTime(last?.createdAt ?? first?.createdAt ?? '')}
          </Text>
          {last?.pending ? <Ionicons name="time-outline" size={11} color={theme.warning} /> : null}
          {!last?.pending && last?.mine ? (
            <Ionicons name={last.delivered ? 'checkmark-done' : 'checkmark'} size={12} color={theme.textSecondary} />
          ) : null}
        </View>

        {reactions.length ? (
          <View style={[styles.reactRow, mine ? { justifyContent: 'flex-end' } : null]}>
            {reactions.map((r) => (
              <Pressable
                key={r.emoji}
                onPress={() => onReactionPress?.(r.emoji, first)}
                disabled={!onReactionPress}
                accessibilityRole="button"
                accessibilityLabel={`Реакция ${r.emoji}, ${r.count}`}
                style={[
                  styles.reaction,
                  {
                    backgroundColor: r.mine ? theme.accentSoft : theme.surface,
                    borderColor: r.mine ? theme.accent : theme.line,
                  },
                ]}
              >
                <Text style={{ fontSize: 12.5 }}>{r.emoji}</Text>
                <Text style={{ fontSize: 11.5, fontWeight: '700', color: r.mine ? theme.accent : theme.textSecondary }}>{r.count}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {onOpenComments ? (
          <Pressable
            onPress={onOpenComments}
            accessibilityRole="button"
            accessibilityLabel={commentsCount ? `Обсуждение, ${commentsCount} комментариев` : 'Открыть обсуждение поста'}
            hitSlop={6}
            style={({ pressed }) => [
              styles.commentsRow,
              mine ? { justifyContent: 'flex-end' } : null,
              { opacity: pressed ? 0.65 : 1 },
            ]}
          >
            <Ionicons name="chatbubble-outline" size={13} color={theme.accent} />
            <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }} numberOfLines={1}>
              {commentsCount && commentsCount > 0 ? `Обсуждение · ${commentsCount}` : 'Комментировать'}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <MediaLightbox items={items} index={viewerIndex} onClose={() => setViewer(null)} />
    </MotiView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: 6, marginTop: 8 },
  rowMine: { justifyContent: 'flex-end' },
  content: { maxWidth: '86%' },
  albumAvatar: { marginRight: 6, marginTop: 2, alignSelf: 'flex-start' },
  whoRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4, paddingHorizontal: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tileCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tileOverlay: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(5,9,15,0.42)' },
  playBadge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, paddingHorizontal: 2 },
  reactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3, paddingHorizontal: 2 },
  reaction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  commentsRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, paddingHorizontal: 4, paddingVertical: 2 },
});
