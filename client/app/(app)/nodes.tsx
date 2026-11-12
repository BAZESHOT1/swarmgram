/**
 * Страница «Сеть»: монитор узлов, детальная информация о своих узлах,
 * плавный вывод узла из эксплуатации и FAQ. Модули живут на отдельной
 * странице «Модули».
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import {
  useNodes,
  useNetwork,
  useCreateClaim,
  useDrainNode,
  useModules,
  humanError,
} from '../../src/data/queries';
import { useModuleConnection } from '../../src/modules/ModuleProvider';
import type { ModuleRow } from '../../src/data/api';
import { ModulesNetworkMap } from '../../src/components/modules/ModulesNetworkMap';
import { EmptyState } from '../../src/components/EmptyState';
import { Btn } from '../../src/components/Btn';
import { useTheme } from '../../src/theme/useTheme';
import { motion } from '../../src/theme/motion';
import { useReducedMotion } from '../../src/components/useReducedMotion';
import { useStore } from '../../src/state/useStore';
import { hasNetworkAccess } from '../../src/data/access';
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
  drain_requested_at?: string | null;
  drained_at?: string | null;
};

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

/** Измеряем отклик узла по его /health (CORS открыт на узле). */
async function measureLatency(url: string): Promise<number | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  const started = Date.now();
  try {
    await fetch(`${url.replace(/\/+$/, '')}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    return Date.now() - started;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const FAQ = [
  {
    q: 'Что такое узел сети Kinto?',
    a: 'Узел — добровольный сервер, который хранит зашифрованные реплики медиа и истории. Он не видит содержимое сообщений: ключи остаются на устройствах пользователей.',
  },
  {
    q: 'Нужен ли свой узел, чтобы пользоваться приложением?',
    a: 'Нет. Узлы — это дополнительное общее место для файлов. Мессенджер и модули работают без собственного узла.',
  },
  {
    q: 'Зачем несколько узлов?',
    a: 'Каждый объект хранится в нескольких копиях на разных узлах. Если один узел выключится, данные останутся доступны с других копий.',
  },
  {
    q: 'Как работает плавный вывод узла из эксплуатации?',
    a: 'Сервер перестаёт направлять новые данные на узел, переносит реплики на другие онлайн-узлы, затем удаляет данные с узла и узел автоматически останавливается.',
  },
  {
    q: 'Что будет, если узел отключится внезапно?',
    a: 'Репликатор заметит пропажу и восстановит недостающие копии на живых узлах. Данные не потеряются, пока существует хотя бы одна копия.',
  },
  {
    q: 'Кто может вывести узел?',
    a: 'Только владелец узла. Вывод из эксплуатации необратим: после удаления данных узел нужно подключать и регистрировать заново.',
  },
];

function FaqItem({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={q}
      style={({ pressed }) => ({ opacity: pressed ? 0.9 : 1 })}
    >
      <GlassCard>
        <View style={{ padding: 13, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '700', flex: 1 }}>{q}</Text>
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={theme.textDisabled} />
          </View>
          {open ? (
            <MotiView from={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ type: 'timing', duration: 140 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 19 }}>{a}</Text>
            </MotiView>
          ) : null}
        </View>
      </GlassCard>
    </Pressable>
  );
}

export default function NodesScreen() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const nodes = useNodes();
  const network = useNetwork();
  const modulesQuery = useModules();
  const connection = useModuleConnection();
  const createClaim = useCreateClaim();
  const drainNode = useDrainNode();
  const me = useStore((s) => s.me);

  const [connectOpen, setConnectOpen] = useState(false);
  const [nodeName, setNodeName] = useState('my-swarm-node');
  const [claim, setClaim] = useState<{ claimToken: string; expiresAt: string } | null>(null);
  const [claimError, setClaimError] = useState('');
  const [drainTarget, setDrainTarget] = useState<NodeRow | null>(null);
  const [drainError, setDrainError] = useState('');
  const [faqOpen, setFaqOpen] = useState<number | null>(0);
  const [latency, setLatency] = useState<Record<string, number | null>>({});

  const list = (nodes.data ?? []) as NodeRow[];
  const loading = nodes.isLoading;

  /** Локальная карта: работает от данных подключённого модуля даже без сервера. */
  const cachedModules = (modulesQuery.data ?? []) as ModuleRow[];
  const localFocus: ModuleRow | null = connection.connected && connection.info
    ? cachedModules.find(
        (module) =>
          (module.hardwareId ?? module.board_uuid ?? '').toLowerCase() ===
          String(connection.info?.hardwareId ?? '').toLowerCase(),
      ) ?? ({
        id: `local-${connection.info.hardwareId}`,
        board_uuid: connection.info.hardwareId,
        hardwareId: connection.info.hardwareId,
        publicId: connection.info.publicId,
        role: connection.info.role,
        transport: connection.connection?.kind === 'ble' ? 'ble' : 'usb',
        kind: 'module',
        firmware: connection.info.firmware,
        battery: connection.info.battery,
        gateway: Boolean(connection.info.gateway),
        neighbors: 0,
        status: 'online',
        online: true,
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      } as ModuleRow)
    : null;

  /* Монитор всей сети: онлайн / не отвечают. */
  const networkList = (network.data ?? []) as NetworkNodeRow[];
  const hasNetwork = networkList.length > 0;
  const monitor = hasNetwork ? networkList : list;
  const totalNodes = monitor.length;
  const onlineNodes = monitor.filter((node) => node.status === 'online').length;
  const offlineNodes = totalNodes - onlineNodes;
  const totalCapacity = monitor.reduce((sum, node) => sum + Number(node.capacity_bytes ?? 0), 0);
  const totalFree = monitor.reduce((sum, node) => sum + Number(node.free_bytes ?? 0), 0);
  const contributors = useMemo(
    () =>
      hasNetwork
        ? new Set(networkList.map((node) => node.owner_username).filter(Boolean)).size
        : new Set(list.map((node) => node.id)).size,
    [hasNetwork, networkList, list],
  );
  const statsLoading = loading || network.isLoading;

  /* Отклик узлов измеряем после загрузки списка (не чаще одного раза). */
  useEffect(() => {
    let cancelled = false;
    const online = list.filter((node) => node.status === 'online' && node.public_url);
    if (!online.length) return undefined;
    void (async () => {
      const entries: Record<string, number | null> = {};
      for (const node of online.slice(0, 8)) {
        entries[node.id] = await measureLatency(String(node.public_url));
      }
      if (!cancelled) setLatency((prev) => ({ ...prev, ...entries }));
    })();
    return () => {
      cancelled = true;
    };
  }, [list]);

  const onlineLatencies = Object.values(latency).filter((value): value is number => typeof value === 'number');
  const avgLatency = onlineLatencies.length
    ? Math.round(onlineLatencies.reduce((sum, value) => sum + value, 0) / onlineLatencies.length)
    : null;

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

  const confirmDrain = async () => {
    if (!drainTarget) return;
    setDrainError('');
    try {
      await drainNode.mutateAsync(drainTarget.id);
      useStore.getState().pushToast({ kind: 'success', message: 'Узел выводится из эксплуатации' });
      setDrainTarget(null);
    } catch (error) {
      setDrainError(humanError(error));
    }
  };

  if (!hasNetworkAccess(me)) {
    return (
      <SettingsPage title="Сеть" subtitle="Монитор узлов и общее хранилище сообщества">
        <View style={{ minHeight: 420, justifyContent: 'center' }}>
          <EmptyState
            icon="lock-closed-outline"
            title="Доступ только для PRO"
            subtitle="Раздел «Сеть» доступен на тарифе PRO и выше. Роль PRO выдаётся вручную."
          />
        </View>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage
      title="Сеть"
      subtitle="Монитор узлов и общее хранилище сообщества"
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <HeaderIconButton icon="add-outline" label="Подключить свой узел" onPress={openConnect} />
          <HeaderIconButton
            icon="refresh-outline"
            label="Обновить данные сети"
            onPress={() => {
              void nodes.refetch();
              void network.refetch();
            }}
            disabled={nodes.isFetching || network.isFetching}
          />
        </View>
      }
    >
      {/* ------------------------------------------- локальная mesh-карта ----- */}
      <SettingsSection title="Локальная сеть" delay={0}>
        {localFocus ? (
          <GlassCard>
            <ModulesNetworkMap
              modules={cachedModules.length ? cachedModules : [localFocus]}
              focus={localFocus}
              selectedId={null}
              onSelect={() => undefined}
              expanded
            />
            <Text style={{ color: theme.textDisabled, fontSize: 11, padding: 10 }}>
              Карта построена по данным подключённого модуля и локального кэша. Сервер для неё не нужен.
            </Text>
          </GlassCard>
        ) : (
          <GlassCard>
            <View style={{ padding: 16, alignItems: 'center', gap: 7 }}>
              <Ionicons name="git-network-outline" size={24} color={theme.textDisabled} />
              <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700' }}>Нет подключённого модуля</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5, textAlign: 'center' }}>
                Подключите носимый модуль — карта сети построится локально, даже без интернета.
              </Text>
            </View>
          </GlassCard>
        )}
      </SettingsSection>

      {/* ---------------------------------------------------- монитор ----- */}
      <SettingsSection title="Монитор сети" delay={0}>
        <SummaryGrid>
          {statsLoading ? (
            <SummaryTilesSkeleton count={4} />
          ) : (
            <>
              <SummaryTile
                icon="checkmark-circle-outline"
                label="Онлайн"
                value={String(onlineNodes)}
                sub={totalNodes > 0 ? `из ${totalNodes}` : 'узлов нет'}
                tone="success"
              />
              <SummaryTile
                icon="alert-circle-outline"
                label="Не отвечают"
                value={String(offlineNodes)}
                sub={offlineNodes > 0 ? 'проверьте узлы' : 'все на связи'}
                tone={offlineNodes > 0 ? 'danger' : 'neutral'}
              />
              <SummaryTile icon="server-outline" label="Ёмкость" value={formatBytes(totalCapacity)} tone="accent" />
              <SummaryTile
                icon="speedometer-outline"
                label="Средний отклик"
                value={avgLatency === null ? '—' : `${avgLatency} мс`}
                sub={avgLatency === null ? 'нет замеров' : 'по вашим узлам'}
                tone="warning"
              />
            </>
          )}
        </SummaryGrid>
        <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: 8, lineHeight: 16 }}>
          Свободно в сети: {formatBytes(totalFree)} · вкладчиков: {contributors}. Ёмкость общая для всех пользователей.
        </Text>
      </SettingsSection>

      {/* ------------------------------------------------- мои узлы ----- */}
      <SettingsSection
        title="Мои узлы"
        delay={motion.staggerStepMs}
        right={
          <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
            {loading ? 'загрузка…' : `${list.length} шт.`}
          </Text>
        }
      >
        {loading ? (
          <CardsSkeleton count={3} />
        ) : list.length === 0 ? (
          <EmptyState
            icon="server-outline"
            title="Своего узла пока нет"
            subtitle="Это необязательно: приложение и модули работают без узла. Узел лишь добавляет общее место для медиа."
            actionLabel="Подключить свой узел"
            onAction={openConnect}
          />
        ) : (
          list.map((node, index) => {
            const used = Number(node.used_bytes ?? 0);
            const cap = Number(node.capacity_bytes ?? 0);
            const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
            const tone = pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'accent';
            const draining = node.status === 'draining' || Boolean(node.drain_requested_at);
            const ping = latency[node.id];
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
                  <View style={{ padding: 13, gap: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
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
                        <Ionicons name="server-outline" size={18} color={theme.accent} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '800' }} numberOfLines={1}>
                          {node.name}
                        </Text>
                        <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 2 }} numberOfLines={1}>
                          {me?.username ? `@${me.username}` : 'владелец'} · {node.region || 'регион не указан'}
                          {node.subnet ? ` · subnet ${node.subnet}` : ''}
                        </Text>
                      </View>
                      <StatusBadge text={draining ? 'draining' : node.status} tone={draining ? 'warning' : toneForStatus(node.status)} />
                    </View>

                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      <StatusBadge text={`heartbeat ${formatRelative(node.last_heartbeat_at)}`} tone="neutral" />
                      <StatusBadge text={`отклик ${ping == null ? '—' : `${ping} мс`}`} tone={ping == null ? 'neutral' : ping < 300 ? 'success' : 'warning'} />
                      <StatusBadge text={`репутация ${node.reputation ?? 0}`} tone="neutral" />
                      <StatusBadge text={`кредиты ${Number(node.credits ?? 0).toFixed(1)}`} tone="accent" />
                    </View>

                    {node.public_url ? (
                      <Pressable
                        onPress={() =>
                          void copyToClipboard(String(node.public_url))
                            .then(() => useStore.getState().pushToast({ kind: 'success', message: 'Адрес узла скопирован' }))
                            .catch(() => undefined)
                        }
                        accessibilityRole="button"
                        accessibilityLabel="Скопировать адрес узла"
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                      >
                        <Ionicons name="link-outline" size={13} color={theme.textDisabled} />
                        <Text style={{ color: theme.textDisabled, fontSize: 11, flex: 1 }} numberOfLines={1}>
                          {node.public_url}
                        </Text>
                        <Ionicons name="copy-outline" size={13} color={theme.textSecondary} />
                      </Pressable>
                    ) : null}

                    <View>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}>
                        <Text style={{ color: theme.textSecondary, fontSize: 11.5 }}>
                          занято {formatBytes(used)} из {formatBytes(cap)}
                        </Text>
                        <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontVariant: ['tabular-nums'] as never }}>
                          {pct.toFixed(0)}%
                        </Text>
                      </View>
                      <ProgressBar pct={pct} tone={tone} />
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <Text style={{ color: theme.textDisabled, fontSize: 11 }} numberOfLines={2}>
                        свободно {formatBytes(node.free_bytes)}
                        {node.registered_at ? ` · с ${formatDateTime(node.registered_at)}` : ''}
                      </Text>
                      {node.status === 'online' && !draining ? (
                        <Btn
                          title="Вывести"
                          size="s"
                          variant="ghost"
                          accessibilityLabel={`Плавно вывести узел ${node.name} из эксплуатации`}
                          onPress={() => {
                            setDrainError('');
                            setDrainTarget(node);
                          }}
                        />
                      ) : draining ? (
                        <StatusBadge text="выводится…" tone="warning" />
                      ) : null}
                    </View>

                    {draining ? (
                      <Text style={{ color: theme.warning, fontSize: 11.5, lineHeight: 16 }}>
                        Сервер переносит реплики на другие узлы. После миграции данные будут удалены, узел остановится сам.
                      </Text>
                    ) : null}
                  </View>
                </GlassCard>
              </MotiView>
            );
          })
        )}
      </SettingsSection>

      {/* ---------------------------------------------------- FAQ -------- */}
      <SettingsSection title="Частые вопросы" delay={motion.staggerStepMs * 2}>
        <View style={{ gap: 8 }}>
          {FAQ.map((item, index) => (
            <FaqItem
              key={item.q}
              q={item.q}
              a={item.a}
              open={faqOpen === index}
              onToggle={() => setFaqOpen((current) => (current === index ? null : index))}
            />
          ))}
        </View>
      </SettingsSection>

      {/* -------------------------------------- подключение узла -------- */}
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
                1. Скачайте образ: docker pull kinto/node:1.0.0
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

      {/* -------------------------------------- плавный вывод узла ----- */}
      <SettingsModal
        visible={Boolean(drainTarget)}
        title="Вывести узел из эксплуатации?"
        subtitle="Действие необратимо. Узел нужно будет зарегистрировать заново."
        onClose={() => setDrainTarget(null)}
      >
        <View style={{ gap: 10 }}>
          <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 19 }}>
            Сервер перестанет отправлять новые данные на узел «{drainTarget?.name ?? ''}», перенесёт реплики на другие
            онлайн-узлы, затем удалит данные с узла и остановит его автоматически.
          </Text>
          {drainTarget && monitor.filter((node) => node.id !== drainTarget.id && node.status === 'online').length === 0 ? (
            <Text style={{ color: theme.warning, fontSize: 12, lineHeight: 17 }}>
              Сейчас в сети нет других онлайн-узлов: переносить реплики некуда. Узел перейдёт в draining и завершит вывод,
              когда появится хотя бы один онлайн-узел.
            </Text>
          ) : null}
          {drainError ? <Text style={{ color: theme.danger, fontSize: 12 }}>{drainError}</Text> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Btn title="Отмена" size="s" variant="ghost" onPress={() => setDrainTarget(null)} />
            </View>
            <View style={{ flex: 1 }}>
              <Btn
                title="Вывести узел"
                size="s"
                loading={drainNode.isPending}
                onPress={() => void confirmDrain()}
              />
            </View>
          </View>
        </View>
      </SettingsModal>
    </SettingsPage>
  );
}
