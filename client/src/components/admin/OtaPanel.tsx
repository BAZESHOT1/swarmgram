/**
 * Admin → OTA по kMesh.
 *
 * 1) «Собрать релиз»: Hub собирает канонические образы текущей прошивки (узел и шлюз) для
 *    выбранных чипов — один образ на чип/вариант, настройки модулей живут в их NVS.
 * 2) «Раскатка»: выбрать кластеры (шлюзы) и транспорты раздачи (ESP-NOW / LoRa). Шлюз сначала
 *    обновляется сам по Wi-Fi, затем раздаёт образ узлам; обновившийся узел раздаёт дальше.
 *    Если после обновления модуль не вернулся в кластер — он сам откатывается.
 */
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../data/api';
import { humanError } from '../../data/queries';
import { useStore } from '../../state/useStore';
import { useTheme } from '../../theme/useTheme';
import { Btn } from '../Btn';
import { GlassCard } from '../settings/SettingsUI';
import { StatusBadge } from '../settings/SettingsWidgets';

const CHIPS = ['esp32', 'esp32c3', 'esp32s3', 'esp32c6', 'esp32c5'];
const OTA_STATE: Record<number, string> = {
  0: 'ожидает',
  1: 'загрузка',
  2: 'проверка',
  3: 'перезагрузка',
  4: 'откат',
};

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: value }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4, paddingRight: 10 }}
    >
      <Ionicons name={value ? 'checkbox' : 'square-outline'} size={18} color={value ? theme.accent : theme.textDisabled} />
      <Text style={{ color: theme.textPrimary, fontSize: 12.5 }}>{label}</Text>
    </Pressable>
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
  /** Пусто — все чипы; иначе поэтапно, например сначала только esp32c3. */
  const [rollChips, setRollChips] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const data = overview.data;
  const latestBuild = data?.releases.reduce((m, r) => Math.max(m, r.build_number), 0) ?? 0;
  const active = data?.rollouts.find((r) => r.status === 'active') ?? null;
  const toast = (kind: 'success' | 'error', message: string) => useStore.getState().pushToast({ kind, message });

  const buildRelease = async () => {
    setBusy(true);
    try {
      await api.adminOtaBuildRelease(chips);
      toast('success', 'Сборка релиза запущена — это займёт несколько минут.');
      void overview.refetch();
    } catch (e) {
      toast('error', humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const mask = (espnow ? 1 : 0) | (lora ? 2 : 0);
    if (!mask) return toast('error', 'Выберите хотя бы один транспорт раздачи.');
    if (!allClusters && clusters.length === 0) return toast('error', 'Выберите кластеры или «Все кластеры».');
    setBusy(true);
    try {
      const res = await api.adminOtaStartRollout({
        gateways: allClusters ? null : clusters,
        ifc_mask: mask,
        chips: rollChips.length ? rollChips : null,
      });
      toast('success', `Раскатка сборки ${res.target_build} запущена.`);
      void overview.refetch();
    } catch (e) {
      toast('error', humanError(e));
    } finally {
      setBusy(false);
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

  const section = (title: string, children: React.ReactNode) => (
    <GlassCard style={{ marginBottom: 10 }}>
      <View style={{ padding: 12, gap: 6 }}>
        <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '800' }}>{title}</Text>
        {children}
      </View>
    </GlassCard>
  );
  const small = (text: string) => <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 17 }}>{text}</Text>;

  return (
    <View style={{ marginBottom: 12 }}>
      {section(
        '1. Релиз',
        <>
          {small(
            'Hub собирает текущую прошивку в общем виде для выбранных чипов: образ для узлов и образ для шлюзов. ' +
              'Настройки каждого модуля (тип, пины, LoRa, мощность, Wi‑Fi, владелец) хранятся в его памяти и не меняются.',
          )}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {CHIPS.map((c) => (
              <Check
                key={c}
                label={c}
                value={chips.includes(c)}
                onChange={(v) => setChips((prev) => (v ? [...prev, c] : prev.filter((x) => x !== c)))}
              />
            ))}
          </View>
          <Btn
            title={data?.job?.status === 'running' ? 'Идёт сборка…' : 'Собрать релиз'}
            size="s"
            loading={busy || data?.job?.status === 'running'}
            disabled={!chips.length || data?.job?.status === 'running'}
            onPress={() => void buildRelease()}
          />
          {data?.job ? (
            <Text style={{ color: theme.textDisabled, fontSize: 11 }}>{data.job.log.slice(-4).join('\n')}</Text>
          ) : null}
          {(data?.releases ?? []).slice(0, 8).map((r) => (
            <Text key={`${r.chip}-${r.variant}-${r.build_number}`} style={{ color: theme.textSecondary, fontSize: 11.5 }}>
              {r.chip} · {r.variant ? 'шлюз' : 'узел'} · сборка {r.build_number} · {Math.round(r.full_size / 1024)} КБ
            </Text>
          ))}
        </>,
      )}

      {section(
        '2. Раскатка',
        <>
          {small(
            `Сборка ${latestBuild || '—'}. Шлюз выбранного кластера обновляется сам по Wi‑Fi, затем раздаёт образ модулям; ` +
              'каждый обновившийся модуль раздаёт его соседям. Если модуль после обновления не вернулся в кластер ' +
              'по транспортам, которые работали до обновления (или шлюз не достучался до Hub), он откатывается на прошлую прошивку.',
          )}
          <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700', marginTop: 4 }}>Кластеры</Text>
          <Check label="Все кластеры" value={allClusters} onChange={setAllClusters} />
          {!allClusters
            ? (data?.gateways ?? []).map((g) => (
                <Check
                  key={g.gatewayId}
                  label={`${g.name || 'Шлюз'} · ${g.gatewayId} · модулей: ${g.nodes}`}
                  value={clusters.includes(g.gatewayId)}
                  onChange={(v) =>
                    setClusters((prev) => (v ? [...prev, g.gatewayId] : prev.filter((x) => x !== g.gatewayId)))
                  }
                />
              ))
            : null}
          <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700', marginTop: 4 }}>
            Чипы (ничего не выбрано — все)
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {CHIPS.map((c) => (
              <Check
                key={c}
                label={c}
                value={rollChips.includes(c)}
                onChange={(v) => setRollChips((prev) => (v ? [...prev, c] : prev.filter((x) => x !== c)))}
              />
            ))}
          </View>
          <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700', marginTop: 4 }}>Транспорт раздачи</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            <Check label="ESP-NOW" value={espnow} onChange={setEspnow} />
            <Check label="LoRa (медленно: полный образ — часы)" value={lora} onChange={setLora} />
          </View>
          <Btn title="Запустить раскатку" size="s" loading={busy} disabled={!latestBuild} onPress={() => void start()} />
          {(data?.rollouts ?? []).slice(0, 5).map((r) => (
            <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <StatusBadge text={r.status === 'active' ? 'идёт' : 'остановлена'} tone={r.status === 'active' ? 'accent' : 'neutral'} />
              <Text style={{ color: theme.textSecondary, fontSize: 11.5, flex: 1 }} numberOfLines={2}>
                сборка {r.target_build} · {r.gateways ? `кластеры ${r.gateways.join(', ')}` : 'все кластеры'} ·{' '}
                {r.chips?.length ? `${r.chips.join(', ')} · ` : ''}
                {[(r.ifc_mask & 1) && 'ESP-NOW', (r.ifc_mask & 2) && 'LoRa'].filter(Boolean).join(' + ')}
              </Text>
              {r.status === 'active' ? <Btn title="Стоп" size="s" variant="ghost" onPress={() => void stop(r.id)} /> : null}
            </View>
          ))}
        </>,
      )}

      {section(
        `3. Модули${active ? ` (цель — сборка ${active.target_build})` : ''}`,
        <>
          {(data?.nodes ?? []).length === 0 ? small('Нет модулей, слышанных за 30 минут.') : null}
          {(data?.nodes ?? []).map((n) => {
            const done = active ? n.fwBuild >= active.target_build : false;
            return (
              <View key={n.nodeId} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: done ? theme.success : n.otaState ? theme.accent : theme.textDisabled,
                  }}
                />
                <Text style={{ color: theme.textPrimary, fontSize: 12, flex: 1 }} numberOfLines={1}>
                  {n.name || n.nodeId} · {n.chip} {n.variant ? 'шлюз' : 'узел'} · сборка {n.fwBuild}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 11 }}>
                  {done ? 'обновлён' : OTA_STATE[n.otaState] ?? `сост. ${n.otaState}`}
                </Text>
              </View>
            );
          })}
        </>,
      )}
    </View>
  );
}
