import React from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useIsWide } from '../../theme/useIsWide';
import { useReducedMotion } from '../useReducedMotion';
import { openMessageFile, type ViewMessage } from '../../data/messaging';
import { GlassCard } from '../profile/Glass';

function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  const view = bytes.subarray(0, Math.min(bytes.length, 400_000));
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < view.length; i += chunk) {
    bin += String.fromCharCode(...Array.from(view.subarray(i, i + chunk)));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

/** Вкладка «Медиа»: сетка изображений из сообщений и полноэкранный просмотр. */
export function MediaTab({ messages }: { messages: ViewMessage[] }) {
  const theme = useTheme();
  const wide = useIsWide();
  const reduced = useReducedMotion();
  const [uris, setUris] = React.useState<Record<string, string>>({});
  const [failed, setFailed] = React.useState<Record<string, true>>({});
  const [viewer, setViewer] = React.useState<{ uri: string; name: string } | null>(null);

  const media = React.useMemo(
    () => messages.filter((m) => m.kind === 'media' && m.file && (m.file.mime || '').startsWith('image/')).slice(-60),
    [messages],
  );
  const mediaKey = media.map((m) => `${m.id}:${m.file?.mime ?? ''}`).join('|');

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const message of media) {
        if (cancelled) return;
        if (uris[message.id] || failed[message.id]) continue;
        try {
          const opened = await openMessageFile(message);
          if (cancelled) return;
          if (!opened) {
            setFailed((prev) => ({ ...prev, [message.id]: true }));
            continue;
          }
          const uri = bytesToDataUri(opened.bytes, opened.mime);
          setUris((prev) => ({ ...prev, [message.id]: uri }));
        } catch {
          if (!cancelled) setFailed((prev) => ({ ...prev, [message.id]: true }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // uris/failed намеренно не в зависимостях — догружаем одним проходом
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey]);

  if (!media.length) {
    return (
      <GlassCard>
        <View style={{ alignItems: 'center', gap: 8, paddingVertical: 22 }}>
          <Ionicons name="images-outline" size={34} color={theme.textDisabled} />
          <Text style={{ color: theme.textSecondary, fontSize: 13 }}>В этом чате пока нет изображений</Text>
        </View>
      </GlassCard>
    );
  }

  return (
    <>
      <GlassCard padding={8}>
        <View style={styles.grid}>
          {media.map((m, index) => {
            const uri = uris[m.id];
            const width = wide ? '16%' : '24%';
            return (
              <MotiView
                key={m.id}
                from={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: 'timing', duration: reduced ? 0 : 200, delay: reduced ? 0 : Math.min(index, 10) * 22 }}
                style={{ width: width as `${number}%`, aspectRatio: 1, padding: 3 }}
              >
                <Pressable
                  onPress={() => uri && setViewer({ uri, name: m.file?.name ?? 'Изображение' })}
                  accessibilityRole="button"
                  accessibilityLabel={`Открыть ${m.file?.name ?? 'изображение'}`}
                  style={({ pressed }) => [styles.tile, { backgroundColor: theme.surfacePressed, borderColor: theme.line, opacity: pressed ? 0.82 : 1 }]}
                >
                  {uri ? (
                    <Image source={{ uri }} style={StyleSheet.absoluteFill as never} resizeMode="cover" />
                  ) : failed[m.id] ? (
                    <Ionicons name="alert-circle-outline" size={22} color={theme.warning} />
                  ) : (
                    <ActivityIndicator size="small" color={theme.accent} />
                  )}
                </Pressable>
              </MotiView>
            );
          })}
        </View>
      </GlassCard>

      <Modal visible={Boolean(viewer)} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <View style={styles.viewer}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setViewer(null)} accessibilityRole="button" accessibilityLabel="Закрыть просмотр" />
          {viewer ? <Image source={{ uri: viewer.uri }} style={styles.viewerImage} resizeMode="contain" /> : null}
          <Pressable
            onPress={() => setViewer(null)}
            accessibilityRole="button"
            accessibilityLabel="Закрыть"
            style={[styles.viewerClose, { backgroundColor: 'rgba(0,0,0,0.55)' }]}
          >
            <Ionicons name="close" size={24} color="#fff" />
          </Pressable>
          {viewer ? (
            <Text style={styles.viewerName} numberOfLines={1}>
              {viewer.name}
            </Text>
          ) : null}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { flex: 1, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  viewer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
  viewerClose: { position: 'absolute', top: 44, right: 16, width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  viewerName: { position: 'absolute', bottom: 30, left: 20, right: 20, color: 'rgba(255,255,255,0.8)', fontSize: 13, textAlign: 'center' },
});
