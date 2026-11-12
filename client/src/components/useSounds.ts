/**
 * Мягкие WebAudio-звуки интерфейса (только web).
 *  - send: короткий мягкий тон 640 Гц (~40 мс) при отправке;
 *  - receive: двухнотный «дин» 760 → 980 Гц (~120 мс) при входящем.
 * Настройка хранится в localStorage `sg:sounds` ('0' — выключено).
 *
 * Важно для iOS/Safari: AudioContext нельзя запустить без жеста пользователя.
 * Поэтому контекст создаётся в обработчике первого pointerdown/touchstart/keydown
 * (capture) и каждый раз перед тоном дополнительно вызывается resume(). Слушатели
 * не снимаем: iOS умеет «засыпать» контекст в фоне, и следующий тап снова его будит.
 * Любая ошибка подавляется — звук не должен ломать интерфейс.
 */
import React from 'react';
import { DeviceEventEmitter, Platform } from 'react-native';
import { kv } from '../crypto/storage';

const STORAGE_KEY = 'sg:sounds';
const CHANGE_EVENT = 'sg-sounds-changed';

/** Громкость: слышимо на ноутбуках и телефонах, но не перекрывает речь. */
const MASTER_GAIN = 0.11;

type AudioCtor = typeof AudioContext;

function audioCtor(): AudioCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Один общий AudioContext на всё приложение (ленивый синглтон). */
let sharedCtx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx;
  const Ctor = audioCtor();
  if (!Ctor) return null;
  try {
    sharedCtx = new Ctor();
  } catch {
    sharedCtx = null;
  }
  return sharedCtx;
}

/** Возобновляем контекст и проигрываем беззвучный буфер — этого достаточно для iOS. */
function unlockContext(ctx: AudioContext): void {
  try {
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    /* звук не критичен */
  }
}

let unlockInstalled = false;

/**
 * Слушатели жеста не снимаем совсем: на iOS контекст может снова стать suspended
 * после сворачивания вкладки, и первый же тап должен его разбудить.
 */
function installUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  // В React Native window есть, но без DOM-методов — не трогаем его.
  if (typeof window.addEventListener !== 'function') return;
  unlockInstalled = true;

  const events: (keyof WindowEventMap)[] = ['pointerdown', 'touchstart', 'keydown', 'click'];
  const options: AddEventListenerOptions = { capture: true, passive: true };

  const handler = () => {
    const ctx = getContext();
    if (!ctx) return;
    // Быстрый выход в обычном состоянии — обработчик дешёвый даже при каждом тапе.
    if (ctx.state === 'running') return;
    unlockContext(ctx);
  };

  for (const name of events) window.addEventListener(name, handler, options);
}

type Tone = { freq: number; at: number; duration: number; type?: OscillatorType };

/**
 * Планирует последовательность коротких тонов. Перед стартом обязательно
 * повторно resume(): на Safari это критично после возврата из фона.
 */
function playTones(tones: Tone[]): void {
  try {
    const ctx = getContext();
    if (!ctx) return;

    const schedule = () => {
      try {
        if (ctx.state !== 'running') {
          // Не запускаем звук в suspended-контексте: он просто потеряется.
          return;
        }
        const now = ctx.currentTime + 0.01;
        for (const tone of tones) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const start = now + tone.at / 1000;
          const dur = Math.max(0.02, tone.duration / 1000);
          osc.type = tone.type ?? 'sine';
          osc.frequency.setValueAtTime(tone.freq, start);
          // Плавная атака/затухание — без щелчков и резкости.
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.linearRampToValueAtTime(MASTER_GAIN, start + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + dur + 0.02);
        }
      } catch {
        /* звук не критичен */
      }
    };

    if (ctx.state === 'suspended') {
      void ctx.resume().then(schedule).catch(() => undefined);
      return;
    }
    schedule();
  } catch {
    /* звук не критичен */
  }
}

function readEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------ native звуки -- */

type NativeSoundName = 'send' | 'receive' | 'error';

