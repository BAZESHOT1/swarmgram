/**
 * Admin → OTA по kMesh.
 *
 * Сводка (текущий релиз, активная раскатка и её прогресс) → 1) сборка релиза → 2) раскатка
 * (кластеры, чипы, транспорт) → 3) модули с состоянием обновления, сгруппированные по статусу.
 * Шлюз обновляется сам по Wi‑Fi и раздаёт образ узлам; не вернувшийся в кластер модуль откатывается.
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../data/api';
import { humanError } from '../../data/queries';
import { useStore } from '../../state/useStore';
import { useTheme } from '../../theme/useTheme';
import { Btn } from '../Btn';
import { GlassCard } from '../settings/SettingsUI';

const CHIPS = ['esp32', 'esp32c3', 'esp32s3', 'esp32c6', 'esp32c5'];
const OTA_STATE: Record<number, string> = { 0: 'ожидает', 1: 'загрузка', 2: 'проверка', 3: 'перезагрузка', 4: 'откат' };

function Chip({ label, active, onPress, icon }: { label: string; active: boolean; onPress: () => void; icon?: keyof typeof Ionicons.glyphMap }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: active }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: active ? theme.accent : theme.line,
        backgroundColor: active ? theme.accentSoft : 'transparent',
        opacity: pressed ? 0.8 : 1,
      })}
    >
      {icon ? <Ionicons name={icon} size={14} color={active ? theme.accent : theme.textSecondary} /> : null}
      <Text style={{ color: active ? theme.accent : theme.textPrimary, fontSize: 13, fontWeight: active ? '700' : '500' }}>{label}</Text>
    </Pressable>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 120, padding: 12, borderRadius: 16, borderWidth: 1, borderColor: theme.line, gap: 2 }}>
      <Text style={{ color: theme.textSecondary, fontSize: 11.5 }}>{label}</Text>
      <Text style={{ color: tone ?? theme.textPrimary, fontSize: 20, fontWeight: '800' }} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function Bar({ value, color }: { value: number; color: string }) {
  const theme = useTheme();
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: theme.line, overflow: 'hidden' }}>
      <View style={{ height: 8, width: `${Math.max(2, Math.min(100, Math.round(value * 100)))}%`, backgroundColor: color, borderRadius: 4 }} />
    </View>
  );
}

export function OtaPanel() {
  const theme = useTheme();
  const overview = useQuery({ queryKey: ['admin-ota'], queryFn: () => api.adminOtaOverview(), refetchInterval: 8000 });
  const [chips, setChips] = useState<string[]>(['esp32', 'esp32c3']);
  const [allClusters, setAllClusters] = useState(true);
  const [clusters, setClusters] = useState<number[]>([]);
  const [espnow, setEspnow] = useState(true);
  const [lora, setLora] = useState(false);
  const [rollChips, setRollChips] = useState<string[]>([]);
  const [busy, setBusy] = useState<'' | 'build' | 'start'>('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'progress' | 'done'>('all');

  const data = overview.data;
  const latestBuild = data?.releases.reduce((m, r) => Math.max(m, r.build_number), 0) ?? 0;
  const active = data?.rollouts.find((r) => r.status === 'active') ?? null;
  const building = data?.job?.status === 'running';
  const toast = (kind: 'success' | 'error', message: string) => useStore.getState().pushToast({ kind, message });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const nodes = data?.nodes ?? [];
  const target = active?.target_build ?? latestBuild;
  const stat = useMemo(() => {
    const done = nodes.filter((n) => target && n.fwBuild >= target).length;
    const progress = nodes.filter((n) => !(target && n.fwBuild >= target) && n.otaState > 0).length;
    return { done, progress, pending: nodes.length - done - progress };
  }, [nodes, target]);
  const shown = nodes.filter((n) => {
    const done = Boolean(target && n.fwBuild >= target);
    if (filter === 'done') return done;
    if (filter === 'progress') return !done && n.otaState > 0;
    if (filter === 'pending') return !done && !n.otaState;
    return true;
  });

  const buildRelease = async () => {
    setBusy('build');
    try {
      await api.adminOtaBuildRelease(chips);
      toast('success', 'Сборка релиза запущена — это займёт несколько минут.');
      void overview.refetch();
    } catch (e) {
      toast('error', humanError(e));
    } finally {
      setBusy('');
    }
  };

  const start = async () => {
    const mask = (espnow ? 1 : 0) | (lora ? 2 : 0);
    if (!mask) return toast('error', 'Выберите хотя бы один транспорт раздачи.');
    if (!allClusters && clusters.length === 0) return toast('error', 'Выберите кластеры или «Все кластеры».');
    setBusy('start');
    try {
      const res = await api.adminOtaStartRollout({ gateways: allClusters ? null : clusters, ifc_mask: mask, chips: rollChips.length ? rollChips : null });
      toast('success', `Раскатка сборки ${res.target_build} запущена.`);
      void overview.refetch();
    } catch (e) {
      toast('error', humanError(e));
    } finally {
      setBusy('');
    }
  };

  const stop = async (id: string) => {
    try {
      await api.adminOtaStopRollout(id);
      void overview.refetch();
    } catch (e) {
      toast('error', humanError(e));
    }
  };

  const Card = ({ step, title, hint, children }: { step?: string; title: string; hint?: string; children: React.ReactNode }) => (
    <GlassCard style={{ marginBottom: 12 }}>
      <View style={{ padding: 14, gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {step ? (
            <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: theme.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: theme.accent, fontWeight: '800', fontSize: 13 }}>{step}</Text>
            </View>
          ) : null}
          <Text style={{ color: theme.textPrimary, fontSize: 16, fontWeight: '800', flex: 1 }}>{title}</Text>
        </View>
        {hint ? <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 }}>{hint}</Text> : null}
        {children}
      </View>
    </GlassCard>
  );
  const Label = ({ text }: { text: string }) => <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '700', marginTop: 2 }}>{text}</Text>;

  if (overview.isLoading) {
    return (
      <View style={{ padding: 30, alignItems: 'center' }}>
        <ActivityIndicator color={theme.accent} />
      </View>
    );
  }

  return (
    <View style={{ marginBottom: 12 }}>
      {/* ---------------- сводка */}
      <Card title="Обновление модулей">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Stat label="Последний релиз" value={latestBuild ? `#${latestBuild}` : '—'} />
          <Stat label="Модулей в сети" value={String(nodes.length)} />
          <Stat label="Обновлено" value={`${stat.done}/${nodes.length || 0}`} tone={theme.success} />
          <Stat label="В процессе" value={String(stat.progress)} tone={stat.progress ? theme.accent : undefined} />
        </View>
        {active ? (
          <View style={{ gap: 6, padding: 12, borderRadius: 16, backgroundColor: theme.accentSoft }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator size="small" color={theme.accent} />
              <Text style={{ color: theme.textPrimary, fontWeight: '700', flex: 1 }}>
                Идёт раскатка сборки #{active.target_build} · {active.gateways ? `кластеров: ${active.gateways.length}` : 'все кластеры'}
              </Text>
              <Btn title="Остановить" size="s" variant="ghost" onPress={() => void stop(active.id)} />
            </View>
            <Bar value={nodes.length ? stat.done / nodes.length : 0} color={theme.accent} />
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
              {stat.done} обновлено · {stat.progress} в процессе · {stat.pending} ожидают ·{' '}
              {[(active.ifc_mask & 1) && 'ESP-NOW', (active.ifc_mask & 2) && 'LoRa'].filter(Boolean).join(' + ')}
            </Text>
          </View>
        ) : null}
      </Card>

      {/* ---------------- 1. релиз */}
      <Card
        step="1"
        title="Собрать релиз"
        hint="Hub собирает текущую прошивку для выбранных чипов (образ узла и образ шлюза). Настройки модулей (тип, пины, LoRa, Wi‑Fi, владелец) хранятся в их памяти и не меняются."
      >
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CHIPS.map((c) => (
            <Chip key={c} label={c} active={chips.includes(c)} icon="hardware-chip-outline" onPress={() => setChips((p) => toggle(p, c))} />
          ))}
        </View>
        <Btn
          title={building ? 'Идёт сборка…' : 'Собрать релиз'}
          loading={busy === 'build' || building}
          disabled={!chips.length || building}
          onPress={() => void buildRelease()}
        />
        {data?.job?.log?.length ? (
          <View style={{ padding: 10, borderRadius: 12, backgroundColor: theme.dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }}>
            <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontFamily: 'monospace' }}>{data.job.log.slice(-5).join('\n')}</Text>
          </View>
        ) : null}
        {(data?.releases ?? []).length ? <Label text="Готовые образы" /> : null}
        <View style={{ gap: 6 }}>
          {(data?.releases ?? []).slice(0, 10).map((r) => (
            <View
              key={`${r.chip}-${r.variant}-${r.build_number}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: theme.line }}
            >
              <Ionicons name={r.variant ? 'wifi-outline' : 'git-network-outline'} size={15} color={theme.accent} />
              <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '600', flex: 1 }}>
                {r.chip} · {r.variant ? 'шлюз' : 'узел'}
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12 }}>
                #{r.build_number} · {Math.round(r.full_size / 1024)} КБ
              </Text>
            </View>
          ))}
        </View>
      </Card>

      {/* ---------------- 2. раскатка */}
      <Card
        step="2"
        title="Запустить раскатку"
        hint="Шлюз кластера обновляется по Wi‑Fi и раздаёт образ модулям; каждый обновившийся модуль раздаёт его соседям. Не вернувшийся в кластер модуль сам откатывается на прошлую прошивку."
      >
        <Label text="Кластеры" />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Chip label="Все кластеры" icon="globe-outline" active={allClusters} onPress={() => setAllClusters((v) => !v)} />
          {!allClusters
            ? (data?.gateways ?? []).map((g) => (
                <Chip
                  key={g.gatewayId}
                  icon="radio-outline"
                  label={`${g.name || 'Шлюз'} · ${g.nodes}`}
                  active={clusters.includes(g.gatewayId)}
                  onPress={() => setClusters((p) => toggle(p, g.gatewayId))}
                />
              ))
            : null}
        </View>
        <Label text="Чипы (не выбрано — все)" />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CHIPS.map((c) => (
            <Chip key={c} label={c} active={rollChips.includes(c)} onPress={() => setRollChips((p) => toggle(p, c))} />
          ))}
        </View>
        <Label text="Транспорт раздачи" />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Chip label="ESP-NOW · быстро" icon="flash-outline" active={espnow} onPress={() => setEspnow((v) => !v)} />
          <Chip label="LoRa · только малые патчи" icon="cellular-outline" active={lora} onPress={() => setLora((v) => !v)} />
        </View>
        <Btn
          title={latestBuild ? `Раскатить сборку #${latestBuild}` : 'Сначала соберите релиз'}
          loading={busy === 'start'}
          disabled={!latestBuild || Boolean(active)}
          onPress={() => void start()}
        />
        {active ? <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Сначала остановите текущую раскатку.</Text> : null}
        {(data?.rollouts ?? []).length ? <Label text="История раскаток" /> : null}
        {(data?.rollouts ?? []).slice(0, 6).map((r) => (
          <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: r.status === 'active' ? theme.accent : theme.textDisabled }} />
            <Text style={{ color: theme.textSecondary, fontSize: 12.5, flex: 1 }} numberOfLines={2}>
              #{r.target_build} · {r.status === 'active' ? 'идёт' : 'остановлена'} · {r.gateways ? `кластеры ${r.gateways.join(', ')}` : 'все кластеры'}
              {r.chips?.length ? ` · ${r.chips.join(', ')}` : ''} · {[(r.ifc_mask & 1) && 'ESP-NOW', (r.ifc_mask & 2) && 'LoRa'].filter(Boolean).join(' + ')}
            </Text>
          </View>
        ))}
      </Card>

      {/* ---------------- 3. модули */}
      <Card step="3" title={`Модули${target ? ` · цель #${target}` : ''}`}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Chip label={`Все · ${nodes.length}`} active={filter === 'all'} onPress={() => setFilter('all')} />
          <Chip label={`Обновлены · ${stat.done}`} active={filter === 'done'} onPress={() => setFilter('done')} />
          <Chip label={`В процессе · ${stat.progress}`} active={filter === 'progress'} onPress={() => setFilter('progress')} />
          <Chip label={`Ожидают · ${stat.pending}`} active={filter === 'pending'} onPress={() => setFilter('pending')} />
        </View>
        {shown.length === 0 ? (
          <Text style={{ color: theme.textSecondary, fontSize: 13, paddingVertical: 8 }}>
            {nodes.length ? 'Нет модулей в этой группе.' : 'Нет модулей, слышанных за 30 минут.'}
          </Text>
        ) : null}
        {shown.map((n) => {
          const done = Boolean(target && n.fwBuild >= target);
          const color = done ? theme.success : n.otaState === 4 ? theme.danger : n.otaState ? theme.accent : theme.textDisabled;
          return (
            <View
              key={n.nodeId}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: theme.line }}
            >
              <Ionicons name={n.variant ? 'wifi' : 'git-network'} size={16} color={color} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
                  {n.name || n.nodeId}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 11.5 }}>
                  {n.chip} · {n.variant ? 'шлюз' : 'узел'} · сборка #{n.fwBuild}
                </Text>
              </View>
              <Text style={{ color, fontSize: 12, fontWeight: '700' }}>{done ? 'обновлён' : OTA_STATE[n.otaState] ?? `сост. ${n.otaState}`}</Text>
            </View>
          );
        })}
      </Card>
    </View>
  );
}
