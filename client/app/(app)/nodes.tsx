/**
 * Страница «Сеть»: в центре — модули SwarmGram (mesh-связь, роли, заряд),
 * а вклад в общее хранилище вынесен ниже как необязательная возможность.
 */
import React, { useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useRouter } from 'expo-router';
import {
  useModules,
  useNodes,
  useNetwork,
  useCreateClaim,
  useNodeStatus,
  humanError,
} from '../../src/data/queries';
import type { ModuleRow } from '../../src/data/api';
import { EmptyState } from '../../src/components/EmptyState';
import { Btn } from '../../src/components/Btn';
import { useTheme } from '../../src/theme/useTheme';
import { motion } from '../../src/theme/motion';
import { useReducedMotion } from '../../src/components/useReducedMotion';
import { useStore } from '../../src/state/useStore';
import { GlassCard, SettingsPage, SettingsSection } from '../../src/components/settings/SettingsUI';
import { CardsSkeleton, SummaryTilesSkeleton } from '../../src/components/skeletons/PageSkeletons';
import {
  formatBytes,
  formatDateTime,
  formatRelative,
  HeaderIconButton,
  ProgressBar,
  SettingsInput,
  SettingsModal,
  StatusBadge,
  SummaryGrid,
  SummaryTile,
  toneForStatus,
} from '../../src/components/settings/SettingsWidgets';

type NodeRow = {
  id: string;
  name: string;
  status: string;
  region?: string | null;
  subnet?: string | null;
  public_url?: string | null;
  reputation?: number | null;
  capacity_bytes?: number | null;
  used_bytes?: number | null;
  free_bytes?: number | null;
  last_heartbeat_at?: string | null;
  registered_at?: string | null;
  credits?: number | null;
};

type NetworkNodeRow = {
  id: string;
  status: string;
  capacity_bytes?: number | null;
  free_bytes?: number | null;
  owner_username?: string | null;
};

const ROLE_META: Record<string, { label: string; icon: keyof typeof Ionicons.glyphMap }> = {
  gateway: { label: 'Шлюз', icon: 'wifi-outline' },
  repeater: { label: 'Репитер', icon: 'radio-outline' },
  wearable: { label: 'Носимый', icon: 'watch-outline' },
};

const TRANSPORT_LABEL: Record<string, string> = {
  wifi: 'Wi-Fi',
  lora: 'LoRa',
  ble: 'Bluetooth',
  usb: 'USB',
};

function moduleName(module: ModuleRow): string {
  if (module.publicId) return `Модуль ${module.publicId}`;
  const hw = module.hardwareId ?? module.board_uuid ?? module.id;
  return `Модуль ${hw.slice(-6)}`;
}

async function copyToClipboard(value: string): Promise<void> {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const { Clipboard } = await import('react-native');
  Clipboard.setString(value);
}

