import React from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useIsWide } from '../../theme/useIsWide';
import { openMessageFile, type ViewMessage } from '../../data/messaging';

/** Uint8Array → data-URI (как в MessageBubble, но с чанками — без переполнения стека). */
function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  const view = bytes.subarray(0, Math.min(bytes.length, 400_000));
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    bin += String.fromCharCode(...Array.from(view.subarray(i, i + chunk)));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

interface MediaThumb {
  id: string;
  message: ViewMessage;
  name: string;
}

/** Галерея вложений: сетка изображений из сообщений + полноэкранный просмотр. */
export function AttachmentsGallery({
  visible,
  messages,
  onClose,
}: {
  visible: boolean;
  messages: ViewMessage[];
  onClose: () => void;
}) {
  const theme = useTheme();
  const wide = useIsWide();
  const [uris, setUris] = React.useState<Record<string, string>>({});
  const [failed, setFailed] = React.useState<Record<string, true>>({});
  const [loading, setLoading] = React.useState(false);
  const [viewer, setViewer] = React.useState<{ uri: string; name: string; id: string } | null>(null);

  const media = React.useMemo<MediaThumb[]>(
    () =>
      messages
        .filter((m) => m.kind === 'media' && m.file && m.file.mime.startsWith('image/'))
        .map((m) => ({ id: m.id, message: m, name: m.file?.name ?? 'Изображение' }))
        .slice(-48),
    [messages],
  );
  const mediaKey = media.map((m) => `${m.id}:${m.message.file?.mime ?? ''}`).join('|');

  React.useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      for (const m of media) {
        if (cancelled) return;
        if (uris[m.id] || failed[m.id]) continue;
        try {
          const opened = await openMessageFile(m.message);
          if (cancelled) return;
          if (!opened) {
            setFailed((prev) => ({ ...prev, [m.id]: true }));
            continue;
          }
          const uri = bytesToDataUri(opened.bytes, opened.mime);
          setUris((prev) => ({ ...prev, [m.id]: uri }));
        } catch {
          if (!cancelled) setFailed((prev) => ({ ...prev, [m.id]: true }));
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // uris/failed намеренно не в зависимостях — догрузка идёт одним проходом
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mediaKey]);

  React.useEffect(() => {
    if (!visible) {
      setViewer(null);
    }
  }, [visible]);

  const title = viewer ? 'Фото' : 'Вложения';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.root, { backgroundColor: theme.background }]}>
        <View style={[styles.topBar, { borderBottomColor: theme.line }]}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Закрыть галерею" hitSlop={8} style={styles.iconBtn}>
            <Ionicons name="close" size={24} color={theme.textPrimary} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: 16 }} numberOfLines={1}>
              {title}
            </Text>
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
              {media.length ? `${media.length} изображений` : 'Нет изображений'}
            </Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.grid}>
          {media.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="images-outline" size={42} color={theme.textDisabled} />
              <Text style={{ color: theme.textSecondary, marginTop: 10, fontSize: 14 }}>В этом чате пока нет вложений</Text>
            </View>
          ) : (
            media.map((m, index) => {
              const uri = uris[m.id];
              return (
                <MotiView
                  key={m.id}
                  from={{ opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: 'timing', duration: 180, delay: Math.min(index, 12) * 18 }}
                  style={[styles.tileWrap, { width: wide ? '24%' : '31.5%' }]}
                >
                  <Pressable
                    onPress={() => uri && setViewer({ uri, name: m.name, id: m.id })}
                    accessibilityRole="button"
                    accessibilityLabel="Открыть фотографию"
                    style={({ pressed }) => [styles.tile, { backgroundColor: theme.surface, borderColor: theme.line, opacity: pressed ? 0.85 : 1 }]}
                  >
                    {uri ? (
                      <Image source={{ uri }} style={StyleSheet.absoluteFill as never} resizeMode="cover" />
                    ) : failed[m.id] ? (
                      <Ionicons name="alert-circle-outline" size={24} color={theme.warning} />
                    ) : (
                      <ActivityIndicator color={theme.accent} />
                    )}
                  </Pressable>
                </MotiView>
              );
            })
          )}
        </ScrollView>

        {viewer ? (
          <MotiView from={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ type: 'timing', duration: 180 }} style={styles.viewer}>
            <Pressable style={StyleSheet.absoluteFill as never} onPress={() => setViewer(null)} accessibilityRole="button" accessibilityLabel="Закрыть просмотр" />
            <Image source={{ uri: viewer.uri }} style={styles.viewerImage} resizeMode="contain" />
            <Pressable onPress={() => setViewer(null)} accessibilityRole="button" accessibilityLabel="Закрыть" style={[styles.viewerClose, { backgroundColor: theme.overlay }]}>
              <Ionicons name="close" size={24} color="#fff" />
            </Pressable>
          </MotiView>
        ) : null}

        {loading && media.length > 0 && !viewer ? (
          <View style={[styles.loadingPill, { backgroundColor: theme.surfaceElevated, borderColor: theme.line }]}>
            <ActivityIndicator size="small" color={theme.accent} />
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Загружаем превью…</Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 44, paddingBottom: 10, paddingHorizontal: 12, borderBottomWidth: 1 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 8, paddingBottom: 40 },
  tileWrap: { aspectRatio: 1, padding: 3 },
  tile: { flex: 1, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  empty: { width: '100%', paddingVertical: 80, alignItems: 'center', justifyContent: 'center' },
  viewer: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.94)', alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
  viewerClose: { position: 'absolute', top: 44, right: 16, width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  loadingPill: {
    position: 'absolute',
    bottom: 20,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
});
