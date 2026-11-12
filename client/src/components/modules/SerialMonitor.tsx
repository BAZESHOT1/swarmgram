/**
 * Serial-монитор по USB для отладки прошивки модулей.
 *
 * Работает только в браузере с Web Serial (Chrome/Edge, HTTPS или localhost).
 * Открывает выбранный пользователем порт на 115200 бод, читает поток как текст,
 * показывает строки с автоскроллом и закрывает порт при размонтировании.
 *
 * Порт — эксклюзивный ресурс: компонент не даёт открыть его, пока идёт
 * прошивка/подключение модуля (`blocked`), и сам закрывает порт, если блокировка
 * появилась во время чтения.
 */
import React from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { GlassCard } from '../settings/SettingsUI';
import { StatusBadge } from '../settings/SettingsWidgets';
import { isWebSecureContext, secureWebUrl } from '../../utils/secureContext';

const BAUD_RATE = 115200;
const MAX_LINES = 500;

interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPortLike {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  addEventListener?(type: 'disconnect', listener: () => void): void;
  removeEventListener?(type: 'disconnect', listener: () => void): void;
  getInfo?(): SerialPortInfo;
}

interface SerialLike {
  requestPort(options?: { filters?: Array<Record<string, unknown>> }): Promise<SerialPortLike>;
  getPorts?(): Promise<SerialPortLike[]>;
}

/** Web Serial API доступен только в secure context и только в браузере. */
function serialApi(): SerialLike | null {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return null;
  const api = (navigator as unknown as { serial?: SerialLike }).serial;
  return api && typeof api.requestPort === 'function' ? api : null;
}

/** Понятный текст вместо сырого DOMException из браузера. */
function serialErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const text = raw.toLowerCase();
  if (text.includes('no port selected')) {
    return 'Порт не выбран. Нажмите «Открыть Serial-монитор» и выберите устройство в окне браузера.';
  }
  if (
    text.includes('failed to open') ||
    text.includes('access denied') ||
    text.includes('already open') ||
    text.includes('busy') ||
    text.includes('networkerror') ||
    text.includes('invalid state')
  ) {
    return (
      'Не удалось открыть порт: он занят прошивкой или другой программой. ' +
      'Закройте Arduino IDE/PlatformIO, дождитесь окончания прошивки и повторите.'
    );
  }
  if (text.includes('no such device') || text.includes('device lost') || text.includes('disconnected')) {
    return 'Устройство отключено от USB. Проверьте кабель и попробуйте снова.';
  }
  return raw ? `Ошибка Serial: ${raw}` : 'Не удалось открыть Serial-порт.';
}

function portLabel(port: SerialPortLike): string {
  try {
    const info = port.getInfo?.();
    if (info?.usbVendorId || info?.usbProductId) {
      const vendor = (info.usbVendorId ?? 0).toString(16).padStart(4, '0');
      const product = (info.usbProductId ?? 0).toString(16).padStart(4, '0');
      return `USB ${vendor}:${product}`;
    }
  } catch {
    /* getInfo не везде доступен */
  }
  return 'USB-порт';
}

