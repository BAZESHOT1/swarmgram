/**
 * Контекст подключения к модулю.
 *
 * Задачи провайдера:
 *  - при запуске и возврате приложения в foreground самим восстановить
 *    последний модуль (web — уже разрешённый USB-порт, native — BLE scan 4 c);
 *  - после handshake мягко привязать модуль к аккаунту (pairModule),
 *    подключить wearable (attachModule) и обновить транспорт в store;
 *  - при разрыве — detachModule и честный статус;
 *  - не спамить: не чаще одной попытки в 30 секунд и никогда на экране логина.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../data/api';
import { kv } from '../crypto/storage';
import { useStore } from '../state/useStore';
import { getModuleTransport, webBluetoothSupported, webSerialSupported } from './transport';
import { emitMeshEnvelope, setMeshCapabilities, setMeshSender } from './meshLink';
import {
  readLastModule,
  writeLastModule,
  ModuleTransportError,
  type ConnectionKind,
  type LastModuleRecord,
  type ModuleConnection,
  type ModuleInfo,
} from './types';

const AUTO_RETRY_MS = 30_000;

export type AutoModulePhase = 'found' | 'connecting' | 'connected' | 'failed';
export interface AutoModuleState {
  key: string;
  name: string;
  isMine: boolean;
  phase: AutoModulePhase;
  error?: string;
}

interface ModuleContextValue {
  connection: ModuleConnection | null;
  info: ModuleInfo | null;
  connected: boolean;
  /** Идёт подключение/восстановление. */
  busy: ConnectionKind | null;
  /** Идёт отправка Wi-Fi роутера шлюзу. */
  configuring: boolean;
  error: string | null;
  supportedUsb: boolean;
  supportedBle: boolean;
  connectUsb: () => Promise<ModuleInfo | null>;
  connectBle: () => Promise<ModuleInfo | null>;
  disconnect: () => Promise<void>;
  /** Отправить SSID/пароль Wi-Fi активному шлюзу (USB/BLE). Пароль не логируется. */
  configureGateway: (ssid: string, password: string) => Promise<boolean>;
  clearError: () => void;
  /** Последняя ошибка подключения синхронно (контекст может быть ещё не обновлён). */
  getLastError: () => string | null;
  /** Глобальное окно найденного/подключаемого модуля. */
  autoModule: AutoModuleState | null;
  acceptAutoModule: () => Promise<void>;
  dismissAutoModule: () => void;
  /** Ручной повтор автовосстановления (например, после включения модуля). */
  restore: () => Promise<void>;
}

const ModuleContext = createContext<ModuleContextValue | null>(null);

export function useModuleConnection(): ModuleContextValue {
  const value = useContext(ModuleContext);
  if (!value) throw new Error('useModuleConnection должен использоваться внутри ModuleProvider');
  return value;
}

/** Достаёт moduleId из ответа API/сохранённой записи. */
function moduleIdOf(row: { id?: string } | null | undefined): string | undefined {
  return row && typeof row.id === 'string' ? row.id : undefined;
}

