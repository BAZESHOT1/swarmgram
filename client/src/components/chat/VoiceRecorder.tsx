/**
 * Кнопка голосового сообщения (как в Telegram):
 *  - удержание — запись, отпускание — отправка;
 *  - над кнопкой мигает стрелка вверх: повести палец вверх — запись фиксируется и идёт без удержания;
 *  - зафиксированную запись отправляет повторное нажатие на кнопку; увести влево — отмена.
 * Web — MediaRecorder, iOS/Android — expo-av (m4a).
 */
import React from 'react';
import { Animated, PanResponder, Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import { Glass, GLASS_FILL_BUTTON } from '../Glass';
import type { PickedFile } from '../file';

const fmtSec = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const LOCK_DY = -60;
const CANCEL_DX = -110;

/* ------------------------------------------------------------ движок записи */
interface Engine {
  start(): Promise<void>;
  /** Остановить; cancel=true — выбросить запись. */
  stop(cancel: boolean): Promise<PickedFile | null>;
}

function webEngine(): Engine {
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let mime = '';
  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
      mime = preferred.find((m) => {
        try {
          return MediaRecorder.isTypeSupported(m);
        } catch {
          return false;
        }
      }) ?? '';
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.start(250);
    },
    stop(cancel) {
      return new Promise((resolve) => {
        const rec = recorder;
        const done = async () => {
          stream?.getTracks().forEach((t) => t.stop());
          stream = null;
          recorder = null;
          if (cancel || !rec) return resolve(null);
          const type = rec.mimeType || mime || 'audio/webm';
          const blob = new Blob(chunks, { type });
          if (!blob.size) return resolve(null);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
          resolve({ name: `voice-${Date.now()}.${ext}`, mime: type.split(';')[0] || 'audio/webm', bytes });
        };
        if (!rec || rec.state === 'inactive') return void done();
        rec.onstop = () => void done();
        try {
          rec.stop();
        } catch {
          void done();
        }
      });
    },
  };
}

function nativeEngine(): Engine {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Audio } = require('expo-av') as typeof import('expo-av');
  let recording: InstanceType<typeof Audio.Recording> | null = null;
  return {
    async start() {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) throw new Error('no_permission');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const created = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recording = created.recording;
    },
    async stop(cancel) {
      const rec = recording;
      recording = null;
      if (!rec) return null;
      try {
        await rec.stopAndUnloadAsync();
      } catch {
        /* уже остановлена */
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true }).catch(() => undefined);
      const uri = rec.getURI();
      if (cancel || !uri) return null;
      const FileSystem = await import('expo-file-system');
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const { fromB64 } = await import('../../crypto/core');
      const bytes = fromB64(b64);
      if (!bytes.length) return null;
      return { name: `voice-${Date.now()}.m4a`, mime: 'audio/mp4', bytes };
    },
  };
}