export function SerialMonitor({ blocked = false, blockedReason }: { blocked?: boolean; blockedReason?: string }) {
  const theme = useTheme();
  const [supported, setSupported] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [lines, setLines] = React.useState<string[]>([]);
  const [error, setError] = React.useState('');
  const [label, setLabel] = React.useState('');

  const scrollRef = React.useRef<ScrollView | null>(null);
  const portRef = React.useRef<SerialPortLike | null>(null);
  const readerRef = React.useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const bufferRef = React.useRef('');
  const disposedRef = React.useRef(false);
  const closingRef = React.useRef(false);
  const openRef = React.useRef(false);
  const blockedRef = React.useRef(blocked);

  openRef.current = open;
  blockedRef.current = blocked;

  React.useEffect(() => {
    setSupported(serialApi() !== null);
  }, []);

  /** Добавляет декодированный текст, разрезая поток на строки. */
  const appendText = React.useCallback((text: string) => {
    if (!text) return;
    const normalized = bufferRef.current + text;
    const parts = normalized.split('\n');
    bufferRef.current = parts.pop() ?? '';
    const complete = parts.map((line) => line.replace(/\r$/, ''));
    // Последняя неполная строка тоже полезна при отладке.
    if (bufferRef.current.length > 4096) {
      complete.push(bufferRef.current);
      bufferRef.current = '';
    }
    if (!complete.length) return;
    setLines((prev) => [...prev, ...complete].slice(-MAX_LINES));
  }, []);

  const handleDisconnect = React.useCallback(() => {
    portRef.current = null;
    readerRef.current = null;
    openRef.current = false;
    setOpen(false);
    setError('Модуль отключён от USB. Подключите его снова и откройте порт.');
  }, []);

  const readLoop = React.useCallback(
    async (port: SerialPortLike) => {
      const readable = port.readable;
      if (!readable) {
        setError('Порт открыт, но чтение недоступно.');
        return;
      }
      const reader = readable.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) appendText(decoder.decode(value, { stream: true }));
        }
      } catch (unexpected) {
        if (!closingRef.current && !disposedRef.current) {
          setError(serialErrorText(unexpected));
        }
      } finally {
        try {
          reader.releaseLock?.();
        } catch {
          /* lock уже снят */
        }
        if (readerRef.current === reader) readerRef.current = null;
        if (!closingRef.current && !disposedRef.current && portRef.current === port) {
          portRef.current = null;
          openRef.current = false;
          setOpen(false);
        }
      }
    },
    [appendText],
  );

  /** Закрывает порт и снимает reader; безопасно вызывать повторно. */
  const closePort = React.useCallback(async (message?: string) => {
    closingRef.current = true;
    const reader = readerRef.current;
    readerRef.current = null;
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* поток уже закрыт */
      }
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }
    const port = portRef.current;
    portRef.current = null;
    openRef.current = false;
    if (port) {
      try {
        port.removeEventListener?.('disconnect', handleDisconnect);
      } catch {
        /* ignore */
      }
      try {
        await port.close();
      } catch {
        /* порт мог быть уже закрыт системой */
      }
    }
    bufferRef.current = '';
    if (!disposedRef.current) {
      setOpen(false);
      setLabel('');
      setError(message ?? '');
    }
    closingRef.current = false;
  }, [handleDisconnect]);

  const openPort = React.useCallback(async () => {
    if (blockedRef.current) {
      setError(blockedReason || 'Сейчас порт занят: идёт подключение или прошивка модуля.');
      return;
    }
    const api = serialApi();
    if (!api) {
      setError('Web Serial недоступен: откройте сайт в Chrome/Edge на компьютере по HTTPS или localhost.');
      return;
    }
    if (openRef.current || connecting) return;

    setError('');
    setConnecting(true);
    try {
      const port = await api.requestPort();
      if (disposedRef.current) return;
      await port.open({ baudRate: BAUD_RATE, bufferSize: 4096 });
      if (disposedRef.current) {
        await port.close().catch(() => undefined);
        return;
      }
      closingRef.current = false;
      portRef.current = port;
      port.addEventListener?.('disconnect', handleDisconnect);
      openRef.current = true;
      setOpen(true);
      setLabel(portLabel(port));
      setLines((prev) =>
        [
          ...prev,
          `— Порт открыт, ${BAUD_RATE} бод. Ожидание данных от модуля… —`,
        ].slice(-MAX_LINES),
      );
      void readLoop(port);
    } catch (unexpected) {
      if (!disposedRef.current) setError(serialErrorText(unexpected));
    } finally {
      if (!disposedRef.current) setConnecting(false);
    }
  }, [blockedReason, connecting, handleDisconnect, readLoop]);

  // Порт закрывается при уходе со страницы/размонтировании.
  React.useEffect(
    () => () => {
      disposedRef.current = true;
      const reader = readerRef.current;
      readerRef.current = null;
      if (reader) void reader.cancel().catch(() => undefined);
      const port = portRef.current;
      portRef.current = null;
      if (port) {
        try {
          port.removeEventListener?.('disconnect', handleDisconnect);
        } catch {
          /* ignore */
        }
        void port.close().catch(() => undefined);
      }
    },
    [handleDisconnect],
  );

  // Началась прошивка/подключение — освобождаем порт, чтобы не мешать.
  React.useEffect(() => {
    if (!blocked) return;
    if (openRef.current) void closePort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);

  if (Platform.OS !== 'web') return null;

  const terminalFont = Platform.OS === 'web' ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : 'monospace';

  return (
    <GlassCard>
      <View style={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 11,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.accentSoft,
            }}
          >
            <Ionicons name="terminal-outline" size={18} color={theme.accent} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }} numberOfLines={1}>
              Serial-монитор
            </Text>
            <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 2 }} numberOfLines={1}>
              {open ? `${label || 'USB-порт'} · ${BAUD_RATE} бод` : 'Отладка прошивки по USB'}
            </Text>
          </View>
          <StatusBadge text={open ? 'открыт' : 'закрыт'} tone={open ? 'success' : 'neutral'} />
        </View>

        {!supported ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 17 }}>
              {isWebSecureContext()
                ? 'Web Serial недоступен. Нужен Chrome или Edge на компьютере (не мобильный браузер).'
                : 'Web Serial работает только на HTTPS или localhost. Откройте защищённую версию — после неё монитор заработает.'}
            </Text>
            {!isWebSecureContext() && secureWebUrl() ? (
              <Btn
                title="Открыть HTTPS-версию"
                size="s"
                onPress={() => {
                  if (typeof window !== 'undefined') window.location.href = secureWebUrl();
                }}
              />
            ) : null}
          </View>
        ) : (
          <>
            <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 17 }}>
              Только для ПК. Порт открывается на 115200 бод; пока идёт прошивка или модуль подключён к клиенту,
              монитор недоступен.
            </Text>

            {blocked ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="lock-closed-outline" size={13} color={theme.warning} />
                <Text style={{ color: theme.warning, fontSize: 11.5, flex: 1 }}>
                  {blockedReason || 'Порт занят: идёт подключение или прошивка модуля.'}
                </Text>
              </View>
            ) : null}

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {open ? (
                <Btn
                  title="Закрыть порт"
                  size="s"
                  variant="ghost"
                  onPress={() => void closePort()}
                />
              ) : (
                <Btn
                  title={connecting ? 'Открываем…' : 'Открыть Serial-монитор'}
                  size="s"
                  loading={connecting}
                  disabled={blocked || connecting}
                  onPress={() => void openPort()}
                />
              )}
              <Btn
                title="Очистить"
                size="s"
                variant="ghost"
                disabled={lines.length === 0}
                onPress={() => {
                  bufferRef.current = '';
                  setLines([]);
                }}
              />
            </View>

            {error ? (
              <Text style={{ color: theme.danger, fontSize: 11.5, lineHeight: 17 }}>{error}</Text>
            ) : null}

            <ScrollView
              ref={scrollRef}
              nestedScrollEnabled
              onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
              style={{
                minHeight: 132,
                maxHeight: 260,
                borderRadius: 11,
                borderWidth: 1,
                borderColor: theme.line,
                backgroundColor: theme.background,
              }}
              contentContainerStyle={{ padding: 9 }}
            >
              {lines.length === 0 ? (
                <Text style={{ color: theme.textDisabled, fontSize: 11.5, lineHeight: 17 }}>
                  {open
                    ? 'Ожидание данных… Включите вывод логов в прошивке модуля.'
                    : 'Нажмите «Открыть Serial-монитор» и выберите USB-порт модуля.'}
                </Text>
              ) : (
                lines.map((line, index) => (
                  <Text
                    key={`serial-${index}`}
                    style={{
                      color: theme.textPrimary,
                      fontSize: 11.5,
                      lineHeight: 17,
                      fontFamily: terminalFont,
                    }}
                  >
                    {line}
                  </Text>
                ))
              )}
            </ScrollView>

            <Text style={{ color: theme.textDisabled, fontSize: 10.5 }}>
              Хранится последние {MAX_LINES} строк
            </Text>
          </>
        )}
      </View>
    </GlassCard>
  );
}