export function ModuleProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const session = useStore((s) => s.session);
  const setMeshPeer = useStore((s) => s.setMeshPeer);
  const setTransportModule = useStore((s) => s.setTransportModule);
  const setTransportGateway = useStore((s) => s.setTransportGateway);
  const setNearbyModules = useStore((s) => s.setNearbyModules);

  const [connection, setConnection] = useState<ModuleConnection | null>(null);
  const [info, setInfo] = useState<ModuleInfo | null>(null);
  const [busy, setBusy] = useState<ConnectionKind | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastErrorRef = useRef<string | null>(null);
  const [autoModule, setAutoModule] = useState<AutoModuleState | null>(null);
  const autoRef = useRef<AutoModuleState | null>(null);
  autoRef.current = autoModule;
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ignoredModulesRef = useRef<Set<string>>(new Set());
  const cancelAutoKeyRef = useRef<string | null>(null);

  const connectionRef = useRef<ModuleConnection | null>(null);
  const infoRef = useRef<ModuleInfo | null>(null);
  const lastRecordRef = useRef<LastModuleRecord | null>(null);
  const unsubEnvelopeRef = useRef<(() => void) | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubDisconnectRef = useRef<(() => void) | null>(null);
  const lastAttemptRef = useRef(0);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const connectedToastRef = useRef('');
  const foundToastRef = useRef('');

  const clearError = useCallback(() => {
    lastErrorRef.current = null;
    setError(null);
  }, []);

  const detachCurrent = useCallback(async () => {
    unsubEnvelopeRef.current?.();
    unsubDisconnectRef.current?.();
    unsubEnvelopeRef.current = null;
    unsubDisconnectRef.current = null;
    const current = connectionRef.current;
    connectionRef.current = null;
    infoRef.current = null;
    if (mountedRef.current) {
      setConnection(null);
      setInfo(null);
    }
    if (current) await current.close().catch(() => undefined);
  }, []);

  const refreshLists = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['modules'] });
  }, [qc]);

  /** Принять уже открытое подключение: мягкая привязка, attach, store, сохранение. */
  const adopt = useCallback(
    async (transport: ModuleConnection, nextInfo: ModuleInfo) => {
      const kind = transport.kind;
      // Старое соединение закрываем только после успешного нового handshake.
      const previous = connectionRef.current;
      connectionRef.current = transport;
      infoRef.current = nextInfo;
      if (mountedRef.current) {
        setConnection(transport);
        setInfo(nextInfo);
        setError(null);
      }
      if (previous && previous !== transport) await previous.close().catch(() => undefined);

      unsubDisconnectRef.current?.();
      unsubDisconnectRef.current = transport.onDisconnect(() => {
        if (connectionRef.current !== transport) return;
        const last = lastRecordRef.current;
        connectionRef.current = null;
        infoRef.current = null;
        setMeshSender(null);
        setMeshCapabilities({ connected: false, gateway: false, queue: 0, neighbors: 0 });
        if (mountedRef.current) {
          setConnection(null);
          setInfo(null);
          setTransportModule(null);
        setTransportGateway(false);
        if (presenceTimerRef.current) {
          clearInterval(presenceTimerRef.current);
          presenceTimerRef.current = null;
        }
        }
        // Wearable больше не подключён к клиенту — честно сообщаем серверу.
        if (last?.moduleId && last.role === 'wearable') {
          void api.detachModule(last.moduleId).catch(() => undefined);
        }
        refreshLists();
      });

      // Web Bluetooth/Serial отдаёт входящие конверты сюда.
      unsubEnvelopeRef.current?.();
      unsubEnvelopeRef.current = transport.onEnvelope((message) => {
        if (!message || typeof message.chatId !== 'string' || !message.envelope) return;
        const env = message.envelope as Record<string, any>;
        if (message.chatId === '__presence__' && env?.kind === 'presence') {
          setMeshPeer({
            userId: String(env.userId || ''),
            username: String(env.username || ''),
            publicId: env.publicId != null ? String(env.publicId) : undefined,
          });
          return;
        }
        emitMeshEnvelope(message.envelope as never);
      });
      // Пока модуль подключён, messaging может отправлять через mesh.
      setMeshSender((chatId, envelope) => transport.sendEnvelope(chatId, envelope));

      // Profile-presence: только username/publicId/userId, без списка чатов.
      if (session) {
        const presence = () => {
          void transport
            .sendEnvelope('__presence__', {
              kind: 'presence',
              userId: session.userId,
              username: session.username,
              publicId: nextInfo.publicId,
            })
            .catch(() => undefined);
        };
        if (presenceTimerRef.current) clearInterval(presenceTimerRef.current);
        presence();
        presenceTimerRef.current = setInterval(presence, 60_000);
      }

      let moduleId: string | undefined;
      let publicId = nextInfo.publicId;
      try {
        const paired = await api.pairModule({
          hardwareId: nextInfo.hardwareId,
          publicId: nextInfo.publicId,
          role: nextInfo.role,
          transport: kind,
          firmware: nextInfo.firmware || undefined,
          battery: nextInfo.battery,
        });
        moduleId = moduleIdOf(paired);
        publicId = nextInfo.publicId ?? paired.publicId;
      } catch (pairError) {
        // Связь есть, но сервер не принял привязку — показываем причину,
        // соединение не рвём: модуль может работать локально.
        if (mountedRef.current) {
          setError(
            pairError instanceof Error
              ? `Модуль подключён, но привязка не удалась: ${pairError.message}`
              : 'Модуль подключён, но привязка не удалась.',
          );
        }
      }

      const record: LastModuleRecord = {
        hardwareId: nextInfo.hardwareId,
        publicId,
        moduleId,
        role: nextInfo.role,
        kind,
      };
      lastRecordRef.current = record;
      await writeLastModule(kv, record);

      setTransportModule({ gateway: nextInfo.role === 'gateway', model: nextInfo.role });
      setTransportGateway(Boolean(nextInfo.gateway));
      setMeshCapabilities({
        connected: true,
        gateway: Boolean(nextInfo.gateway),
        queue: Number(nextInfo.queue ?? 0),
        neighbors: Number((nextInfo as { neighbors?: number }).neighbors ?? 0),
      });

      // Носимый модуль физически подключён к этому клиенту.
      if (nextInfo.role === 'wearable' && moduleId) {
        try {
          await api.attachModule(moduleId, kind);
        } catch {
          /* attach повторится при следующем восстановлении */
        }
      }
      refreshLists();
      // Уведомление о подключении (не чаще раза в 5 минут на устройство).
      const deviceKey = `${nextInfo.hardwareId}:${Math.floor(Date.now() / 300_000)}`;
      if (connectedToastRef.current !== deviceKey) {
        connectedToastRef.current = deviceKey;
        useStore.getState().pushToast({
          kind: 'success',
          message: `Модуль подключён${nextInfo.publicId ? ` · ${nextInfo.publicId}` : ''}`,
        });
      }
    },
    [refreshLists, setTransportModule],
  );

  /** Ручное подключение: пользователь сам выбирает устройство. */
  const connect = useCallback(
    async (kind: ConnectionKind): Promise<ModuleInfo | null> => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setBusy(kind);
      setError(null);
      const transport = getModuleTransport(kind);
      try {
        if (!transport.supported) {
          throw new ModuleTransportError(
            kind === 'usb'
              ? 'USB недоступен на этой платформе. На телефоне используйте BLE.'
              : 'Bluetooth недоступен в этом браузере. На iOS Safari Web Bluetooth нет — нужно нативное приложение.',
            'unsupported',
          );
        }
        const nextInfo = await transport.open();
        await adopt(transport, nextInfo);
        return nextInfo;
      } catch (connectError) {
        await transport.close().catch(() => undefined);
        const message =
          connectError instanceof Error ? connectError.message : 'Не удалось подключить модуль.';
        lastErrorRef.current = message;
        if (mountedRef.current) setError(message);
        return null;
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) setBusy(null);
      }
    },
    [adopt],
  );

  const connectUsb = useCallback(() => connect('usb'), [connect]);
  const connectBle = useCallback(() => connect('ble'), [connect]);

  /** Принять найденный модуль (кнопка «Подключить» в глобальном окне). */
  const acceptAutoModule = useCallback(async () => {
    const item = autoRef.current;
    if (!item || item.phase === 'connected') return;
    setAutoModule({ ...item, phase: 'connecting', error: undefined });
    const info = await connectBle();
    if (!mountedRef.current) return;
    if (info) {
      setAutoModule({ ...item, phase: 'connected' });
      if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
      autoTimerRef.current = setTimeout(() => setAutoModule(null), 2600);
    } else {
      setAutoModule({
        ...item,
        phase: 'failed',
        error: lastErrorRef.current ?? 'Не удалось подключить модуль',
      });
    }
  }, [connectBle]);

  /** Игнорировать модуль до перезапуска приложения. */
  const dismissAutoModule = useCallback(() => {
    const item = autoRef.current;
    if (item) {
      ignoredModulesRef.current.add(item.key);
      cancelAutoKeyRef.current = item.key;
    }
    if (autoTimerRef.current) {
      clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }
    setAutoModule(null);
  }, []);

  const disconnect = useCallback(async () => {
    const last = lastRecordRef.current;
    await detachCurrent();
    setTransportModule(null);
    if (last?.moduleId && last.role === 'wearable') {
      await api.detachModule(last.moduleId).catch(() => undefined);
    }
    refreshLists();
  }, [detachCurrent, refreshLists, setTransportModule]);

  /**
   * Смена Wi-Fi роутера у шлюза: уходит кадром SET_CONFIG через активное
   * USB/BLE-соединение. Пароль не пишем ни в ошибки, ни в консоль.
   */
  const configureGateway = useCallback(async (ssid: string, password: string): Promise<boolean> => {
    const transport = connectionRef.current;
    const current = infoRef.current;
    const fail = (message: string) => {
      if (mountedRef.current) setError(message);
      useStore.getState().pushToast({ kind: 'error', message });
      return false;
    };
    if (!transport?.isOpen || !current) {
      return fail('Шлюз не подключён. Подключите его по USB/BLE и повторите.');
    }
    if (current.role !== 'gateway') {
      return fail('Настройка Wi-Fi доступна только шлюзу.');
    }
    if (!transport.sendConfig) {
      return fail('Эта прошивка не поддерживает смену Wi-Fi роутера. Обновите прошивку шлюза.');
    }
    const wifiSsid = ssid.trim();
    if (!wifiSsid) return fail('Укажите SSID Wi-Fi роутера.');
    if (password.length > 0 && password.length < 8) {
      return fail('Пароль Wi-Fi короче 8 символов. Для открытой сети оставьте поле пустым.');
    }

    if (mountedRef.current) {
      setConfiguring(true);
      setError(null);
    }
    try {
      await transport.sendConfig({ wifiSsid, wifiPassword: password });
      useStore.getState().pushToast({
        kind: 'success',
        message: `Настройки Wi-Fi отправлены шлюзу · ${wifiSsid}`,
      });
      return true;
    } catch {
      return fail('Не удалось отправить Wi-Fi настройки шлюзу. Проверьте подключение и повторите.');
    } finally {
      if (mountedRef.current) setConfiguring(false);
    }
  }, []);

  /** Автовосстановление последнего модуля без запроса нового порта/устройства. */
  const restore = useCallback(async () => {
    if (!useStore.getState().session) return;
    if (inFlightRef.current || connectionRef.current) return;
    if (autoRef.current?.phase === 'found' || autoRef.current?.phase === 'connecting') return;
    const now = Date.now();
    if (now - lastAttemptRef.current < AUTO_RETRY_MS) return;
    lastAttemptRef.current = now;
    inFlightRef.current = true;

    const last = await readLastModule(kv);
    lastRecordRef.current = last;

    try {
      // На смартфоне показываем глобальное окно найденного модуля.
      if (Platform.OS !== 'web') {
        const scanTransport = getModuleTransport('ble');
        const nearby = scanTransport.scan ? await scanTransport.scan(2500).catch(() => []) : [];
        setNearbyModules(nearby);
        const available = nearby.filter((device) => !ignoredModulesRef.current.has(device.id));
        const mineKey = String(last?.publicId ?? last?.hardwareId ?? '')
          .toLowerCase()
          .replace(/^esp32-/, '');
        const mine = mineKey
          ? available.find(
              (device) =>
                device.name.toLowerCase().includes(mineKey) || device.id.toLowerCase().includes(mineKey),
            ) ?? null
          : null;
        const candidate = available[0] ?? null;

        if (!last?.hardwareId) {
          if (candidate) {
            setAutoModule({ key: candidate.id, name: candidate.name, isMine: false, phase: 'found' });
          }
          return;
        }

        // Если рядом есть чужой модуль, а свой не найден — предлагаем подключить.
        if (!mine && candidate) {
          setAutoModule({ key: candidate.id, name: candidate.name, isMine: false, phase: 'found' });
          return;
        }

        if (!mine) {
          // Своего модуля нет в эфире — не пытаемся подключаться к выключенному
          // устройству и не показываем бесконечные уведомления.
          setAutoModule((prev) => (prev && prev.isMine ? null : prev));
          return;
        }

        const key = mine.id;
        const displayName = mine?.name ?? `Модуль ${last.publicId ?? ''}`.trim();
        cancelAutoKeyRef.current = null;
        setAutoModule({ key, name: displayName, isMine: true, phase: 'connecting' });

        const transport = getModuleTransport('ble');
        if (!transport.openKnown) {
          setAutoModule(null);
          return;
        }
        try {
          const nextInfo = await transport.openKnown(last.hardwareId, 5000);
          if (cancelAutoKeyRef.current === key) {
            await transport.close().catch(() => undefined);
            setAutoModule(null);
            return;
          }
          if (nextInfo) {
            await adopt(transport, nextInfo);
            setAutoModule((prev) => (prev && prev.key === key ? { ...prev, phase: 'connected' } : prev));
            if (autoTimerRef.current) clearTimeout(autoTimerRef.current);
            autoTimerRef.current = setTimeout(() => setAutoModule(null), 2600);
            return;
          }
          await transport.close().catch(() => undefined);
          if (cancelAutoKeyRef.current !== key) {
            setAutoModule((prev) =>
              prev && prev.key === key
                ? { ...prev, phase: 'failed', error: lastErrorRef.current ?? 'Модуль не отвечает' }
                : prev,
            );
          }
        } catch (e) {
          await transport.close().catch(() => undefined);
          if (cancelAutoKeyRef.current !== key) {
            setAutoModule((prev) =>
              prev && prev.key === key
                ? { ...prev, phase: 'failed', error: e instanceof Error ? e.message : String(e) }
                : prev,
            );
          }
        }
        return;
      }

      if (!last?.hardwareId) return;

      // web: сначала USB (уже разрешённые порты), затем Web Bluetooth, если он есть.
      const order: ConnectionKind[] =
        last.kind === 'ble'
          ? webBluetoothSupported()
            ? ['ble', 'usb']
            : ['usb']
          : ['usb', ...(webBluetoothSupported() ? (['ble'] as const) : [])];

      if (order.length) setBusy(order[0]);
      for (const kind of order) {
        const transport = getModuleTransport(kind);
        if (!transport.supported || !transport.openKnown) continue;
        try {
          const nextInfo = await transport.openKnown(last.hardwareId, 3000);
          if (nextInfo) {
            await adopt(transport, nextInfo);
            return;
          }
          await transport.close().catch(() => undefined);
        } catch {
          await transport.close().catch(() => undefined);
        }
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [adopt, setNearbyModules]);

  // Первичное восстановление и возврат из фона. На экране логина сессии нет — не сканируем.
  useEffect(() => {
    if (!session) return undefined;
    // Большая задержка после входа: iOS-диалог BLE-разрешения не должен
    // пересекаться с монтированием чатов и первым рендером главного экрана.
    const timer = setTimeout(() => void restore(), 4500);
    let activeTimer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (activeTimer) clearTimeout(activeTimer);
      activeTimer = setTimeout(() => void restore(), 3000);
    });
    return () => {
      clearTimeout(timer);
      if (activeTimer) clearTimeout(activeTimer);
      sub.remove();
    };
  }, [session?.userId, restore, session]);

  // Пока приложение открыто на смартфоне — периодически ищем носимый модуль
  // и подключаемся к ранее привязанному. В фоне не сканируем (экономия батареи).
  useEffect(() => {
    if (!session || Platform.OS === 'web') return undefined;
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      if (connectionRef.current || inFlightRef.current) return;
      void restore();
    }, 35_000);
    return () => clearInterval(timer);
  }, [session, restore]);

  // Периодически обновляем нагрузку mesh для политики трафика.
  useEffect(() => {
    const timer = setInterval(() => {
      const current = connectionRef.current;
      const currentInfo = current?.info;
      if (!current || !currentInfo) return;
      setMeshCapabilities({
        connected: true,
        gateway: Boolean(currentInfo.gateway),
        queue: Number(currentInfo.queue ?? 0),
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, []);

  // При выходе из аккаунта закрываем модуль, чтобы не висеть с чужой привязкой.
  useEffect(() => {
    if (session) return;
    const last = lastRecordRef.current;
    void detachCurrent();
    setTransportModule(null);
    if (last?.moduleId && last.role === 'wearable') {
      void api.detachModule(last.moduleId).catch(() => undefined);
    }
  }, [session, detachCurrent, setTransportModule]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      unsubEnvelopeRef.current?.();
      unsubDisconnectRef.current?.();
      void connectionRef.current?.close().catch(() => undefined);
    };
  }, []);

  const value = useMemo<ModuleContextValue>(
    () => ({
      connection,
      info,
      connected: Boolean(connection?.isOpen && info),
      busy,
      configuring,
      error,
      supportedUsb: Platform.OS === 'web' && webSerialSupported(),
      supportedBle: Platform.OS === 'web' ? webBluetoothSupported() : true,
      connectUsb,
      connectBle,
      disconnect,
      configureGateway,
      clearError,
      getLastError: () => lastErrorRef.current,
      autoModule,
      acceptAutoModule,
      dismissAutoModule,
      restore,
    }),
    [connection, info, busy, configuring, error, connectUsb, connectBle, disconnect, configureGateway, clearError, autoModule, acceptAutoModule, dismissAutoModule, restore],
  );

  return <ModuleContext.Provider value={value}>{children}</ModuleContext.Provider>;
}
