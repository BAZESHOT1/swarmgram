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
import { usePathname } from 'expo-router';
import { api, isPendingTransfer } from '../data/api';
import { kv } from '../crypto/storage';
import { useStore } from '../state/useStore';
import { getModuleTransport, webBluetoothSupported, webSerialSupported } from './transport';
import { prepareBle } from './ble';
import { rememberIdentity } from '../mesh/MeshIdentityService';
import { emitMeshEnvelope, setMeshCapabilities, setMeshSender, setMeshV1Sender } from './meshLink';
import { KMeshV1Client } from '../kmesh/v1/client';
import { crc16 } from '../kmesh/v1/protocol';
import { startMeshForegroundService, stopMeshForegroundService } from './background';
import { classifyModuleName, decodeOwnerClaimToken, parseModuleBleName } from './identity';
import { loadCachedIdentity, refreshCachedIdentity } from '../kmesh/v1/identity';
import {
  addPendingBleClaim,
  listPendingBleClaims,
  removePendingBleClaim,
} from '../data/db';
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

/** Оба порядка байт MAC: прошивки разных версий могли форматировать eFuse
 *  в прямом и обратном порядке. Сравниваем по обоим, чтобы reconnect не
 *  зависел от версии прошивки. */
function macVariants(value: string): string[] {
  const hex = value.toLowerCase().replace(/^esp32-/, '').replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return [value.toLowerCase()];
  const reversed = hex.match(/.{2}/g)?.reverse().join('') ?? hex;
  return [hex, reversed, `esp32-${hex}`, `esp32-${reversed}`];
}

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
  const pathname = usePathname();
  void pathname;
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
  const v1ClientRef = useRef<KMeshV1Client | null>(null);
  const v1UnsubRef = useRef<(() => void) | null>(null);
  const unsubInfoRef = useRef<(() => void) | null>(null);
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
    unsubInfoRef.current?.();
    unsubDisconnectRef.current?.();
    v1UnsubRef.current?.();
    v1UnsubRef.current = null;
    v1ClientRef.current = null;
    setMeshV1Sender(null);
    unsubEnvelopeRef.current = null;
    unsubInfoRef.current = null;
    unsubDisconnectRef.current = null;
    const current = connectionRef.current;
    connectionRef.current = null;
    infoRef.current = null;
    if (mountedRef.current) {
      setConnection(null);
      setInfo(null);
    }
    if (current) await current.close().catch(() => undefined);
    useStore.getState().setMeshIncomingActive(false);
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

      // Android: пока модуль подключён, mesh живёт в foreground service.
      // Запускаем сразу после установления связи, пока приложение активно
      // (Android 12+ ограничивает старт сервиса из фона).
      // iOS: no-op (background BLE включён через UIBackgroundModes).
      void startMeshForegroundService({ publicId: nextInfo.publicId, role: nextInfo.role });

      unsubInfoRef.current?.();
      unsubInfoRef.current =
        transport.onInfo?.((next) => {
          if (connectionRef.current !== transport) return;
          infoRef.current = next;
          if (mountedRef.current) setInfo(next);
          setTransportModule({ gateway: Boolean(next.gateway), model: next.role });
          setTransportGateway(Boolean(next.gateway));
          setMeshCapabilities({
            connected: true,
            gateway: Boolean(next.gateway),
            queue: Number(next.queue ?? 0),
            neighbors: Number(next.neighbors ?? 0),
          });
        }) ?? null;

      unsubDisconnectRef.current?.();
      unsubDisconnectRef.current = transport.onDisconnect(() => {
        if (connectionRef.current !== transport) return;
        void stopMeshForegroundService();
        const last = lastRecordRef.current;
        connectionRef.current = null;
        infoRef.current = null;
        unsubInfoRef.current?.();
        unsubInfoRef.current = null;
        setMeshSender(null);
        setMeshCapabilities({ connected: false, gateway: false, queue: 0, neighbors: 0 });
        useStore.getState().setMeshIncomingActive(false);
        if (mountedRef.current) {
          setConnection(null);
          setInfo(null);
          setTransportModule(null);
          setTransportGateway(false);
        }
        if (presenceTimerRef.current) {
          clearInterval(presenceTimerRef.current);
          presenceTimerRef.current = null;
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
        // Входящий mesh-трафик: отмечаем активность до любых веток обработки.
        useStore.getState().setMeshIncomingActive(true);
        const env = message.envelope as Record<string, any>;
        if (message.chatId === '__presence__' && env?.kind === 'presence') {
          setMeshPeer({
            userId: String(env.userId || ''),
            username: String(env.username || ''),
            publicId: env.publicId != null ? String(env.publicId) : undefined,
          });
          return;
        }
        // Отдаём конверт всем слушателям без фильтра по chatId. Через этот же
        // путь идут KMT http_resp (chatId '__http__'), поэтому guard здесь недопустим.
        emitMeshEnvelope(message.envelope as never);
      });
      // Пока модуль подключён, messaging может отправлять через mesh.
      setMeshSender((chatId, envelope) => transport.sendEnvelope(chatId, envelope));

      // KMesh_v1: тот же GATT, но бинарный протокол. Он приоритетнее
      // legacy-конвертов и уходит на шлюз флагом TO_INTERNET.
      if (transport.rawLink) {
        const raw = transport.rawLink;
        const refOf = (chatId: string): number => crc16(new TextEncoder().encode(chatId)) || 1;
        const resolveChat = (ref: number): string | undefined => {
          const lists = [
            qc.getQueryData<Array<{ id?: unknown }>>(['chats', session?.username]),
            qc.getQueryData<Array<{ id?: unknown }>>(['chats']),
          ];
          for (const list of lists) {
            if (!Array.isArray(list)) continue;
            const found = list.find(
              (row) => row && typeof row.id === 'string' && refOf(row.id) === ref,
            );
            if (found && typeof found.id === 'string') return found.id;
          }
          return undefined;
        };
        const v1 = new KMeshV1Client({
          link: { send: (frame) => raw.send(frame) },
          resolveChatByRef: resolveChat,
          onInfo: (info) => setMeshCapabilities({ queue: info.queue }),
          onMessage: (message) => {
            if (!message.text || message.srcNodeId === v1.getNodeId()) return;
            const chatId = resolveChat(message.chatRef);
            if (!chatId) return;
            const createdAt = new Date(message.createdAt || Date.now()).toISOString();
            const entry = {
              id: message.msgUuid,
              chatId,
              seq: 0,
              kind: 'text',
              text: message.text,
              createdAt,
              mine: false,
              senderNodeId: message.srcNodeId,
            };
            qc.setQueryData<unknown[]>(['messages', chatId], (prev) => {
              const list = Array.isArray(prev) ? prev : [];
              if (list.some((m) => (m as { id?: string })?.id === entry.id)) return list;
              return [...list, entry].sort(
                (a, b) =>
                  new Date((a as { createdAt?: string })?.createdAt ?? 0).getTime() -
                  new Date((b as { createdAt?: string })?.createdAt ?? 0).getTime(),
              );
            });
            useStore.getState().setChatPreview(chatId, {
              id: entry.id,
              text: entry.text,
              kind: 'text',
              mine: false,
              at: createdAt,
            });
            void qc.invalidateQueries({ queryKey: ['chats'] });
          },
        });
        v1ClientRef.current = v1;
        v1UnsubRef.current = raw.onData((chunk) => v1.handleData(chunk));
        setMeshV1Sender(async (chatId, text) => {
          try {
            const result = await v1.sendText({
              chatId,
              chatRef: refOf(chatId),
              peerNodeId: 1,
              text,
              toInternet: true,
            });
            return result.state !== 'FAILED';
          } catch {
            return false;
          }
        });
        void v1.hello();
      }

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
          bleMac: nextInfo.bleMac,
          publicId: nextInfo.publicId,
          role: nextInfo.role,
          transport: kind,
          firmware: nextInfo.firmware || undefined,
          battery: nextInfo.battery,
        });
        if (isPendingTransfer(paired)) {
          const message = 'Модуль принадлежит другому пользователю. Заявка на перенос отправлена.';
          if (mountedRef.current) setError(message);
          useStore.getState().pushToast({ kind: 'error', message });
        } else {
          moduleId = moduleIdOf(paired);
          publicId = nextInfo.publicId ?? paired.publicId;
        }
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

      // Свободный модуль: после ручного подключения сразу привязываем
      // к текущему пользователю и переименовываем BLE через SET_OWNER.
      if ((nextInfo.ownerPrefix ?? '').toLowerCase() === '00000000' && transport.setOwner) {
        try {
          const claim = await api.kmeshV1ClaimModule(nextInfo.hardwareId);
          const decoded = claim.claimToken ? decodeOwnerClaimToken(claim.claimToken) : null;
          if (decoded) {
            await transport.setOwner(decoded);
            useStore.getState().pushToast({
              kind: 'success',
              message: `Модуль привязан: KL-${decoded.prefix}-${claim.mod6 ?? ''}`,
            });
            void refreshCachedIdentity();
          }
        } catch {
          /* привязка повторится при следующем подключении */
        }
      }

      // Чужой модуль: ручное подключение создаёт контракт передачи.
      if (nextInfo.ownerPrefix && nextInfo.ownerPrefix !== '00000000') {
        const my = await loadCachedIdentity();
        if (my && nextInfo.ownerPrefix !== my.blePrefix) {
          try {
            const req = await api.kmeshV1RequestModuleTransfer(nextInfo.hardwareId);
            useStore.getState().pushToast({
              kind: 'info',
              message: req.deduped
                ? 'Запрос на передачу уже отправлен прежнему владельцу.'
                : 'Запрос на передачу модуля отправлен прежнему владельцу.',
            });
          } catch {
            /* оффлайн: заявка уйдёт после восстановления сети */
          }
        }
      }

      const record: LastModuleRecord = {
        hardwareId: nextInfo.hardwareId,
        publicId,
        moduleId,
        role: nextInfo.role,
        kind,
      };
      void rememberIdentity(nextInfo);
      lastRecordRef.current = record;
      await writeLastModule(kv, record);

      setTransportModule({ gateway: Boolean(nextInfo.gateway), model: nextInfo.role });
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
    void stopMeshForegroundService();
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
        // Префикс своего модуля читаем ДО сканирования: иначе первый скан
        // может принять чужой KL-модуль за свой.
        const identity = (await loadCachedIdentity()) ?? (await refreshCachedIdentity());
        const myPrefix = identity?.blePrefix ?? null;
        const scanTransport = getModuleTransport('ble');
        const nearby = scanTransport.scan ? await scanTransport.scan(2500).catch(() => []) : [];
        setNearbyModules(nearby);
        const available = nearby.filter((device) => !ignoredModulesRef.current.has(device.id));
        let incomingClaims: Array<{ id: string; oldBleName: string; claimToken: string; moduleMac: string; mod6: string }> = [];
        try {
          const remote = await api.kmeshV1Modules();
          incomingClaims = remote.claims;
          for (const claim of remote.claims) {
            await addPendingBleClaim({
              bleName: claim.oldBleName,
              moduleMac: claim.moduleMac,
              mod6: claim.mod6,
              claimToken: claim.claimToken,
              createdAt: new Date().toISOString(),
            });
          }
        } catch {
          /* оффлайн: используем локальную очередь */
        }
        const pendingClaims = await listPendingBleClaims();

        // После подтверждения передачи Hub: подключаемся к старому имени
        // KL-<OLD>-<MOD6> и отправляем подписанный claim.
        for (const pending of pendingClaims) {
          const device = available.find((d) => d.name.toLowerCase() === pending.bleName.toLowerCase());
          if (!device) continue;
          const claim = decodeOwnerClaimToken(pending.claimToken);
          const transport = getModuleTransport('ble');
          if (!claim || !transport.setOwner) continue;
          try {
            setAutoModule({ key: device.id, name: device.name, isMine: true, phase: 'connecting' });
            if (transport.openDevice) await transport.openDevice(device.id);
            else await transport.openKnown?.(undefined, 5000);
            await transport.setOwner(claim);
            await transport.close().catch(() => undefined);
            await removePendingBleClaim(pending.bleName);
            const consumed = incomingClaims.find((c) => c.oldBleName === pending.bleName);
            if (consumed) await api.kmeshV1ConsumeModuleClaim(consumed.id).catch(() => undefined);
            useStore.getState().pushToast({
              kind: 'success',
              message: `Модуль ${pending.mod6} передан вам. Имя обновится на KL-${claim.prefix}-${pending.mod6}.`,
            });
            await refreshCachedIdentity();
            refreshLists();
            setAutoModule(null);
            return;
          } catch {
            await transport.close().catch(() => undefined);
          }
        }

        // Жёсткие правила: свой — автоподключение; свободный и чужой — только вручную.
        const ownDevices = available.filter(
          (device) => classifyModuleName(device.name, myPrefix) === 'own',
        );
        const lastMod6 = parseModuleBleName(String(last?.hardwareId ?? ''))?.mod6
          ?? String(last?.hardwareId ?? '').replace(/[^0-9a-f]/gi, '').slice(-6).toLowerCase();
        const mine = (lastMod6
          ? ownDevices.find((device) => parseModuleBleName(device.name)?.mod6 === lastMod6)
          : undefined) ?? ownDevices[0] ?? null;
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

  // Разрешение Bluetooth запрашиваем сами после входа, не дожидаясь, пока
  // пользователь откроет раздел модулей. Небольшая задержка нужна, чтобы
  // системный диалог уведомлений успел закрыться (iOS не умеет показывать
  // два разрешения одновременно).
  useEffect(() => {
    if (!session || Platform.OS === 'web') return undefined;
    const timer = setTimeout(() => void prepareBle(), 2500);
    return () => clearTimeout(timer);
  }, [session?.userId, session]);

  // Первичное восстановление и возврат из фона. Соединение с последним
  // модулем восстанавливаем сразу при запуске приложения, не дожидаясь,
  // пока пользователь откроет раздел «Модули».
  useEffect(() => {
    if (!session || Platform.OS === 'web') return undefined;
    const timer = setTimeout(() => void prepareBle().then(() => restore()), 900);
    let activeTimer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      if (activeTimer) clearTimeout(activeTimer);
      activeTimer = setTimeout(() => void restore(), 1200);
    });
    return () => {
      clearTimeout(timer);
      if (activeTimer) clearTimeout(activeTimer);
      sub.remove();
    };
  }, [session?.userId, restore, session]);

  // Переход в фон не должен рвать BLE: соединение и активное сканирование
  // продолжают жить (iOS — bluetooth-central, Android — foreground service).
  // При возврате в active сверяем состояние и при необходимости восстанавливаем.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const current = connectionRef.current;
      if (!current) return;
      if (current.isOpen) return;
      // Транспорт считает себя закрытым — честно снимаем состояние и
      // пробуем восстановить последний модуль.
      void detachCurrent();
      setTimeout(() => void restore(), 1200);
    });
    return () => sub.remove();
  }, [detachCurrent, restore]);

  // Пока приложение открыто на смартфоне — периодически ищем носимый модуль
  // и подключаемся к ранее привязанному. В фоне не сканируем (экономия батареи).
  useEffect(() => {
    if (!session || Platform.OS === 'web') return undefined;
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      if (connectionRef.current || inFlightRef.current) return;
      void restore();
    }, 30_000);
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
      // Статус gateway может появиться/пропасть уже после adopt — обновляем
      // индикатор канала, чтобы UI не висел в «соединении».
      setTransportModule({ gateway: Boolean(currentInfo.gateway), model: String(currentInfo.role ?? '') });
      setTransportGateway(Boolean(currentInfo.gateway));
      // Контекст должен видеть свежие gateway/rssi/queue, иначе шапка
      // показывает «нет связи», хотя модуль уже нашёл шлюз.
      setInfo((prev) => ({
        ...currentInfo,
        ...(prev ? { attached: prev.attached || currentInfo.attached } : {}),
      }));
    }, 5_000);
    return () => clearInterval(timer);
  }, [setTransportGateway, setTransportModule]);

  // При выходе из аккаунта закрываем модуль, чтобы не висеть с чужой привязкой.
  useEffect(() => {
    if (session) return;
    const last = lastRecordRef.current;
    void detachCurrent();
    void stopMeshForegroundService();
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
      void stopMeshForegroundService();
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
