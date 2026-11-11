import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { openMessageFile, type ViewMessage } from '../../data/messaging';
import { saveToDevice } from '../../data/files';
import { useStore } from '../../state/useStore';
import { GlassCard, GlassSectionTitle } from '../profile/Glass';

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
}

function iconFor(mime?: string): keyof typeof Ionicons.glyphMap {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('image/')) return 'image-outline';
  if (m.startsWith('video/')) return 'videocam-outline';
  if (m.startsWith('audio/')) return 'musical-notes-outline';
  if (m.includes('pdf')) return 'document-text-outline';
  if (m.includes('zip') || m.includes('archive')) return 'archive-outline';
  return 'document-attach-outline';
}

/** Вкладка «Файлы»: все вложения чата с расшифровкой и скачиванием. */
export function FilesTab({ messages }: { messages: ViewMessage[] }) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = React.useState<Record<string, true>>({});

  const files = React.useMemo(() => messages.filter((m) => m.kind === 'media' && m.file).slice().reverse(), [messages]);

  async function download(message: ViewMessage) {
    if (!message.file) return;
    setBusy((prev) => ({ ...prev, [message.id]: true }));
    try {
      const opened = await openMessageFile(message);
      if (!opened) throw new Error('empty');
      await saveToDevice(opened.name, opened.mime, opened.bytes);
      pushToast({ kind: 'success', message: 'Файл расшифрован и сохранён' });
    } catch {
      pushToast({ kind: 'error', message: 'Не удалось получить файл' });
    } finally {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[message.id];
        return next;
      });
    }
  }

  if (!files.length) {
    return (
      <GlassCard>
        <View style={{ alignItems: 'center', gap: 8, paddingVertical: 22 }}>
          <Ionicons name="document-outline" size={34} color={theme.textDisabled} />
          <Text style={{ color: theme.textSecondary, fontSize: 13 }}>Вложений пока нет</Text>
        </View>
      </GlassCard>
    );
  }

  return (
    <GlassCard padding={10}>
      <GlassSectionTitle title={`Файлы · ${files.length}`} />
      <View style={{ gap: 4 }}>
        {files.map((message) => {
          const file = message.file!;
          return (
            <Pressable
              key={message.id}
              onPress={() => void download(message)}
              accessibilityRole="button"
              accessibilityLabel={`Скачать ${file.name}`}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? theme.surfacePressed : 'transparent', opacity: busy[message.id] ? 0.6 : 1 },
              ]}
            >
              <View style={[styles.iconBox, { backgroundColor: theme.accentSoft }]}>
                <Ionicons name={iconFor(file.mime)} size={17} color={theme.accent} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
                  {file.name}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }}>
                  {formatSize(file.size)}
                  {file.mime ? ` · ${file.mime}` : ''}
                  {message.senderUsername ? ` · @${message.senderUsername}` : ''}
                </Text>
              </View>
              <Ionicons name={busy[message.id] ? 'hourglass-outline' : 'download-outline'} size={18} color={theme.textSecondary} />
            </Pressable>
          );
        })}
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 10, minHeight: 52 },
  iconBox: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
