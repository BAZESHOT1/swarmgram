/**
 * Страница «Вклад в сеть»: общая ёмкость сети, список своих узлов
 * и привязка нового узла через одноразовый токен (createClaim).
 * Узел — добровольный вклад в общее место для медиа и сообщений, а не личное хранилище.
 */
import React, { useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useNodes, useNetwork, useCreateClaim, useNodeStatus, humanError } from '../../src/data/queries';
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

/** Публичная запись узла из GET /v1/nodes. */
type NetworkNodeRow = {
  id: string;
  status: string;
  capacity_bytes?: number | null;
  free_bytes?: number | null;
  owner_username?: string | null;
};

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

  const list = (nodes.data ?? []) as NodeRow[];
  const total = list.length;
  const online = list.filter((node) => node.status === 'online').length;
  const capacity = list.reduce((sum, node) => sum + Number(node.capacity_bytes ?? 0), 0);
  const free = list.reduce((sum, node) => sum + Number(node.free_bytes ?? 0), 0);
  const loading = nodes.isLoading;

  /* Сводка по всей сети: если публичный список ещё пуст — считаем по своим узлам. */
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
  const totalOnline = hasNetwork ? networkOnline : online;
  const totalNodes = hasNetwork ? networkList.length : total;

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
      title="Вклад в сеть"
      subtitle="Узлы увеличивают общее место для медиа и сообщений всех пользователей"
      right={<HeaderIconButton icon="refresh-outline" label="Обновить список узлов" onPress={() => void nodes.refetch()} disabled={nodes.isFetching} />}
    >
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
          marginBottom: 16,
        }}
      >
        <Ionicons name="heart-outline" size={17} color={theme.accent} />
        <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18, flex: 1 }}>
          Это вклад в развитие SwarmGram, а не личное хранилище. Ваш узел расширяет общее пространство для всех.
        </Text>
      </View>

      <SettingsSection title="Общая сеть" delay={0}>
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
        delay={motion.staggerStepMs}
        right={
          <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
            {loading ? 'загрузка…' : `${total} шт.`}
          </Text>
        }
      >
        {loading ? (
          <CardsSkeleton count={4} />
        ) : total === 0 ? (
          <View style={{ minHeight: 300, justifyContent: 'center' }}>
            <EmptyState
              icon="server-outline"
              title="Вы ещё не в сети"
              subtitle="Разверните узел docker-образом и привяжите его токеном — он увеличит общее место для всех."
              actionLabel="Стать участником сети"
              onAction={openConnect}
            />
          </View>
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

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <Text style={{ color: theme.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] as never }}>
                        Свободно {formatBytes(node.free_bytes)} · ёмкость {formatBytes(cap)}
                      </Text>
                    </View>
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

      <Btn title="Стать участником сети" onPress={openConnect} accessibilityLabel="Стать участником сети" />

      <SettingsModal
        visible={connectOpen}
        title={claim ? 'Токен привязки' : 'Стать участником сети'}
        subtitle={
          claim
            ? 'Вставьте токен в конфигурацию узла и запустите контейнер. Токен действует 30 минут.'
            : 'Разверните узел Docker-образом и привяжите его одноразовым токеном — он увеличит общее место для всех.'
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
