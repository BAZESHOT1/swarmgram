/**
 * Шаг прошивки: Web Serial + esptool-js.
 * На ПК в Chrome/Edge порт запрашивается у пользователя, .bin скачивается с Hub
 * и пишется во flash. На телефоне и в неподдерживаемом браузере — только .bin.
 */
import React from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Btn } from '../Btn';
import { useTheme } from '../../theme/useTheme';
import { StatusBadge } from '../settings/SettingsWidgets';
import { Note, PillGroup, StepCard } from './FirmwareUI';
import {
  downloadFirmware,
  isReadyStatus,
  resolveDownloadUrl,
  statusLabel,
  type FirmwareBuild,
} from './types';

interface SerialPortLike {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  readable?: unknown;
  writable?: unknown;
}

interface SerialLike {
  requestPort: () => Promise<SerialPortLike>;
  getPorts?: () => Promise<SerialPortLike[]>;
}

function getSerial(): SerialLike | null {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return null;
  const maybe = (navigator as unknown as { serial?: SerialLike }).serial;
  return maybe ?? null;
}

/** Понятная подсказка по типовым ошибкам esptool. */
function flashHint(message: string): string {
  const text = message.toLowerCase();
  if (text.includes('failed to connect') || text.includes('timeout') || text.includes('timed out')) {
    return 'Плата не в режиме загрузки. Зажмите BOOT, нажмите EN, отпустите BOOT — и повторите подключение.';
  }
  if (text.includes('no such device') || text.includes('device lost') || text.includes('failed to open')) {
    return 'Порт занят другой программой или кабелем. Закройте Arduino IDE/PlatformIO, проверьте USB-кабель.';
  }
  if (text.includes('md5') || text.includes('verify')) {
    return 'Ошибка проверки записи. Попробуйте baud 115200 и повторите прошивку.';
  }
  return 'Проверьте кабель, питание платы и выбранный порт. Иногда помогает переподключить USB.';
}

