import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import { openMessageFile, type ViewMessage } from '../../data/messaging';
import { saveToDevice } from '../../data/files';

/** Размеры медиа-пузыря: крупное фото, но не на весь экран. */
const MEDIA_W = 268;
const MEDIA_MAX_H = 360;
const MEDIA_MIN_H = 130;

/** Uint8Array → data-URI с безопасной нарезкой по 32 КБ (без переполнения стека). */
export function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

export function formatSize(bytes?: number): string {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function formatDuration(sec?: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function isImageMessage(m: ViewMessage): boolean {
  if (m.kind !== 'media') return false;
  const mime = (m.file?.mime ?? '').toLowerCase();
  return Boolean(m.localPreview) || mime.startsWith('image/');
}

/** Полноэкранный просмотр изображений (одно или альбом). */
export function MediaLightbox({
  items,
  index,
  onClose,
}: {
  items: { id: string; uri: string; name?: string }[];
  /** null — просмотр закрыт. */
  index: number | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [current, setCurrent] = React.useState(index ?? 0);

  React.useEffect(() => {
    if (index != null) setCurrent(index);
  }, [index]);

  if (index == null || !items.length) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.lightboxRoot}>
        <FlatList
          key={`lb-${index}-${items.length}`}
          data={items}
          horizontal
          pagingEnabled
          initialScrollIndex={Math.min(index, items.length - 1)}
          getItemLayout={(_d, i) => ({ length: width, offset: width * i, index: i })}
          keyExtractor={(it) => it.id}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => setCurrent(Math.round(e.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => (
            <View style={{ width, height: '100%', alignItems: 'center', justifyContent: 'center' }}>
              <Image source={{ uri: item.uri }} style={{ width, height: '100%' }} resizeMode="contain" />
            </View>
          )}
        />
        <View style={styles.lightboxTop}>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }} numberOfLines={1}>
            {items.length > 1 ? `${current + 1} / ${items.length}` : ''}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Закрыть просмотр"
            hitSlop={8}
            style={[styles.lightboxClose, { backgroundColor: theme.overlay }]}
          >
            <Ionicons name="close" size={24} color="#fff" />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** Одиночное изображение: крупный кадр + прогресс + полноэкранный просмотр. */
function MediaImage({
  item,
  previewUri,
  uploading,
  progressPct,
  stageLabel,
  onPress,
  width = MEDIA_W,
}: {
  item: ViewMessage;
  previewUri?: string;
  uploading?: boolean;
  progressPct?: number;
  stageLabel?: string | null;
  onPress: (uri: string) => void;
  width?: number;
}) {
  const theme = useTheme();
  const [loadedUri, setLoadedUri] = React.useState<string | null>(null);
  const [aspect, setAspect] = React.useState(4 / 3);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    if (previewUri || !item.file?.id) return undefined;
    void (async () => {
      try {
        const opened = await openMessageFile(item);
        if (!opened || cancelled) return;
        if (opened.mime.toLowerCase().startsWith('image/')) {
          setLoadedUri(bytesToDataUri(opened.bytes, opened.mime));
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id, item.file?.id, previewUri]);

  const uri = previewUri ?? loadedUri;
  const height = Math.max(MEDIA_MIN_H, Math.min(MEDIA_MAX_H, width / aspect));

  if (!uri) {
    const pendingUpload = Boolean(uploading);
    return (
      <View style={[styles.mediaFrame, { width, height: 170, backgroundColor: theme.surface }]}>
        {pendingUpload ? (
          <>
            <Text style={{ color: theme.textPrimary, fontSize: 17, fontWeight: '800' }}>{progressPct ?? 0}%</Text>
            <Text style={{ color: theme.textSecondary, fontSize: 11.5 }}>{stageLabel ?? 'Отправляем'}…</Text>
          </>
        ) : failed || !item.file?.id ? (
          <>
            <Ionicons name="alert-circle-outline" size={26} color={theme.warning} />
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Фото недоступно</Text>
          </>
        ) : (
          <ActivityIndicator color={theme.accent} />
        )}
      </View>
    );
  }

  return (
    <Pressable
      onPress={() => onPress(uri)}
      accessibilityRole="imagebutton"
      accessibilityLabel="Открыть фотографию"
      style={({ pressed }) => [{ width, height, borderRadius: 14, overflow: 'hidden', opacity: pressed ? 0.92 : 1 }]}
    >
      <Image
        source={{ uri }}
        style={{ width: '100%', height: '100%', backgroundColor: theme.surface }}
        resizeMode="cover"
        onLoad={(e) => {
          const src = (e as unknown as { nativeEvent?: { source?: { width?: number; height?: number } } }).nativeEvent?.source;
          if (src?.width && src?.height) setAspect(src.width / src.height);
        }}
      />
      {uploading ? (
        <View style={[StyleSheet.absoluteFillObject, styles.mediaOverlay]}>
          <Text style={styles.overlayPct}>{progressPct ?? 0}%</Text>
          <Text style={styles.overlayStage}>{stageLabel ?? 'Отправляем'}…</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Видео: карточка с play, на web — blob URL и <video controls>, на native — скачивание. */
function MediaVideo({ item, width = MEDIA_W }: { item: ViewMessage; width?: number }) {
  const theme = useTheme();
  const [uri, setUri] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [duration, setDuration] = React.useState<number | null>(null);
  const [poster, setPoster] = React.useState<string | null>(null);

  const web = Platform.OS === 'web';

  const prepare = React.useCallback(async () => {
    if (!item.file?.id) return;
    if (uri) return;
    setLoading(true);
    setError(false);
    try {
      const opened = await openMessageFile(item);
      if (!opened) {
        setError(true);
        return;
      }
      if (!web) {
        // Нативный плеер не подключаем: сохраняем расшифрованный файл в кэш.
        await saveToDevice(opened.name, opened.mime, opened.bytes);
        return;
      }
      const blob = new Blob([opened.bytes as unknown as BlobPart], { type: opened.mime || 'video/mp4' });
      const url = URL.createObjectURL(blob);
      setUri(url);
      // Метаданные/первый кадр: скрытый <video> без отображения.
      try {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.muted = true;
        probe.src = url;
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          probe.onloadedmetadata = done;
          probe.onerror = done;
          setTimeout(done, 4000);
        });
        if (Number.isFinite(probe.duration) && probe.duration > 0) setDuration(probe.duration);
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          probe.onseeked = done;
          probe.onloadeddata = () => {
            try {
              probe.currentTime = Math.min(0.2, Math.max(0, probe.duration / 10));
            } catch {
              done();
            }
          };
          setTimeout(done, 4000);
        });
        try {
          const canvas = document.createElement('canvas');
          canvas.width = probe.videoWidth || 320;
          canvas.height = probe.videoHeight || 180;
          const ctx = canvas.getContext('2d');
          if (ctx && canvas.width && canvas.height) {
            ctx.drawImage(probe, 0, 0, canvas.width, canvas.height);
            setPoster(canvas.toDataURL('image/jpeg', 0.7));
          }
        } catch {
          /* кадр не критичен */
        }
        probe.removeAttribute('src');
        probe.load();
      } catch {
        /* метаданные недоступны */
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [item, uri, web]);

  React.useEffect(
    () => () => {
      if (uri && web) URL.revokeObjectURL(uri);
    },
    [uri, web],
  );

  if (uri && web) {
    return (
      <View style={{ width, borderRadius: 14, overflow: 'hidden', backgroundColor: '#000' }}>
        {React.createElement('video', {
          src: uri,
          controls: true,
          autoPlay: true,
          playsInline: true,
          poster: poster ?? undefined,
          style: { width, height: 190, display: 'block', backgroundColor: '#000' },
        })}
      </View>
    );
  }

  const shownPoster = poster;
  return (
    <Pressable
      onPress={() => void prepare()}
      accessibilityRole="button"
      accessibilityLabel="Воспроизвести видео"
      style={({ pressed }) => [
        styles.videoCard,
        { width, backgroundColor: theme.surface, borderColor: theme.line, opacity: pressed ? 0.9 : 1 },
      ]}
    >
      {shownPoster ? <Image source={{ uri: shownPoster }} style={StyleSheet.absoluteFillObject as never} resizeMode="cover" /> : null}
      <View style={[StyleSheet.absoluteFillObject, shownPoster ? { backgroundColor: 'rgba(0,0,0,0.28)' } : null]} />
      <View style={styles.playCircle}>
        {loading ? <ActivityIndicator color="#fff" /> : <Ionicons name={error ? 'alert-circle' : 'play'} size={30} color="#fff" />}
      </View>
      <View style={styles.videoFooter}>
        <Ionicons name="videocam" size={13} color="rgba(255,255,255,0.9)" />
        <Text style={{ color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: '600' }}>
          {error ? 'Видео недоступно' : duration ? formatDuration(duration) : 'Видео'}
        </Text>
        {!web && !loading ? (
          <Text style={{ color: 'rgba(255,255,255,0.82)', fontSize: 11.5, marginLeft: 'auto' }}>Открыть</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Голосовое сообщение (audio/*): карточка с воспроизведением на web. */
function MediaAudio({ item, width = MEDIA_W }: { item: ViewMessage; width?: number }) {
  const theme = useTheme();
  const [playing, setPlaying] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [duration, setDuration] = React.useState<number | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const urlRef = React.useRef<string | null>(null);

  const toggle = React.useCallback(async () => {
    if (Platform.OS !== 'web') {
      try {
        const opened = await openMessageFile(item);
        if (opened) await saveToDevice(opened.name, opened.mime, opened.bytes);
      } catch {
        /* не критично */
      }
      return;
    }
    if (audioRef.current) {
      if (playing) {
        audioRef.current.pause();
        setPlaying(false);
      } else {
        void audioRef.current.play();
        setPlaying(true);
      }
      return;
    }
    setLoading(true);
    try {
      const opened = await openMessageFile(item);
      if (!opened) return;
      const blob = new Blob([opened.bytes as unknown as BlobPart], { type: opened.mime || 'audio/webm' });
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
      };
      audio.onended = () => setPlaying(false);
      audio.onpause = () => setPlaying(false);
      audio.onplay = () => setPlaying(true);
      await audio.play();
    } catch {
      /* автовоспроизведение может быть заблокировано */
    } finally {
      setLoading(false);
    }
  }, [item, playing]);

  React.useEffect(
    () => () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  return (
    <Pressable
      onPress={() => void toggle()}
      accessibilityRole="button"
      accessibilityLabel="Голосовое сообщение"
      style={({ pressed }) => [
        styles.audioCard,
        { width, backgroundColor: theme.surface, borderColor: theme.line, opacity: pressed ? 0.9 : 1 },
      ]}
    >
      <View style={[styles.audioPlay, { backgroundColor: theme.accent }]}>
        {loading ? <ActivityIndicator size="small" color={theme.onAccent} /> : <Ionicons name={playing ? 'pause' : 'play'} size={18} color={theme.onAccent} />}
      </View>
      <View style={{ flex: 1, gap: 5 }}>
        <View style={styles.waveRow}>
          {Array.from({ length: 22 }).map((_, i) => (
            <View
              key={i}
              style={{
                width: 2.5,
                borderRadius: 2,
                height: 6 + ((i * 7) % 15),
                backgroundColor: playing && i < 10 ? theme.accent : theme.line,
              }}
            />
          ))}
        </View>
        <Text style={{ color: theme.textSecondary, fontSize: 11.5 }}>
          <Ionicons name="mic" size={11} color={theme.textSecondary} /> Голосовое · {formatDuration(duration) || '—'}
        </Text>
      </View>
    </Pressable>
  );
}

/** Компактная карточка документа: имя и размер остаются, как в Telegram. */
function MediaDocument({ item, width = MEDIA_W }: { item: ViewMessage; width?: number }) {
  const theme = useTheme();
  const name = item.file?.name ?? 'Файл';
  const mime = (item.file?.mime ?? '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  const icon: keyof typeof Ionicons.glyphMap = mime.includes('pdf') || ext === 'pdf'
    ? 'document-text'
    : mime.startsWith('audio/')
      ? 'musical-notes'
      : mime.includes('zip') || ext === 'zip' || ext === 'rar' || ext === '7z'
        ? 'archive'
        : mime.includes('sheet') || ext === 'xls' || ext === 'xlsx' || ext === 'csv'
          ? 'grid'
          : 'document';
  const [busy, setBusy] = React.useState(false);

  return (
    <Pressable
      onPress={async () => {
        if (busy || !item.file?.id) return;
        setBusy(true);
        try {
          const opened = await openMessageFile(item);
          if (opened) await saveToDevice(opened.name, opened.mime, opened.bytes);
        } finally {
          setBusy(false);
        }
      }}
      accessibilityRole="button"
      accessibilityLabel={`Скачать файл ${name}`}
      style={({ pressed }) => [
        styles.docCard,
        { width, backgroundColor: theme.surface, borderColor: theme.line, opacity: pressed ? 0.9 : 1 },
      ]}
    >
      <View style={[styles.docIcon, { backgroundColor: theme.accentSoft }]}>
        <Ionicons name={icon} size={20} color={theme.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
          {name}
        </Text>
        <Text style={{ color: theme.textSecondary, fontSize: 11.5 }}>
          {formatSize(item.file?.size) || ext.toUpperCase() || 'Файл'}
        </Text>
      </View>
      <View style={[styles.docDownload, { backgroundColor: theme.surfacePressed }]}>
        {busy ? <ActivityIndicator size="small" color={theme.accent} /> : <Ionicons name="download-outline" size={17} color={theme.accent} />}
      </View>
    </Pressable>
  );
}

/**
 * Медиа-содержимое пузыря: фото, видео, голосовое или документ.
 * Имена файлов у фото/видео не показываются — только у документов.
 */
export function MediaMessage({
  item,
  previewUri,
  uploading,
  progressPct,
  stageLabel,
}: {
  item: ViewMessage;
  previewUri?: string;
  uploading?: boolean;
  progressPct?: number;
  stageLabel?: string | null;
}) {
  const theme = useTheme();
  const { width: screenW } = useWindowDimensions();
  // Крупное фото, но не шире доступной колонки на маленьких экранах.
  const mediaW = Math.min(MEDIA_W, Math.max(190, screenW - 118));
  const [viewerUri, setViewerUri] = React.useState<string | null>(null);
  const mime = (item.file?.mime ?? '').toLowerCase();

  React.useEffect(() => {
    setViewerUri(null);
  }, [item.id]);

  if (!item.file && !previewUri) {
    return (
      <View style={[styles.mediaFrame, { width: mediaW, height: 90, backgroundColor: theme.surface }]}>
        <Ionicons name="cloud-offline-outline" size={22} color={theme.textDisabled} />
        <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Вложение недоступно</Text>
      </View>
    );
  }

  if (isImageMessage(item) || mime.startsWith('image/')) {
    return (
      <>
        <MediaImage
          item={item}
          previewUri={previewUri}
          uploading={uploading}
          progressPct={progressPct}
          stageLabel={stageLabel}
          onPress={setViewerUri}
          width={mediaW}
        />
        <MediaLightbox
          items={viewerUri ? [{ id: item.id, uri: viewerUri, name: item.file?.name }] : []}
          index={viewerUri ? 0 : null}
          onClose={() => setViewerUri(null)}
        />
      </>
    );
  }

  if (mime.startsWith('video/')) {
    return <MediaVideo item={item} width={mediaW} />;
  }

  if (mime.startsWith('audio/') && (item.file?.name ?? '').toLowerCase().startsWith('voice-')) {
    return <MediaAudio item={item} width={mediaW} />;
  }

  return <MediaDocument item={item} width={mediaW} />;
}

/** Лёгкая анимация появления медиа внутри пузыря. */
export function MediaAppear({ children, mine }: { children: React.ReactNode; mine: boolean }) {
  const reduced = useReducedMotion();
  return (
    <MotiView
      from={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.97, translateY: mine ? 6 : 2 }}
      animate={{ opacity: 1, scale: 1, translateY: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : { type: 'spring', damping: 22, stiffness: 280 }}
    >
      {children}
    </MotiView>
  );
}

const styles = StyleSheet.create({
  mediaFrame: { borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 6, overflow: 'hidden' },
  mediaOverlay: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(5,9,15,0.42)', gap: 2 },
  overlayPct: { color: '#fff', fontSize: 18, fontWeight: '800' },
  overlayStage: { color: 'rgba(255,255,255,0.86)', fontSize: 11.5, fontWeight: '600' },
  videoCard: { height: 190, borderRadius: 14, borderWidth: 1, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  playCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoFooter: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  audioCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 14, borderWidth: 1 },
  audioPlay: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  waveRow: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 22 },
  docCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 9, borderRadius: 14, borderWidth: 1 },
  docIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  docDownload: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  lightboxRoot: { flex: 1, backgroundColor: 'rgba(0,0,0,0.96)' },
  lightboxTop: {
    position: 'absolute',
    top: 44,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  lightboxClose: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