let audioModule: typeof import('expo-av').Audio | null = null;
const nativeSounds = new Map<NativeSoundName, import('expo-av').Audio.Sound>();
let audioModeReady = false;
let nativeEnabled = true;

const NATIVE_SOURCES: Record<NativeSoundName, number> = {
  send: require('../../assets/sounds/send.wav'),
  receive: require('../../assets/sounds/receive.wav'),
  error: require('../../assets/sounds/error.wav'),
};

async function playNative(name: NativeSoundName): Promise<void> {
  if (!nativeEnabled) return;
  try {
    if (!audioModule) {
      const mod = await import('expo-av');
      audioModule = mod.Audio;
    }
    if (!audioModule) return;
    if (!audioModeReady) {
      audioModeReady = true;
      await audioModule
        .setAudioModeAsync({
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          staysActiveInBackground: false,
        })
        .catch(() => undefined);
    }
    let sound = nativeSounds.get(name);
    if (!sound) {
      const created = await audioModule.Sound.createAsync(NATIVE_SOURCES[name], { volume: 0.7 });
      sound = created.sound;
      nativeSounds.set(name, sound);
    }
    await sound.replayAsync();
  } catch {
    /* звук не должен ломать интерфейс */
  }
}

export function useSounds(): { send: () => void; receive: () => void; error: () => void; enabled: boolean } {
  const isWeb = Platform.OS === 'web';

  const [enabled, setEnabled] = React.useState<boolean>(() => (isWeb ? readEnabled() : nativeEnabled));

  // Гидратация после SSR, смена настройки в этой вкладке (custom event) и в других (storage).
  React.useEffect(() => {
    if (isWeb) {
      if (typeof window === 'undefined') return undefined;
      setEnabled(readEnabled());

      const onChange = () => setEnabled(readEnabled());
      const onStorage = (e: StorageEvent) => {
        if (e.key !== STORAGE_KEY) return;
        setEnabled(e.newValue !== '0');
      };
      window.addEventListener(CHANGE_EVENT, onChange);
      window.addEventListener('storage', onStorage);
      return () => {
        window.removeEventListener(CHANGE_EVENT, onChange);
        window.removeEventListener('storage', onStorage);
      };
    }

    // Нативный звук: настройка хранится в kv (AsyncStorage).
    let alive = true;
    void kv
      .get(STORAGE_KEY)
      .then((raw) => {
        if (!alive) return;
        nativeEnabled = raw !== '0';
        setEnabled(nativeEnabled);
      })
      .catch(() => undefined);
    const sub = DeviceEventEmitter.addListener(CHANGE_EVENT, () => {
      void kv
        .get(STORAGE_KEY)
        .then((raw) => {
          nativeEnabled = raw !== '0';
          setEnabled(nativeEnabled);
        })
        .catch(() => undefined);
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [isWeb]);

  // Разблокировка аудио по первому жесту пользователя (iOS/Safari).
  React.useEffect(() => {
    if (isWeb) installUnlock();
  }, [isWeb]);

  // Отправка: мягкий короткий тон 640 Гц, 40 мс.
  const send = React.useCallback(() => {
    if (isWeb) {
      if (!readEnabled()) return;
      playTones([{ freq: 640, at: 0, duration: 40, type: 'sine' }]);
      return;
    }
    void playNative('send');
  }, [isWeb]);

  // Входящее: два тона 760 → 980 Гц, суммарно ~120 мс.
  const receive = React.useCallback(() => {
    if (isWeb) {
      if (!readEnabled()) return;
      playTones([
        { freq: 760, at: 0, duration: 60, type: 'sine' },
        { freq: 980, at: 60, duration: 60, type: 'sine' },
      ]);
      return;
    }
    void playNative('receive');
  }, [isWeb]);

  // Ошибка: короткий низкий сигнал.
  const error = React.useCallback(() => {
    if (isWeb) {
      if (!readEnabled()) return;
      playTones([
        { freq: 300, at: 0, duration: 90, type: 'triangle' },
        { freq: 190, at: 85, duration: 120, type: 'triangle' },
      ]);
      return;
    }
    void playNative('error');
  }, [isWeb]);

  return { send, receive, error, enabled };
}