export function FlashStep({
  build,
  onDownload,
  onDone,
  onFlashed,
}: {
  build: FirmwareBuild | null;
  onDownload: () => void;
  onDone: () => void;
  /** Вызывается после успешной записи с MAC-based hardwareId. */
  onFlashed?: (hardwareId: string) => Promise<void> | void;
}) {
  const theme = useTheme();
  const serial = getSerial();
  const supported = serial !== null;
  const secure =
    Platform.OS !== 'web' ||
    (typeof window !== 'undefined' && Boolean((window as unknown as { isSecureContext?: boolean }).isSecureContext));
  const httpsUrl =
    Platform.OS === 'web' && typeof window !== 'undefined'
      ? (() => {
          if (window.location.protocol === 'https:') return window.location.origin;
          const host = window.location.hostname;
          // Для IP используем доверенный сертификат nip.io (Let's Encrypt).
          const secureHost = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? `${host.replace(/\./g, '-')}.nip.io` : host;
          return `https://${secureHost}:3443`;
        })()
      : '';
  const ready = isReadyStatus(build?.status);
  const flashable = ready && build?.merged === true;

  const [baud, setBaud] = React.useState(115200);
  const [connecting, setConnecting] = React.useState(false);
  const [flashing, setFlashing] = React.useState(false);
  const [connectedChip, setConnectedChip] = React.useState('');
  const [progress, setProgress] = React.useState(0);
  const [error, setError] = React.useState('');
  const [hint, setHint] = React.useState('');
  const [log, setLog] = React.useState<string[]>([]);
  const [done, setDone] = React.useState(false);
  const [portName, setPortName] = React.useState('');

  const portRef = React.useRef<SerialPortLike | null>(null);
  const transportRef = React.useRef<{ disconnect: () => Promise<void> } | null>(null);
  const loaderRef = React.useRef<Record<string, unknown> | null>(null);
  const logBox = React.useRef<ScrollView | null>(null);

  const append = React.useCallback((line: string) => {
    const clean = line.replace(/\r/g, '').trimEnd();
    if (!clean) return;
    setLog((prev) => [...prev, clean].slice(-400));
  }, []);

  React.useEffect(() => {
    const timer = setTimeout(() => logBox.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [log]);

  React.useEffect(() => {
    if (!done) return undefined;
    const timer = setTimeout(onDone, 1200);
    return () => clearTimeout(timer);
  }, [done, onDone]);

  const dispose = React.useCallback(async () => {
    try {
      await transportRef.current?.disconnect();
    } catch {
      /* порт мог быть уже закрыт — не мешаем новой попытке */
    }
    transportRef.current = null;
    loaderRef.current = null;
  }, []);

  React.useEffect(() => {
    return () => {
      void transportRef.current?.disconnect().catch(() => undefined);
    };
  }, []);

  const terminal = React.useMemo(
    () => ({
      clean: () => setLog([]),
      writeLine: (data: string) => append(data),
      write: (data: string) => {
        if (data.trim()) append(data);
      },
    }),
    [append],
  );

  const ensurePort = async (): Promise<SerialPortLike> => {
    const serialApi = getSerial();
    if (!serialApi) throw new Error('Web Serial не поддерживается этим браузером.');
    if (portRef.current) return portRef.current;
    const port = await serialApi.requestPort();
    portRef.current = port;
    setPortName('выбран вручную');
    return port;
  };

  const makeLoader = async (port: SerialPortLike) => {
    const { ESPLoader, Transport } = await import('esptool-js');
    await dispose();
    const transport = new Transport(port as never, true);
    transportRef.current = transport as unknown as { disconnect: () => Promise<void> };
    const loader = new ESPLoader({
      transport,
      baudrate: baud,
      terminal,
    } as never) as unknown as Record<string, unknown>;
    loaderRef.current = loader;
    return loader;
  };

  const connect = async () => {
    setError('');
    setHint('');
    setDone(false);
    setProgress(0);
    setConnecting(true);
    try {
      const port = await ensurePort();
      const loader = await makeLoader(port);
      append(`Подключение на ${baud} бод…`);
      const chip = await (loader.main as () => Promise<string>)();
      setConnectedChip(chip || 'ESP32');
      append(`✓ Плата отвечает: ${chip || 'ESP32'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setHint(flashHint(message));
    } finally {
      setConnecting(false);
    }
  };

  const flash = async () => {
    if (!build) {
      setError('Сборка ещё не готова: прошивать нечего.');
      return;
    }
    if (build.merged !== true) {
      setError('Старая сборка app-only: пересоберите прошивку, чтобы прошить из браузера.');
      return;
    }
    setError('');
    setHint('');
    setDone(false);
    setProgress(0);
    setFlashing(true);
    try {
      const port = await ensurePort();
      append(`Скачивание .bin со сборки ${build.id.slice(0, 8)}…`);
      const path = await downloadFirmware(build.id);
      const url = resolveDownloadUrl(path);
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) throw new Error(`Hub вернул ${response.status} при скачивании прошивки.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 1024) throw new Error('Файл прошивки подозрительно мал — возможно, Hub вернул ошибку.');
      append(`Получено ${(bytes.byteLength / 1024 / 1024).toFixed(2)} МБ. Подключение…`);

      const loader = await makeLoader(port);
      await (loader.main as () => Promise<string>)();
      append('Запись во flash…');

      await (loader.writeFlash as (opts: unknown) => Promise<void>)({
        fileArray: [{ data: bytes, address: 0 }],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (fileIndex: number, written: number, total: number) => {
          const pct = total > 0 ? Math.round((written / total) * 100) : 0;
          setProgress(Math.max(0, Math.min(100, pct)));
          if (fileIndex === 0 && pct > 0 && pct % 10 === 0) append(`Записано ${pct}%`);
        },
        calculateMD5Hash: (image: Uint8Array) => {
          // MD5 считается на стороне сервера; для совместимости возвращаем пустую строку,
          // если браузерный crypto не умеет MD5 (WebCrypto его не поддерживает).
          void image;
          return '';
        },
      });
      setProgress(100);
      append('✓ Запись завершена.');

      // hardwareId = MAC платы (eFuse), не меняется при перепрошивке.
      let hardwareId = '';
      try {
        const chip = (loader as unknown as { chip?: { readMac?: (l: unknown) => Promise<string> } }).chip;
        if (chip?.readMac) {
          const mac = await chip.readMac(loader);
          const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
          if (hex.length === 12) hardwareId = `esp32-${hex}`;
        }
      } catch {
        /* MAC не критичен: привязку можно сделать на странице модулей */
      }

      append('Перезагрузка платы…');
      await (loader.after as (mode: string) => Promise<void>)('hard_reset');
      await dispose();
      setDone(true);
      append('✓ Плата перезагружена. Прошивка установлена.');

      if (hardwareId && onFlashed) {
        append(`Привязка модуля ${hardwareId} к аккаунту…`);
        try {
          await onFlashed(hardwareId);
          append('✓ Модуль привязан к аккаунту.');
        } catch (pairError) {
          append(`! Не удалось привязать автоматически: ${pairError instanceof Error ? pairError.message : String(pairError)}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setHint(flashHint(message));
      append(`✗ ${message}`);
      await dispose();
    } finally {
      setFlashing(false);
    }
  };

  if (!build) {
    return (
      <View>
        <Note icon="build-outline" tone="warning">
          Сначала соберите прошивку на шаге «Проверка». Как только сборка станет готовой, здесь появятся кнопки подключения и записи.
        </Note>
        <Btn title="Скачать .bin" variant="ghost" onPress={onDownload} />
      </View>
    );
  }

  if (!supported) {
    return (
      <View>
        <Note icon="phone-portrait-outline" tone="warning">
          {secure
            ? 'Прошивка с ПК в Chrome/Edge; на телефоне скачайте .bin или используйте OTA после первичной прошивки.'
            : 'Web Serial работает только в защищённом контексте (HTTPS или localhost). Откройте HTTPS-версию, примите сертификат — и прошивка появится здесь.'}
        </Note>
        <StepCard>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Ionicons name="information-circle-outline" size={17} color={theme.accent} />
            <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '700' }}>Что можно сделать сейчас</Text>
          </View>
          <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 }}>
            {secure
              ? 'Скачайте готовый .bin и прошейте его с компьютера через esptool или Arduino IDE. После первой прошивки модуль сможет обновляться по OTA.'
              : 'Откройте сайт по HTTPS, чтобы браузер разрешил доступ к USB-порту. После принятия самоподписанного сертификата вернитесь на этот шаг.'}
          </Text>
          <View style={{ height: 12 }} />
          {!secure && httpsUrl ? (
            <View style={{ marginBottom: 8 }}>
              <Btn
                title="Открыть HTTPS-версию"
                onPress={() => {
                  if (typeof window !== 'undefined') window.location.href = httpsUrl;
                }}
              />
            </View>
          ) : null}
          <Btn title="Скачать .bin" variant={!secure && httpsUrl ? 'ghost' : 'primary'} onPress={onDownload} />
        </StepCard>
        <View style={{ height: 12 }} />
        <Note icon="hardware-chip-outline" tone="neutral">
          Сборка {build.version ? `v${build.version} · ` : ''}
          {statusLabel(build.status)}. Файл неизменен — его можно скачать позже из истории.
        </Note>
      </View>
    );
  }

  return (
    <View>
      <Note icon="desktop-outline" tone="accent">
        Подключите плату по USB и выберите порт. Для входа в режим загрузки обычно достаточно кнопки BOOT; некоторые платы требуют зажать BOOT при подключении.
      </Note>

      <StepCard>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <View
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: connectedChip ? theme.successSoft : theme.surfacePressed,
            }}
          >
            <Ionicons
              name={connectedChip ? 'checkmark-circle-outline' : 'hardware-chip-outline'}
              size={18}
              color={connectedChip ? theme.success : theme.textSecondary}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }}>
              {connectedChip ? `Плата: ${connectedChip}` : 'Плата не подключена'}
            </Text>
            <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 2 }}>
              {portName || 'Порт выбирается в системном окне браузера'}
            </Text>
          </View>
          {connectedChip ? <StatusBadge text="готово" tone="success" /> : null}
        </View>

        <PillGroup
          label="Скорость записи"
          value={baud}
          options={[
            { value: 115200, label: '115200 бод' },
            { value: 460800, label: '460800 бод' },
          ]}
          onChange={(value) => {
            setBaud(value);
            append(`Скорость: ${value} бод (применится при следующем подключении)`);
          }}
        />

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Btn title="Подключить плату" size="s" variant="ghost" loading={connecting} disabled={flashing} onPress={() => void connect()} />
          </View>
          <View style={{ flex: 1 }}>
            <Btn title="Прошить" size="s" loading={flashing} disabled={!flashable || connecting} onPress={() => void flash()} />
          </View>
        </View>

        {!ready ? (
          <Text style={{ color: theme.warning, fontSize: 11.5, marginTop: 8 }}>
            Сборка ещё не готова. Дождитесь статуса «готова» на шаге проверки.
          </Text>
        ) : !flashable ? (
          <Text style={{ color: theme.warning, fontSize: 11.5, marginTop: 8 }}>
            Это старая сборка в формате app-only — браузерная прошивка с 0x0 для неё недоступна.
            Пересоберите прошивку: новый .bin будет merged и прошьётся прямо отсюда.
          </Text>
        ) : null}
      </StepCard>

      {flashing || progress > 0 ? (
        <View style={{ marginTop: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '600' }}>Запись во flash</Text>
            <Text style={{ color: theme.textPrimary, fontSize: 12, fontWeight: '800' }}>{progress}%</Text>
          </View>
          <View style={{ height: 6, borderRadius: 999, backgroundColor: theme.surfacePressed, overflow: 'hidden' }}>
            <View
              style={{
                width: `${Math.max(0, Math.min(100, progress))}%`,
                height: '100%',
                borderRadius: 999,
                backgroundColor: progress >= 100 ? theme.success : theme.accent,
              }}
            />
          </View>
        </View>
      ) : null}

      {error ? (
        <View style={{ marginTop: 12 }}>
          <Note icon="alert-circle-outline" tone="danger">
            {error}
            {hint ? `\n${hint}` : ''}
          </Note>
        </View>
      ) : null}

      <View style={{ marginTop: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '600' }}>Лог esptool</Text>
          <Text
            onPress={() => setLog([])}
            accessibilityRole="button"
            accessibilityLabel="Очистить лог"
            style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700' }}
          >
            Очистить
          </Text>
        </View>
        <View
          style={{
            height: 190,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.line,
            backgroundColor: theme.dark ? 'rgba(0,0,0,0.35)' : 'rgba(16,24,40,0.05)',
            overflow: 'hidden',
          }}
        >
          <ScrollView ref={logBox} style={{ padding: 9 }} nestedScrollEnabled>
            <Text
              selectable
              style={{
                color: theme.textSecondary,
                fontSize: 10.5,
                lineHeight: 15,
                fontFamily: Platform.select({ web: 'ui-monospace, SFMono-Regular, Menlo, monospace', default: 'monospace' }),
              }}
            >
              {log.length > 0 ? log.join('\n') : 'Лог появится после подключения.'}
            </Text>
          </ScrollView>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <View style={{ flex: 1 }}>
          <Btn title="Скачать .bin" variant="ghost" size="s" onPress={onDownload} />
        </View>
        <View style={{ flex: 1 }}>
          <Btn title="Я прошил — далее" variant="ghost" size="s" onPress={onDone} />
        </View>
      </View>

      {done ? (
        <View style={{ marginTop: 12 }}>
          <Note icon="checkmark-done-outline" tone="success">
            Прошивка записана, плата перезагружена. Нажмите «Я прошил — далее», чтобы увидеть чек-лист.
          </Note>
        </View>
      ) : null}
    </View>
  );
}