function supported(): boolean {
  if (Platform.OS !== 'web') return true;
  return typeof navigator !== 'undefined' && typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

/* ------------------------------------------------------------------ кнопка */
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
  const [phase, setPhase] = React.useState<'idle' | 'holding' | 'locked'>('idle');
  const [seconds, setSeconds] = React.useState(0);
  const [cancelHint, setCancelHint] = React.useState(false);
  const engineRef = React.useRef<Engine | null>(null);
  const startingRef = React.useRef<Promise<void> | null>(null);
  const phaseRef = React.useRef(phase);
  phaseRef.current = phase;
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const lift = React.useRef(new Animated.Value(0)).current;

  const haptic = React.useCallback((kind: 'light' | 'medium') => {
    if (Platform.OS === 'web') return;
    void import('expo-haptics')
      .then((H) => H.impactAsync(kind === 'light' ? H.ImpactFeedbackStyle.Light : H.ImpactFeedbackStyle.Medium))
      .catch(() => undefined);
  }, []);

  const stopTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const begin = React.useCallback(() => {
    if (disabled || phaseRef.current !== 'idle') return;
    const engine = Platform.OS === 'web' ? webEngine() : nativeEngine();
    engineRef.current = engine;
    setPhase('holding');
    setSeconds(0);
    setCancelHint(false);
    haptic('medium');
    startingRef.current = engine.start().then(
      () => {
        timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      },
      () => {
        engineRef.current = null;
        setPhase('idle');
        onError?.(Platform.OS === 'web' ? 'Нет доступа к микрофону — разрешите запись звука в браузере' : 'Нет доступа к микрофону — разрешите его в настройках');
      },
    );
  }, [disabled, haptic, onError]);

  const end = React.useCallback(
    async (cancel: boolean) => {
      const engine = engineRef.current;
      engineRef.current = null;
      stopTimer();
      setPhase('idle');
      setCancelHint(false);
      lift.setValue(0);
      if (!engine) return;
      await startingRef.current?.catch(() => undefined);
      try {
        const file = await engine.stop(cancel);
        if (file) onSend(file);
        else if (!cancel) onError?.('Запись пустая — попробуйте ещё раз');
      } catch {
        if (!cancel) onError?.('Не удалось подготовить голосовое сообщение');
      }
    },
    [lift, onError, onSend],
  );

  React.useEffect(
    () => () => {
      stopTimer();
      void engineRef.current?.stop(true).catch(() => undefined);
    },
    [],
  );

  const responder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onMoveShouldSetPanResponder: () => !disabled,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          // Повторное нажатие на зафиксированную запись — отправка.
          if (phaseRef.current === 'locked') {
            void end(false);
            return;
          }
          begin();
        },
        onPanResponderMove: (_e, g) => {
          if (phaseRef.current !== 'holding') return;
          lift.setValue(Math.max(LOCK_DY, Math.min(0, g.dy)));
          setCancelHint(g.dx < CANCEL_DX / 2);
          if (g.dy <= LOCK_DY) {
            haptic('light');
            setPhase('locked');
            lift.setValue(0);
          }
        },
        onPanResponderRelease: (_e, g) => {
          if (phaseRef.current !== 'holding') return;
          void end(g.dx < CANCEL_DX);
        },
        onPanResponderTerminate: () => {
          if (phaseRef.current === 'holding') void end(false);
        },
      }),
    [begin, disabled, end, haptic, lift],
  );

  if (!supported()) return null;
  const recording = phase !== 'idle';

  return (
    <View style={styles.wrap}>
      {recording ? (
        <MotiView
          from={{ opacity: 0, translateY: 6 }}
          animate={{ opacity: 1, translateY: 0 }}
          transition={{ type: 'timing', duration: 160 }}
          style={styles.timerPill}
          pointerEvents="box-none"
        >
          <Glass radius={18} fill={GLASS_FILL_BUTTON} style={styles.timerInner}>
            <MotiView
              from={{ opacity: 1 }}
              animate={{ opacity: reduced ? 1 : 0.25 }}
              transition={{ type: 'timing', duration: 600, loop: !reduced }}
              style={[styles.dot, { backgroundColor: theme.danger }]}
            />
            <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{fmtSec(seconds)}</Text>
            {phase === 'locked' ? (
              <Text
                onPress={() => void end(true)}
                style={{ color: theme.danger, fontSize: 13, fontWeight: '700', marginLeft: 6 }}
                accessibilityRole="button"
              >
                Отмена
              </Text>
            ) : (
              <Text style={{ color: cancelHint ? theme.danger : theme.textSecondary, fontSize: 12.5, marginLeft: 6 }}>
                {cancelHint ? 'Отпустите для отмены' : '‹ влево — отмена'}
              </Text>
            )}
          </Glass>
        </MotiView>
      ) : null}

      {phase === 'holding' ? (
        <Animated.View style={[styles.lockHint, { transform: [{ translateY: lift }] }]} pointerEvents="none">
          <Glass radius={18} fill={GLASS_FILL_BUTTON} style={styles.lockInner}>
            <Ionicons name="lock-open-outline" size={15} color={theme.textPrimary} />
            <MotiView
              from={{ translateY: 3, opacity: 0.5 }}
              animate={{ translateY: -3, opacity: 1 }}
              transition={{ type: 'timing', duration: 520, loop: !reduced }}
            >
              <Ionicons name="chevron-up" size={16} color={theme.textPrimary} />
            </MotiView>
          </Glass>
        </Animated.View>
      ) : null}

      <View
        {...responder.panHandlers}
        accessibilityRole="button"
        accessibilityLabel={phase === 'locked' ? 'Отправить голосовое сообщение' : 'Удерживайте для записи голосового сообщения'}
        style={{ opacity: disabled ? 0.45 : 1 }}
      >
        <MotiView animate={{ scale: phase === 'holding' ? 1.25 : 1 }} transition={{ type: 'spring', damping: 14, stiffness: 260 }}>
          <Glass
            radius={26}
            fill={recording ? theme.accent : GLASS_FILL_BUTTON}
            borderColor={recording ? theme.accent : undefined}
            style={styles.btn}
          >
            <Ionicons
              name={phase === 'locked' ? 'arrow-up' : 'mic'}
              size={phase === 'locked' ? 24 : 25}
              color={recording ? theme.onAccent : theme.textPrimary}
            />
          </Glass>
        </MotiView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', alignItems: 'center', justifyContent: 'flex-end' },
  btn: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  timerPill: { position: 'absolute', bottom: 4, right: 62, zIndex: 20 },
  timerInner: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingVertical: 8 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  lockHint: { position: 'absolute', bottom: 66, alignSelf: 'center', zIndex: 21 },
  lockInner: { alignItems: 'center', paddingHorizontal: 8, paddingVertical: 8, gap: 1 },
});