export default function NodesScreen() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const router = useRouter();
  const modulesQuery = useModules();
  const nodes = useNodes();
  const network = useNetwork();
  const createClaim = useCreateClaim();
  const setStatus = useNodeStatus();
  const me = useStore((s) => s.me);

  const [connectOpen, setConnectOpen] = useState(false);
  const [nodeName, setNodeName] = useState('my-swarm-node');
  const [claim, setClaim] = useState<{ claimToken: string; expiresAt: string } | null>(null);
  const [claimError, setClaimError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  /* ---------------------------------------------------------- модули --- */
  const modules = (modulesQuery.data ?? []) as ModuleRow[];
  const realModules = modules.filter((module) => !module.shadow);
  const total = realModules.length;
  const online = realModules.filter((module) => module.online === true && !module.blocked).length;
  const gateways = realModules.filter((module) => (module.role ?? 'gateway') === 'gateway').length;
  const repeaters = realModules.filter((module) => module.role === 'repeater').length;
  const wearables = realModules.filter((module) => module.role === 'wearable').length;
  const batteries = realModules
    .filter((module) => module.online === true && Number(module.battery) > 0)
    .map((module) => Number(module.battery));
  const avgBattery = batteries.length
    ? Math.round(batteries.reduce((sum, value) => sum + value, 0) / batteries.length)
    : null;
  const transports = [...new Set(realModules.map((module) => module.transport).filter(Boolean))] as string[];
  const modulesLoading = modulesQuery.isLoading;

  const refreshAll = () => {
    void modulesQuery.refetch();
    void nodes.refetch();
    void network.refetch();
  };

  /* ---------------------------------------------------------- узлы ----- */
  const list = (nodes.data ?? []) as NodeRow[];
  const myNodes = list.length;
  const capacity = list.reduce((sum, node) => sum + Number(node.capacity_bytes ?? 0), 0);
  const free = list.reduce((sum, node) => sum + Number(node.free_bytes ?? 0), 0);
  const loading = nodes.isLoading;

  const networkList = (network.data ?? []) as NetworkNodeRow[];
  const hasNetwork = networkList.length > 0;
  const statsLoading = loading || network.isLoading;
  const networkCapacity = networkList.reduce((sum, node) => sum + Number(node.capacity_bytes ?? 0), 0);
  const networkFree = networkList.reduce((sum, node) => sum + Number(node.free_bytes ?? 0), 0);
  const networkOnline = networkList.filter((node) => node.status === 'online').length;
  const contributors = hasNetwork
    ? new Set(networkList.map((node) => node.owner_username).filter(Boolean)).size
    : new Set(list.map((node) => node.id)).size;

  const totalCapacity = hasNetwork ? networkCapacity : capacity;
  const totalFree = hasNetwork ? networkFree : free;
  const totalOnline = hasNetwork ? networkOnline : list.filter((node) => node.status === 'online').length;
  const totalNodes = hasNetwork ? networkList.length : myNodes;

  const openConnect = () => {
    setClaim(null);
    setClaimError('');
    setConnectOpen(true);
  };

  const createToken = async () => {
    const name = nodeName.trim();
    if (name.length < 2) {
      setClaimError('Название узла должно быть не короче 2 символов.');
      return;
    }
    setClaimError('');
    try {
      const next = await createClaim.mutateAsync(name);
      setClaim(next);
    } catch (error) {
      setClaimError(humanError(error));
    }
  };

  const toggleStatus = async (node: NodeRow) => {
    setBusyId(node.id);
    try {
      await setStatus.mutateAsync({ id: node.id, status: node.status === 'draining' ? 'online' : 'draining' });
      await nodes.refetch();
    } catch {
      /* ошибка мутации показывается тостом в глобальном обработчике */
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SettingsPage
      title="Сеть"
      subtitle="Модули, mesh-связь и общий вклад сообщества"
      right={<HeaderIconButton icon="refresh-outline" label="Обновить данные сети" onPress={refreshAll} disabled={modulesQuery.isFetching || nodes.isFetching} />}
    >
      {/* ---------------------------------------------------- hero ----- */}
      <MotiView
        from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10 }}
        animate={{ opacity: 1, translateY: 0 }}
        transition={reduced ? { type: 'timing', duration: 0 } : { type: 'timing', duration: 220 }}
      >
        <GlassCard>
          <View style={{ padding: 16, gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 16,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.accentSoft,
                }}
              >
                <Ionicons name="git-network" size={26} color={theme.accent} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 18, fontWeight: '800' }}>
                  {total > 0 ? `${online} из ${total} модулей на связи` : 'Swarm-сеть'}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 3 }}>
                  Модули держат mesh-связь и доставляют сообщения даже без интернета.
                </Text>
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 140 }}>
                <Btn title="Добавить модуль" size="s" onPress={() => router.push('/modules' as never)} />
              </View>
              <View style={{ flex: 1, minWidth: 140 }}>
                <Btn title="Прошить модуль" size="s" variant="ghost" onPress={() => router.push('/firmware' as never)} />
              </View>
            </View>
          </View>
        </GlassCard>
      </MotiView>

      <View style={{ height: 14 }} />

      {/* ------------------------------------------------- сводка ----- */}
      <SettingsSection title="Состояние сети" delay={0}>
        <SummaryGrid>
          {modulesLoading ? (
            <SummaryTilesSkeleton count={4} />
          ) : (
            <>
              <SummaryTile
                icon="hardware-chip-outline"
                label="Модулей"
                value={String(total)}
                sub={total > 0 ? `${online} онлайн` : 'пока нет'}
                tone="accent"
              />
              <SummaryTile
                icon="git-branch-outline"
                label="Роли"
                value={`${gateways} / ${repeaters}`}
                sub={`шлюзы / репитеры${wearables ? ` · ${wearables} носимых` : ''}`}
                tone="success"
              />
              <SummaryTile
                icon="wifi-outline"
                label="Транспорт"
                value={transports.length ? transports.map((t) => TRANSPORT_LABEL[t] ?? t).join(', ') : '—'}
                sub="активные каналы"
                tone="warning"
              />
              <SummaryTile
                icon="battery-half-outline"
                label="Средний заряд"
                value={avgBattery === null ? '—' : `${avgBattery}%`}
                sub={avgBattery === null ? 'нет данных' : 'онлайн-модули'}
                tone={avgBattery !== null && avgBattery < 20 ? 'danger' : 'accent'}
              />
            </>
          )}
        </SummaryGrid>
      </SettingsSection>

      {/* ------------------------------------------------- модули ----- */}
      <SettingsSection
        title="Ваши модули"
        delay={motion.staggerStepMs}
        right={
          <Pressable onPress={() => router.push('/modules' as never)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Открыть все модули">
            <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }}>Все модули</Text>
          </Pressable>
        }
      >
        {modulesLoading ? (
          <CardsSkeleton count={3} />
        ) : total === 0 ? (
          <EmptyState
            icon="hardware-chip-outline"
            title="Модулей пока нет"
            subtitle="Подключите модуль по Bluetooth или USB — он появится здесь и в mesh-сети."
            actionLabel="Подключить модуль"
            onAction={() => router.push('/modules' as never)}
          />
        ) : (
          realModules.slice(0, 6).map((module, index) => {
            const role = ROLE_META[module.role ?? 'gateway'] ?? ROLE_META.gateway;
            const isOnline = module.online === true && !module.blocked;
            const battery = Number(module.battery);
            const batteryTone = battery >= 50 ? 'success' : battery >= 20 ? 'warning' : 'danger';
            return (
              <MotiView
                key={module.id}
                from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.99 }}
                animate={{ opacity: 1, translateY: 0, scale: 1 }}
                transition={
                  reduced
                    ? { type: 'timing', duration: 0 }
                    : { ...motion.spring, delay: Math.min(index, 5) * motion.staggerStepMs }
                }
                style={{ marginBottom: 8 }}
              >
                <Pressable
                  onPress={() => router.push('/modules' as never)}
                  accessibilityRole="button"
                  accessibilityLabel={`Открыть ${moduleName(module)}`}
                  style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
                >
                  <GlassCard>
                    <View style={{ padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <View
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: 12,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: isOnline ? theme.accentSoft : theme.surfacePressed,
                        }}
                      >
                        <Ionicons name={role.icon} size={19} color={isOnline ? theme.accent : theme.textDisabled} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }} numberOfLines={1}>
                          {moduleName(module)}
                        </Text>
                        <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 2 }} numberOfLines={1}>
                          {role.label}
                          {module.transport ? ` · ${TRANSPORT_LABEL[module.transport] ?? module.transport}` : ''}
                          {` · ${formatRelative(module.lastSeenAt ?? module.last_seen_at)}`}
                        </Text>
                        {battery > 0 ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                            <View style={{ flex: 1 }}>
                              <ProgressBar pct={Math.min(100, battery)} tone={batteryTone} />
                            </View>
                            <Text style={{ color: theme.textDisabled, fontSize: 10.5, fontVariant: ['tabular-nums'] as never }}>
                              {battery}%
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 6 }}>
                        <StatusBadge
                          text={module.blocked ? 'blocked' : isOnline ? 'online' : 'offline'}
                          tone={module.blocked ? 'danger' : isOnline ? 'success' : 'neutral'}
                        />
                        <Ionicons name="chevron-forward" size={16} color={theme.textDisabled} />
                      </View>
                    </View>
                  </GlassCard>
                </Pressable>
              </MotiView>
            );
          })
        )}
      </SettingsSection>

      {/* -------------------------------------- вклад сообщества ----- */}
      <SettingsSection title="Хранилище сообщества" delay={motion.staggerStepMs * 2}>
        <View
          style={{
            flexDirection: 'row',
            gap: 8,
            alignItems: 'flex-start',
            padding: 11,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: theme.glassBorder,
            backgroundColor: theme.glass,
            marginBottom: 12,
          }}
        >
          <Ionicons name="information-circle-outline" size={17} color={theme.textSecondary} />
          <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18, flex: 1 }}>
            Это необязательно. Модули уже обеспечивают mesh-связь; узлы лишь добавляют общее место для медиа и истории.
          </Text>
        </View>

        <SummaryGrid>
          {statsLoading ? (
            <SummaryTilesSkeleton count={4} />
          ) : (
            <>
              <SummaryTile icon="server-outline" label="Общая ёмкость" value={formatBytes(totalCapacity)} tone="accent" />
              <SummaryTile
                icon="cloud-download-outline"
                label="Свободно"
                value={formatBytes(totalFree)}
                sub="доступно в сети"
                tone="success"
              />
              <SummaryTile
                icon="pulse-outline"
                label="Узлов онлайн"
                value={String(totalOnline)}
                sub={totalNodes > 0 ? `из ${totalNodes}` : 'нет подключений'}
                tone="warning"
              />
              <SummaryTile
                icon="people-outline"
                label="Вкладчиков"
                value={String(contributors)}
                sub="уникальных владельцев"
                tone="accent"
              />
            </>
          )}
        </SummaryGrid>
      </SettingsSection>

      <SettingsSection
        title="Ваши узлы"
        delay={motion.staggerStepMs * 3}
        right={
          <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
            {loading ? 'загрузка…' : `${myNodes} шт.`}
          </Text>
        }
      >
        {loading ? (
          <CardsSkeleton count={3} />
        ) : myNodes === 0 ? (
          <EmptyState
            icon="server-outline"
            title="Свой узел не обязателен"
            subtitle="Можно пользоваться модулями без собственного узла. Если хотите помочь общим хранилищем — создайте токен привязки."
            actionLabel="Подключить свой узел"
            onAction={openConnect}
          />
        ) : (
          list.map((node, index) => {
            const used = Number(node.used_bytes ?? 0);
            const cap = Number(node.capacity_bytes ?? 0);
            const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
            const tone = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'accent';
            const region = node.region || 'регион не указан';
            const subnet = node.subnet ? ` · subnet ${node.subnet}` : '';
            return (
              <MotiView
                key={node.id}
                from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 12, scale: 0.99 }}
                animate={{ opacity: 1, translateY: 0, scale: 1 }}
                transition={
                  reduced
                    ? { type: 'timing', duration: 0 }
                    : { ...motion.spring, delay: Math.min(index, 6) * motion.staggerStepMs }
                }
                style={{ marginBottom: 8 }}
              >
                <GlassCard>
                  <View style={{ padding: 12, gap: 9 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                      <View
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: 10,
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: theme.accentSoft,
                        }}
                      >
                        <Ionicons name="server-outline" size={17} color={theme.accent} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }} numberOfLines={1}>
                          {node.name}
                        </Text>
                        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={2}>
                          {me?.username ? `@${me.username}` : 'владелец'} · {region}
                          {subnet}
                        </Text>
                      </View>
                      <StatusBadge text={node.status} tone={toneForStatus(node.status)} />
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <StatusBadge text="Ваш вклад" tone="accent" />
                      <Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>
                        в сети с {node.registered_at ? formatDateTime(node.registered_at) : '—'}
                      </Text>
                    </View>

                    <Text style={{ color: theme.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] as never }}>
                      Свободно {formatBytes(node.free_bytes)} · ёмкость {formatBytes(cap)}
                    </Text>
                    <ProgressBar pct={pct} tone={tone} />

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <Text style={{ color: theme.textDisabled, fontSize: 11.5, flex: 1 }} numberOfLines={2}>
                        Репутация {node.reputation ?? 0} · активность {formatRelative(node.last_heartbeat_at)}
                      </Text>
                      <Btn
                        title={node.status === 'draining' ? 'Возобновить' : 'Остановить'}
                        size="s"
                        variant="ghost"
                        loading={busyId === node.id}
                        disabled={busyId !== null && busyId !== node.id}
                        onPress={() => void toggleStatus(node)}
                      />
                    </View>
                  </View>
                </GlassCard>
              </MotiView>
            );
          })
        )}
      </SettingsSection>

      <Btn title="Подключить свой узел" variant="ghost" onPress={openConnect} accessibilityLabel="Подключить свой узел" />

      <SettingsModal
        visible={connectOpen}
        title={claim ? 'Токен привязки' : 'Подключить свой узел'}
        subtitle={
          claim
            ? 'Вставьте токен в конфигурацию узла и запустите контейнер. Токен действует 30 минут.'
            : 'Необязательный шаг: узел добавляет общее место для медиа, но не нужен для работы модулей.'
        }
        onClose={() => setConnectOpen(false)}
      >
        {claim ? (
          <View style={{ gap: 10 }}>
            <View style={{ backgroundColor: theme.successSoft, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: theme.glassBorder }}>
              <Text selectable style={{ color: theme.success, fontWeight: '800', fontSize: 14, letterSpacing: 0.3 }}>
                {claim.claimToken}
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 6 }}>
                Действует до {formatDateTime(claim.expiresAt)}
              </Text>
            </View>
            <View style={{ gap: 6 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18 }}>
                1. Скачайте образ: docker pull swarmgram/node:1.0.0
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18 }}>
                2. В .env укажите MAIN_SERVER_URL, OWNER_USERNAME, NODE_CLAIM_TOKEN и NODE_CAPACITY_GB.
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18 }}>
                3. Запустите: docker compose -f docker-compose.node.yml up -d
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Btn
                  title="Скопировать токен"
                  size="s"
                  variant="ghost"
                  onPress={() =>
                    void copyToClipboard(claim.claimToken)
                      .then(() => useStore.getState().pushToast({ kind: 'success', message: 'Токен скопирован' }))
                      .catch(() => undefined)
                  }
                />
              </View>
              <View style={{ flex: 1 }}>
                <Btn title="Готово" size="s" onPress={() => setConnectOpen(false)} />
              </View>
            </View>
          </View>
        ) : (
          <View>
            <SettingsInput
              label="Имя узла"
              value={nodeName}
              onChangeText={(value) => {
                setNodeName(value);
                if (claimError) setClaimError('');
              }}
              placeholder="my-swarm-node"
              accessibilityLabel="Имя узла"
              maxLength={64}
              autoCapitalize="none"
            />
            {claimError ? <Text style={{ color: theme.danger, fontSize: 12, marginBottom: 8 }}>{claimError}</Text> : null}
            <Btn title="Создать токен" size="s" loading={createClaim.isPending} onPress={() => void createToken()} />
            <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: 8, lineHeight: 16 }}>
              Узлу нужен Docker и доступ к Hub. После запуска он появится в списке и начнёт принимать общие реплики.
            </Text>
          </View>
        )}
      </SettingsModal>
    </SettingsPage>
  );
}
