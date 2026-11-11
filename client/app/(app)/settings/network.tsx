/**
 * «Сеть»: сводка по узлам и ёмкости, личные узлы, модули расширения и хранилище.
 * Все значения из реальных запросов useStats / useNodes / useModules / useMe.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '../../../src/theme/useTheme';
import {
  GlassCard,
  SettingsBadge,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../../../src/components/settings/SettingsUI';
import {
  ProgressBar,
  StatusBadge,
  SummaryGrid,
  SummaryTile,
  formatBytes,
  toneForStatus,
} from '../../../src/components/settings/SettingsWidgets';
import { SettingsRowsSkeleton, SummaryTilesSkeleton } from '../../../src/components/skeletons/PageSkeletons';
import { Btn } from '../../../src/components/Btn';
import { useMe, useModules, useNodes, useStats, humanError } from '../../../src/data/queries';

/** Минимальная форма строки узла, которую отдаёт /v1/nodes/mine. */
interface NodeLike {
  id: string;
  name?: string | null;
  status?: string | null;
  free_bytes?: number | null;
  capacity_bytes?: number | null;
}

export default function NetworkScreen() {
  const theme = useTheme();
  const router = useRouter();
  const me = useMe();
  const stats = useStats();
  const nodes = useNodes();
  const modules = useModules();

  const nodeList = ((nodes.data ?? []) as NodeLike[]).filter(Boolean);
  const moduleList = (modules.data ?? []).filter(Boolean);

  const statsData = stats.data;
  const online = statsData?.nodes.online ?? nodeList.filter((n) => n.status === 'online').length;
  const totalNodes = statsData?.nodes.total ?? nodeList.length;
  const capacity = statsData?.capacityBytes ?? 0;
  const stored = statsData?.storedBytes ?? 0;
  const freeNetwork = Math.max(0, capacity - stored);

  const used = me.data?.usedBytes ?? 0;

  const modulesOnline = moduleList.filter((m) => m.status === 'online').length;
  const modulesGateway = moduleList.filter((m) => m.gateway).length;

  const loading = stats.isLoading || nodes.isLoading || modules.isLoading || me.isLoading;
  const anyError = stats.isError && nodes.isError && modules.isError && me.isError;

  return (
    <SettingsPage title="Сеть" subtitle="Узлы хранения, модули и использование">
      {/* ------------------------------------------------------- сводка --- */}
      <SettingsSection title="Сводка сети" delay={0}>
        {loading ? (
          <SummaryGrid>
            <SummaryTilesSkeleton count={4} />
          </SummaryGrid>
        ) : anyError ? (
          <GlassCard>
            <View style={{ padding: 14, gap: 8 }}>
              <Text style={{ color: theme.danger, fontSize: 13 }}>{humanError(stats.error ?? nodes.error)}</Text>
              <Btn
                title="Повторить"
                size="s"
                variant="ghost"
                onPress={() => {
                  void stats.refetch();
                  void nodes.refetch();
                  void modules.refetch();
                }}
              />
            </View>
          </GlassCard>
        ) : (
          <SummaryGrid>
            <SummaryTile
              icon="globe-outline"
              label="Узлы онлайн"
              value={`${online}/${totalNodes}`}
              sub="активны в сети"
              tone="success"
            />
            <SummaryTile
              icon="server-outline"
              label="Ёмкость"
              value={formatBytes(capacity)}
              sub="общая по сети"
              tone="accent"
            />
            <SummaryTile
              icon="cloud-download-outline"
              label="Свободно"
              value={formatBytes(freeNetwork)}
              sub="доступно для хранения"
              tone="warning"
            />
            <SummaryTile
              icon="pie-chart-outline"
              label="Использовано"
              value={formatBytes(used)}
              sub="ваши данные в сети"
              tone="neutral"
            />
          </SummaryGrid>
        )}
      </SettingsSection>

      {/* --------------------------------------------------------- узлы --- */}
      <SettingsSection
        title="Узлы хранения"
        delay={60}
        right={nodes.isLoading ? undefined : <SettingsBadge text={`${nodeList.length}`} tone="accent" />}
      >
        <GlassCard>
          {nodes.isLoading ? (
            <SettingsRowsSkeleton rows={3} />
          ) : nodeList.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 22, gap: 7, paddingHorizontal: 16 }}>
              <Ionicons name="server-outline" size={26} color={theme.textDisabled} />
              <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '600' }}>Узлов пока нет</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5, textAlign: 'center', lineHeight: 18 }}>
                Подключите узел, чтобы увеличить общее место для медиа и сообщений всех пользователей.
              </Text>
            </View>
          ) : (
            nodeList.map((node, index) => {
              const capacityNode = Number(node.capacity_bytes ?? 0);
              const freeNode = Number(node.free_bytes ?? 0);
              const pct = capacityNode > 0 ? ((capacityNode - freeNode) / capacityNode) * 100 : 0;
              const status = node.status ?? 'offline';
              return (
                <View
                  key={node.id}
                  style={[
                    styles.node,
                    index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line } : null,
                  ]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={[styles.nodeIcon, { backgroundColor: theme.accentSoft }]}>
                      <Ionicons name="server-outline" size={17} color={theme.accent} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                        {node.name || 'Узел хранения'}
                      </Text>
                      <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
                        Свободно {formatBytes(freeNode)} · ёмкость {formatBytes(capacityNode)}
                      </Text>
                    </View>
                    <StatusBadge text={status} tone={toneForStatus(status)} />
                  </View>
                  <View style={{ marginTop: 8 }}>
                    <ProgressBar pct={pct} tone={pct > 90 ? 'danger' : pct > 70 ? 'warning' : 'accent'} height={4} />
                  </View>
                </View>
              );
            })
          )}
          <View style={[styles.actions, { borderTopColor: theme.line }]}>
            <Btn title="Управление узлами" size="s" variant="ghost" onPress={() => router.push('/nodes' as never)} />
            <Btn title="Подключить узел" size="s" onPress={() => router.push('/nodes' as never)} />
          </View>
        </GlassCard>
        <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 8, paddingHorizontal: 4 }}>
          Узлы — вклад в общую ёмкость сети, а не личное хранилище: место доступно всем пользователям.
        </Text>
      </SettingsSection>

      {/* ------------------------------------------------------- модули --- */}
      <SettingsSection
        title="Модули расширения"
        delay={120}
        right={modules.isLoading ? undefined : <SettingsBadge text={`${moduleList.length}`} tone="accent" />}
      >
        <GlassCard>
          {modules.isLoading ? (
            <SettingsRowsSkeleton rows={2} />
          ) : moduleList.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 20, gap: 7, paddingHorizontal: 16 }}>
              <Ionicons name="radio-outline" size={24} color={theme.textDisabled} />
              <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }}>Модулей нет</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5, textAlign: 'center', lineHeight: 18 }}>
                ESP32-модули позволяют держать связь без интернета через mesh.
              </Text>
            </View>
          ) : (
            <>
              <SettingsRow
                icon="radio-outline"
                title="Всего модулей"
                subtitle="Подключены к вашему аккаунту"
                right={<Text style={[styles.value, { color: theme.textPrimary }]}>{moduleList.length}</Text>}
              />
              <SettingsRow
                icon="wifi-outline"
                title="Онлайн"
                subtitle="Активны и на связи"
                right={<Text style={[styles.value, { color: theme.success }]}>{modulesOnline}</Text>}
              />
              <SettingsRow
                icon="git-network-outline"
                title="Шлюзы"
                subtitle="Модули с выходом в интернет"
                right={<Text style={[styles.value, { color: theme.accent }]}>{modulesGateway}</Text>}
              />
            </>
          )}
          <View style={[styles.actions, { borderTopColor: theme.line }]}>
            <Btn title="Управление модулями" size="s" variant="ghost" onPress={() => router.push('/modules' as never)} />
          </View>
        </GlassCard>
      </SettingsSection>

      {/* ---------------------------------------------------- хранилище --- */}
      <SettingsSection title="Хранилище" delay={180}>
        <GlassCard>
          <View style={{ padding: 10, gap: 8 }}>
            {me.isLoading ? (
              <SettingsRowsSkeleton rows={2} />
            ) : (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }}>Использовано</Text>
                  <Text style={[styles.value, { color: theme.textPrimary }]}>{formatBytes(used)}</Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }}>Общая ёмкость сети</Text>
                  <Text style={[styles.value, { color: theme.textSecondary }]}>{formatBytes(capacity)}</Text>
                </View>
                <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17 }}>
                  Ваши данные хранятся распределённо и входят в общую ёмкость сети.
                </Text>
              </>
            )}
          </View>
        </GlassCard>
        <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 8, paddingHorizontal: 4 }}>
          Узлы — вклад в общую ёмкость сети. Хранимые объекты зашифрованы и реплицируются между узлами.
        </Text>
      </SettingsSection>

    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  node: { paddingHorizontal: 10, paddingVertical: 10 },
  nodeIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  value: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] as never },
});
