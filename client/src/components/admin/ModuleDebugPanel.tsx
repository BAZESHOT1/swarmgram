/**
 * Admin → отладка модулей.
 *
 * Браузер сам не умеет открывать COM-порты, поэтому страница работает через
 * локальный bridge (tools/module-bridge): список портов, мониторы, сброс и
 * прошивка через esptool. Bridge слушает только 127.0.0.1.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import * as api from '../../data/api';
import { apiBase } from '../../data/api';
import { useStore } from '../../state/useStore';
import { useTheme } from '../../theme/useTheme';
import { GlassCard } from '../settings/SettingsUI';
import { SettingsInput, StatusBadge, toneForStatus } from '../settings/SettingsWidgets';
import { humanError } from '../../data/queries';

const DEFAULT_BRIDGE = 'http://127.0.0.1:8787';

interface BridgePort {
  path: string;
  friendlyName?: string;
  manufacturer?: string;
  open?: boolean;
  info?: { hardwareId?: string; publicId?: string; role?: string; firmware?: string } | null;
}

interface BridgeStatus {
  ok: boolean;
  python: boolean;
  pythonPath: string;
}

interface LogLine {
  line: string;
  ts: number;
}

export function ModuleDebugPanel() {
  const theme = useTheme();
  const session = useStore((s) => s.session);
  const [bridge, setBridge] = useState(DEFAULT_BRIDGE);
  const [health, setHealth] = useState<BridgeStatus | null>(null);
  const [ports, setPorts] = useState<BridgePort[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>('');
  const [buildId, setBuildId] = useState('');
  const [localFile, setLocalFile] = useState('');
  const [baud, setBaud] = useState('115200');
  const scrollRef = useRef<ScrollView | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const builds = useQuery({ queryKey: ['fw-builds-debug'], queryFn: () => api.api.firmwareBuilds() });
  const readyBuilds = useMemo(
    () => (builds.data ?? []).filter((b) => b.status === 'ready'),
    [builds.data],
  );

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('sg:bridge-url');
      if (saved) setBridge(saved);
    } catch { /* ignore */ }
  }, []);

  const rememberBridge = useCallback((value: string) => {
    setBridge(value);
    try { window.localStorage.setItem('sg:bridge-url', value); } catch { /* ignore */ }
  }, []);

  const call = useCallback(async (path: string, body?: unknown) => {
    const res = await fetch(`${bridge}${path}`, body === undefined ? undefined : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error ?? `http_${res.status}`);
    return json;
  }, [bridge]);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const h = await fetch(`${bridge}/api/health`).then((r) => r.json());
      setHealth(h);
      const p = await call('/api/ports');
      setPorts(p.ports ?? []);
      if (!selected && p.ports?.[0]?.path) setSelected(p.ports[0].path);
    } catch (e: unknown) {
      setHealth(null);
      setError(`Bridge недоступен: ${e instanceof Error ? e.message : String(e)}. Запустите tools/module-bridge/server.mjs`);
    }
  }, [bridge, call, selected]);

  useEffect(() => { void refresh(); }, [refresh]);

  // SSE-монитор выбранного порта.
  useEffect(() => {
    esRef.current?.close();
    esRef.current = null;
    if (!selected || Platform.OS !== 'web' || typeof EventSource === 'undefined') return undefined;
    const es = new EventSource(`${bridge}/api/stream?path=${encodeURIComponent(selected)}`);
    esRef.current = es;
    const onData = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as LogLine;
        setLines((prev) => [...prev.slice(-400), parsed]);
      } catch { /* ignore */ }
    };
    es.addEventListener('message', onData);
    es.addEventListener('status', (event: MessageEvent) => {
      try {
        const status = JSON.parse(event.data);
        setPorts((prev) => prev.map((p) => (p.path === status.path ? { ...p, ...status } : p)));
      } catch { /* ignore */ }
    });
    return () => { es.removeEventListener('message', onData); es.close(); };
  }, [bridge, selected]);

  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 50);
    return () => clearTimeout(t);
  }, [lines.length]);

  const openPort = async (path: string, reset = true) => {
    setBusy(`open:${path}`);
    setError('');
    try {
      await call('/api/open', { path, baud: Number(baud) || 115200 });
      if (!reset) await call('/api/reset', { path }).catch(() => undefined);
      setSelected(path);
      await refresh();
    } catch (e: unknown) { setError(humanError(e)); } finally { setBusy(''); }
  };

  const closePort = async (path: string) => {
    setBusy(`close:${path}`);
    try { await call('/api/close', { path }); await refresh(); }
    catch (e: unknown) { setError(humanError(e)); } finally { setBusy(''); }
  };

  const resetPort = async (path: string) => {
    setBusy(`reset:${path}`);
    try { await call('/api/reset', { path }); }
    catch (e: unknown) { setError(humanError(e)); } finally { setBusy(''); }
  };

  const flash = async (path: string) => {
    setBusy(`flash:${path}`);
    setError('');
    try {
      const build = readyBuilds.find((b) => b.id === buildId);
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      const url = build
        ? `${apiBase.startsWith('http') ? apiBase : `${origin}${apiBase}`}/v1/firmware/builds/${build.id}/download`
        : undefined;
      const board = String((build?.config as { board?: string } | undefined)?.board ?? 'esp32');
      await call('/api/flash', {
        path,
        url,
        file: localFile.trim() || undefined,
        token: session?.accessToken,
        board,
      });
      setSelected(path);
      await refresh();
    } catch (e: unknown) { setError(humanError(e)); } finally { setBusy(''); }
  };

  const webOnly = Platform.OS !== 'web';

  return (
    <View style={{ gap: 10 }}>
      <GlassCard>
        <View style={{ padding: 12, gap: 8 }}>
          <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }}>Локальный bridge</Text>
          <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17 }}>
            Запустите на ПК: `node tools/module-bridge/server.mjs`. Нужны Python 3 + esptool и npm-пакет serialport.
          </Text>
          <SettingsInput
            label="Адрес bridge"
            value={bridge}
            onChangeText={rememberBridge}
            placeholder={DEFAULT_BRIDGE}
            autoCapitalize="none"
          />
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Pressable onPress={() => void refresh()} style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, backgroundColor: theme.accentSoft }}>
              <Text style={{ color: theme.accent, fontWeight: '700', fontSize: 12 }}>Проверить</Text>
            </Pressable>
            <StatusBadge text={health?.ok ? 'bridge online' : 'bridge offline'} tone={health?.ok ? 'success' : 'danger'} />
            {health ? <StatusBadge text={health.python ? 'esptool ok' : 'нет python'} tone={health.python ? 'success' : 'warning'} /> : null}
          </View>
          {error ? <Text style={{ color: theme.danger, fontSize: 12 }}>{error}</Text> : null}
          {webOnly ? (
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
              Мониторы COM-портов доступны в веб-версии админки (на телефоне браузер не даёт доступ к портам ПК).
            </Text>
          ) : null}
        </View>
      </GlassCard>

      <GlassCard>
        <View style={{ padding: 12, gap: 8 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }}>Порты</Text>
            <Pressable onPress={() => void refresh()}><Ionicons name="refresh" size={18} color={theme.accent} /></Pressable>
          </View>
          {ports.length === 0 ? (
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Портов не найдено. Подключите модуль USB-кабелем с данными.</Text>
          ) : ports.map((port) => (
            <View key={port.path} style={{ borderTopWidth: 1, borderTopColor: theme.line, paddingTop: 8, gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: 13 }}>{port.path}</Text>
                <Text style={{ color: theme.textSecondary, fontSize: 11 }} numberOfLines={1}>{port.friendlyName}</Text>
                <StatusBadge text={port.open ? 'открыт' : 'закрыт'} tone={port.open ? 'success' : 'neutral'} />
                {port.info?.hardwareId ? <StatusBadge text={port.info.hardwareId} tone="accent" /> : null}
              </View>
              {port.info ? (
                <Text style={{ color: theme.textSecondary, fontSize: 11.5 }}>
                  {port.info.role ?? '—'} · {port.info.firmware ?? '—'} · ID {port.info.publicId ?? '—'}
                </Text>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <SmallBtn label="Монитор" onPress={() => void openPort(port.path)} color={theme.accent} />
                <SmallBtn label="Сброс" onPress={() => void resetPort(port.path)} color={theme.warning ?? theme.textSecondary} />
                <SmallBtn label="Закрыть" onPress={() => void closePort(port.path)} color={theme.textSecondary} />
                <SmallBtn
                  label={busy === `flash:${port.path}` ? 'Прошивка…' : 'Прошить'}
                  onPress={() => void flash(port.path)}
                  color={theme.success}
                  disabled={Boolean(busy)}
                />
              </View>
            </View>
          ))}
        </View>
      </GlassCard>

      <GlassCard>
        <View style={{ padding: 12, gap: 8 }}>
          <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }}>Прошивка</Text>
          <SettingsInput label="Baud монитора" value={baud} onChangeText={setBaud} keyboardType="numeric" />
          <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
            Готовая сборка (скачается через Hub и прошьётся в 0x0):
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {readyBuilds.slice(0, 8).map((b) => {
              const active = b.id === buildId;
              const board = String((b.config as { board?: string } | undefined)?.board ?? '');
              return (
                <Pressable
                  key={b.id}
                  onPress={() => setBuildId(active ? '' : b.id)}
                  style={{
                    paddingVertical: 7, paddingHorizontal: 10, borderRadius: 12,
                    borderWidth: 1, borderColor: active ? theme.accent : theme.line,
                    backgroundColor: active ? theme.accentSoft : 'transparent',
                  }}
                >
                  <Text style={{ color: active ? theme.accent : theme.textPrimary, fontSize: 12, fontWeight: '700' }}>
                    {board || 'board'} · {b.version || b.id.slice(0, 8)}
                  </Text>
                  <Text style={{ color: theme.textSecondary, fontSize: 10.5 }}>
                    {new Date(b.createdAt).toLocaleString()}
                  </Text>
                </Pressable>
              );
            })}
            {readyBuilds.length === 0 ? (
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Нет готовых сборок — соберите в разделе «Прошивка».</Text>
            ) : null}
          </ScrollView>
          <SettingsInput
            label="…или локальный merged.bin (путь на ПК)"
            value={localFile}
            onChangeText={setLocalFile}
            placeholder="C:\\firmware\\merged.bin"
            autoCapitalize="none"
          />
        </View>
      </GlassCard>

      <GlassCard>
        <View style={{ padding: 12, gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }}>
              Монитор {selected || '—'}
            </Text>
            <Pressable onPress={() => setLines([])}>
              <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }}>Очистить</Text>
            </Pressable>
          </View>
          <View style={{ backgroundColor: theme.surfacePressed, borderRadius: 10, padding: 8, minHeight: 180, maxHeight: 420 }}>
            <ScrollView ref={scrollRef} onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}>
              {lines.length === 0 ? (
                <Text style={{ color: theme.textSecondary, fontSize: 11.5 }}>Откройте порт кнопкой «Монитор»…</Text>
              ) : lines.map((item, index) => (
                <Text
                  key={`${item.ts}-${index}`}
                  style={{ color: theme.textPrimary, fontSize: 10.5, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined }}
                >
                  {item.line}
                </Text>
              ))}
            </ScrollView>
          </View>
        </View>
      </GlassCard>
    </View>
  );
}

function SmallBtn({ label, onPress, color, disabled }: { label: string; onPress: () => void; color: string; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10,
        borderWidth: 1, borderColor: color, opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color, fontSize: 11.5, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}
