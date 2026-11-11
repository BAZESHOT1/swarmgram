import React from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import type { PickedFile } from '../file';

const fmtSec = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

/**
 * Голосовые сообщения (только web): MediaRecorder + getUserMedia.
 * На нативных платформах компонент ничего не рендерит — без фейковых кнопок.
 */
export function VoiceRecorder({
  onSend,
  onError,
  disabled,
}: {
  onSend: (file: PickedFile) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const [supported, setSupported] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const [seconds, setSeconds] = React.useState(0);
  const [busy, setBusy] = React.useState(false);

  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const cancelledRef = React.useRef(false);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    setSupported(
      Platform.OS === 'web' &&
        typeof navigator !== 'undefined' &&
        typeof MediaRecorder !== 'undefined' &&
        Boolean(navigator.mediaDevices?.getUserMedia),
    );
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      cancelledRef.current = true;
      try {
        recorderRef.current?.stop();
      } catch {
        /* уже остановлен */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const cleanup = React.useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    if (mountedRef.current) {
      setActive(false);
      setBusy(false);
      setSeconds(0);
    }
  }, []);

  const start = React.useCallback(async () => {
    if (disabled || active) return;
    cancelledRef.current = false;
    chunksRef.current = [];
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      const mime = preferred.find((m) => {
        try {
          return MediaRecorder.isTypeSupported(m);
        } catch {
          return false;
        }
      });
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const wasCancelled = cancelledRef.current;
        const type = recorder.mimeType || mime || 'audio/webm';
        const parts = chunksRef.current.slice();
        cleanup();
        if (wasCancelled || !mountedRef.current) return;
        const blob = new Blob(parts, { type });
        if (!blob.size) {
          onError?.('Запись пустая — попробуйте ещё раз');
          return;
        }
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
          onSend({ name: `voice-${Date.now()}.${ext}`, mime: type.split(';')[0] || 'audio/webm', bytes });
        } catch {
          onError?.('Не удалось подготовить голосовое сообщение');
        }
      };

      recorder.start(250);
      setActive(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch {
      cleanup();
      onError?.('Нет доступа к микрофону — разрешите запись звука в браузере');
    }
  }, [active, cleanup, disabled, onError, onSend]);

  const finish = React.useCallback(() => {
    if (!recorderRef.current) return;
    cancelledRef.current = false;
    setBusy(true);
    try {
      recorderRef.current.stop();
    } catch {
      cleanup();
    }
  }, [cleanup]);

  const cancel = React.useCallback(() => {
    cancelledRef.current = true;
    try {
      recorderRef.current?.stop();
    } catch {
      cleanup();
    }
  }, [cleanup]);

  if (!supported) return null;

  return (
    <>
      <Pressable
        onPress={() => void start()}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="Записать голосовое сообщение"
        hitSlop={6}
        style={({ pressed }) => [
          styles.mic,
          { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
        ]}
      >
        <Ionicons name="mic-outline" size={21} color={theme.textSecondary} />
      </Pressable>

      <Modal visible={active} transparent animationType="fade" onRequestClose={cancel}>
        <View style={[styles.root, { backgroundColor: theme.overlay }]}>
          <MotiView
            from={reduced ? { opacity: 1 } : { opacity: 0, translateY: 24 }}
            animate={{ opacity: 1, translateY: 0 }}
            transition={reduced ? { type: 'timing', duration: 0 } : { type: 'spring', damping: 24, stiffness: 300 }}
            style={[styles.panel, { backgroundColor: theme.surfaceElevated, borderColor: theme.line, ...theme.shadow }]}
          >
            <View style={styles.statusRow}>
              <View style={styles.recDot} />
              <Text style={{ color: theme.textPrimary, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] }}>
                {fmtSec(seconds)}
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5 }}>Запись голосового…</Text>
            </View>
            <View style={styles.wave}>
              {Array.from({ length: 28 }).map((_, i) => (
                <View
                  key={i}
                  style={{
                    width: 3,
                    borderRadius: 2,
                    height: 8 + ((i * 11 + seconds * 7) % 20),
                    backgroundColor: i % 3 === 0 ? theme.accent : theme.line,
                  }}
                />
              ))}
            </View>
            <View style={styles.actions}>
              <Pressable
                onPress={cancel}
                accessibilityRole="button"
                accessibilityLabel="Отменить запись"
                style={({ pressed }) => [styles.actionBtn, { backgroundColor: theme.dangerSoft, opacity: pressed ? 0.8 : 1 }]}
              >
                <Ionicons name="trash-outline" size={20} color={theme.danger} />
                <Text style={{ color: theme.danger, fontSize: 13, fontWeight: '700' }}>Отмена</Text>
              </Pressable>
              <Pressable
                onPress={finish}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Отправить голосовое"
                style={({ pressed }) => [
                  styles.sendBtn,
                  { backgroundColor: theme.accent, opacity: busy ? 0.6 : pressed ? 0.85 : 1 },
                ]}
              >
                <Ionicons name="paper-plane" size={18} color={theme.onAccent} />
                <Text style={{ color: theme.onAccent, fontSize: 13.5, fontWeight: '700' }}>Отправить</Text>
              </Pressable>
            </View>
          </MotiView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  mic: { width: 34, height: 42, alignItems: 'center', justifyContent: 'center' },
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  panel: { width: '100%', maxWidth: 420, borderRadius: 20, borderWidth: 1, padding: 18, gap: 16 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#F2555A' },
  wave: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, height: 30 },
  actions: { flexDirection: 'row', gap: 10 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  sendBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 44,
    borderRadius: 12,
  },
});
