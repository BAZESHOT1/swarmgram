/**
 * Админ-панель: модерация аккаунтов, узлов, модулей, чатов и жалоб.
 * Сохранены прежние API-вызовы и права; интерфейс приведён к стеклянному стилю.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as api from '../../src/data/api';
import type { AdminChatRef, AdminReport } from '../../src/data/api';
import { EmptyState } from '../../src/components/EmptyState';
import { Btn } from '../../src/components/Btn';
import { useTheme } from '../../src/theme/useTheme';
import {
  humanError,
  useAdminChatView,
  useAdminDeleteMessage,
  useAdminReports,
  useAdminUserChats,
  useResolveReport,
  useWarnUser,
} from '../../src/data/queries';
import { useStore } from '../../src/state/useStore';
import { GlassCard, SettingsPage, SettingsSection } from '../../src/components/settings/SettingsUI';
import {
  formatBytes,
  formatDateTime,
  formatRelative,
  HeaderIconButton,
  ProgressBar,
  SettingsConfirm,
  SettingsInput,
  SettingsModal,
  StatusBadge,
  SummaryGrid,
  SummaryTile,
  toneForStatus,
  type BadgeTone,
} from '../../src/components/settings/SettingsWidgets';
import { downloadObject, decryptPayload } from '../../src/data/chatkit';
import { fromB64, toB64 } from '../../src/crypto/core';
import { ModuleDebugPanel } from '../../src/components/admin/ModuleDebugPanel';

type Tab = 'users' | 'nodes' | 'modules' | 'chats' | 'reports' | 'debug';

type PendingAction = {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  run: () => Promise<void>;
};

const TABS: { id: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: 'users', label: 'Аккаунты', icon: 'people-outline' },
  { id: 'nodes', label: 'Узлы', icon: 'server-outline' },
  { id: 'modules', label: 'Модули', icon: 'hardware-chip-outline' },
  { id: 'chats', label: 'Чаты', icon: 'chatbubbles-outline' },
  { id: 'reports', label: 'Жалобы', icon: 'flag-outline' },
  { id: 'debug', label: 'Отладка', icon: 'terminal-outline' },
];

function userStatusLabel(status: string): string {
  if (status === 'active') return 'активен';
  if (status === 'suspended') return 'заблокирован';
  return status;
}

function chatIcon(type: string): string {
  return type === 'channel' ? '📢' : type === 'group' ? '👥' : '💬';
}

export default function AdminScreen() {
  const theme = useTheme();
  const qc = useQueryClient();
  const meRole = useStore((s) => s.me?.role);
  const isAdmin = meRole === 'admin';

  const [tab, setTab] = useState<Tab>('users');
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  const users = useQuery({
    queryKey: ['admin', 'users', search],
    queryFn: () => api.api.adminUsers(search),
    enabled: isAdmin && tab === 'users',
  });
  const nodes = useQuery({
    queryKey: ['admin', 'nodes'],
    queryFn: () => api.api.adminNodes(),
    enabled: isAdmin && tab === 'nodes',
  });
  const modules = useQuery({
    queryKey: ['admin', 'modules'],
    queryFn: () => api.api.adminModules(),
    enabled: isAdmin && tab === 'modules',
  });
  const chats = useQuery({
    queryKey: ['admin', 'chats'],
    queryFn: () => api.api.adminChats(),
    enabled: isAdmin && tab === 'chats',
  });

  const refresh = () => void qc.invalidateQueries();

  const requireReason = (): boolean => {
    if (reason.trim()) return true;
    setErr('Укажите причину действия — она попадёт в журнал модерации.');
    return false;
  };

  const runPending = async () => {
    if (!pending) return;
    setBusy(true);
    setErr('');
    try {
      await pending.run();
    } catch (error) {
      setErr(humanError(error));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  /* --------------------------------------------------------------- аккаунты -- */

  const requestUserStatus = (user: { id: string; username: string; status: string }) => {
    const suspending = user.status === 'active';
    if (suspending && !requireReason()) return;
    setPending({
      title: suspending ? 'Заблокировать аккаунт?' : 'Разблокировать аккаунт?',
      message: suspending
        ? `@${user.username} потеряет доступ, активные сессии будут отозваны. Причина: ${reason.trim()}`
        : `@${user.username} снова сможет войти и пользоваться аккаунтом.`,
      confirmLabel: suspending ? 'Заблокировать' : 'Разблокировать',
      danger: suspending,
      run: async () => {
        await api.api.adminUserStatus(user.id, suspending ? 'suspended' : 'active', reason.trim());
        refresh();
      },
    });
  };

  /* ------------------------------------------------------------------ узлы -- */

  const requestNodeBlock = (node: { id: string; name: string; status: string }) => {
    const blocked = node.status === 'banned';
    if (!blocked && !requireReason()) return;
    setPending({
      title: blocked ? 'Разблокировать узел?' : 'Заблокировать узел?',
      message: blocked
        ? `Узел «${node.name}» снова сможет принимать реплики.`
        : `Узел «${node.name}» перестанет обслуживать объекты. Причина: ${reason.trim()}`,
      confirmLabel: blocked ? 'Разблокировать' : 'Заблокировать',
      danger: !blocked,
      run: async () => {
        if (blocked) await api.api.adminNodeUnblock(node.id, reason.trim() || undefined);
        else await api.api.adminNodeBlock(node.id, reason.trim());
        refresh();
      },
    });
  };

  /* ---------------------------------------------------------------- модули -- */

  const requestModuleBlock = (module: { id: string; board_uuid: string; blocked_reason: string | null }) => {
    const blocked = Boolean(module.blocked_reason);
    if (!blocked && !requireReason()) return;
    setPending({
      title: blocked ? 'Разблокировать модуль?' : 'Заблокировать модуль?',
      message: blocked
        ? `Модуль UUID ${module.board_uuid.slice(0, 12)}… снова сможет выходить на связь.`
        : `Модуль UUID ${module.board_uuid.slice(0, 12)}… перестанет принимать конверты. Причина: ${reason.trim()}`,
      confirmLabel: blocked ? 'Разблокировать' : 'Заблокировать',
      danger: !blocked,
      run: async () => {
        if (blocked) await api.api.adminModuleUnblock(module.id, reason.trim() || undefined);
        else await api.api.adminModuleBlock(module.id, reason.trim());
        refresh();
      },
    });
  };

  /* ------------------------------------------------------------------ чаты -- */

  const requestChatBlock = (chat: { id: string; title: string; type: string; blocked_reason: string | null }) => {
    const blocked = Boolean(chat.blocked_reason);
    if (!blocked && !requireReason()) return;
    const title = chat.title || chat.type;
    setPending({
      title: blocked ? 'Разблокировать чат?' : 'Заблокировать чат?',
      message: blocked
        ? `«${title}» снова станет доступен участникам.`
        : `«${title}» будет скрыт, отправка сообщений остановится. Причина: ${reason.trim()}`,
      confirmLabel: blocked ? 'Разблокировать' : 'Заблокировать',
      danger: !blocked,
      run: async () => {
        if (blocked) await api.api.adminChatUnblock(chat.id);
        else await api.api.adminChatBlock(chat.id, reason.trim());
        refresh();
      },
    });
  };

  if (!isAdmin) {
    return (
      <SettingsPage title="Админ-панель" subtitle="Модерация аккаунтов, узлов, модулей, чатов и жалоб">
        <View style={{ minHeight: 420, justifyContent: 'center' }}>
          <EmptyState
            icon="shield-outline"
            title="Доступ только для администратора"
            subtitle="Раздел админ-панели ограничен ролью аккаунта."
          />
        </View>
      </SettingsPage>
    );
  }

  const loading =
    (tab === 'users' && users.isLoading) ||
    (tab === 'nodes' && nodes.isLoading) ||
    (tab === 'modules' && modules.isLoading) ||
    (tab === 'chats' && chats.isLoading);

  const count =
    tab === 'users'
      ? (users.data ?? []).length
      : tab === 'nodes'
        ? (nodes.data ?? []).length
        : tab === 'modules'
          ? (modules.data ?? []).length
          : (chats.data ?? []).length;

  const tabTitle = TABS.find((item) => item.id === tab)?.label ?? 'Раздел';

  return (
    <SettingsPage
      title="Админ-панель"
      subtitle="Модерация аккаунтов, узлов, модулей, чатов и жалоб"
      right={<HeaderIconButton icon="refresh-outline" label="Обновить данные" onPress={refresh} />}
    >
      <SettingsSection title="Сводка">
        <SummaryGrid>
          <SummaryTile
            icon="people-outline"
            label="Аккаунты"
            value={users.data ? String(users.data.length) : '—'}
            sub={tab === 'users' ? 'в текущем поиске' : 'откройте вкладку'}
            tone="accent"
          />
          <SummaryTile
            icon="server-outline"
            label="Узлы"
            value={nodes.data ? String(nodes.data.length) : '—'}
            sub="в сети и заблокированные"
            tone="warning"
          />
          <SummaryTile
            icon="hardware-chip-outline"
            label="Модули"
            value={modules.data ? String(modules.data.length) : '—'}
            sub="все привязанные"
            tone="success"
          />
        </SummaryGrid>
      </SettingsSection>

      {/* Сегмент-табы */}
      <View
        style={{
          flexDirection: 'row',
          gap: 4,
          padding: 4,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: theme.glassBorder,
          backgroundColor: theme.glass,
          marginBottom: 12,
        }}
      >
        {TABS.map((item) => {
          const active = tab === item.id;
          return (
            <Pressable
              key={item.id}
              onPress={() => {
                setTab(item.id);
                setErr('');
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Вкладка ${item.label}`}
              style={({ pressed }) => ({
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                gap: 2,
                paddingVertical: 7,
                borderRadius: 12,
                backgroundColor: active ? theme.accentSoft : pressed ? theme.surfacePressed : 'transparent',
              })}
            >
              <Ionicons name={item.icon} size={15} color={active ? theme.accent : theme.textSecondary} />
              <Text
                style={{ color: active ? theme.accent : theme.textSecondary, fontSize: 10.5, fontWeight: '700' }}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {err ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 8,
            padding: 10,
            marginBottom: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.danger,
            backgroundColor: theme.dangerSoft,
          }}
        >
          <Ionicons name="alert-circle-outline" size={17} color={theme.danger} style={{ marginTop: 1 }} />
          <Text style={{ flex: 1, color: theme.danger, fontSize: 12.5, lineHeight: 18 }}>{err}</Text>
          <Pressable onPress={() => setErr('')} accessibilityRole="button" accessibilityLabel="Скрыть ошибку" hitSlop={8}>
            <Ionicons name="close" size={16} color={theme.danger} />
          </Pressable>
        </View>
      ) : null}

      <SettingsSection title="Причина действия">
        <GlassCard>
          <View style={{ padding: 10 }}>
            <SettingsInput
              value={reason}
              onChangeText={(value) => {
                setReason(value);
                if (err) setErr('');
              }}
              placeholder="Например: спам, нарушение правил"
              accessibilityLabel="Причина действия"
              maxLength={300}
              style={{ marginBottom: 4 }}
            />
            <Text style={{ color: theme.textDisabled, fontSize: 11.5, paddingHorizontal: 2 }}>
              Обязательна для блокировки. Для разблокировки можно оставить пустой.
            </Text>
          </View>
        </GlassCard>
      </SettingsSection>

      {tab === 'users' ? (
        <SettingsSection
          title="Аккаунты"
          right={
            <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
              {loading ? 'загрузка…' : `${count} найдено`}
            </Text>
          }
        >
          <SettingsInput
            value={search}
            onChangeText={setSearch}
            placeholder="Поиск по email, username или имени"
            accessibilityLabel="Поиск аккаунтов"
            autoCapitalize="none"
            maxLength={64}
          />
          {loading ? (
            <GlassCard><View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Загрузка аккаунтов…</Text></View></GlassCard>
          ) : count === 0 ? (
            <GlassCard><View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Аккаунты не найдены.</Text></View></GlassCard>
          ) : (
            (users.data ?? []).map((user) => {
              const used = Number(user.used_bytes ?? 0);
              const quota = Number(user.quota_bytes ?? 0);
              const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
              const blocked = user.status !== 'active';
              return (
                <GlassCard key={user.id} style={{ marginBottom: 8 }}>
                  <View style={{ padding: 12, gap: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                      <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.accentSoft }}>
                        <Ionicons name="person-outline" size={17} color={theme.accent} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }} numberOfLines={1}>
                          @{user.username}
                        </Text>
                        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                          {user.email}
                        </Text>
                      </View>
                      <StatusBadge text={userStatusLabel(user.status)} tone={blocked ? 'danger' : 'success'} />
                    </View>

                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      <StatusBadge text={user.role} tone={user.role === 'admin' ? 'accent' : 'neutral'} />
                      <StatusBadge text={user.plan} tone={user.plan === 'pro' ? 'accent' : 'neutral'} />
                      <StatusBadge text={`с ${formatRelative(user.created_at)}`} tone="neutral" />
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontVariant: ['tabular-nums'] as never }}>
                        Хранилище {formatBytes(used)} из {formatBytes(quota)}
                      </Text>
                      <Text style={{ color: theme.textPrimary, fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] as never }}>
                        {quota > 0 ? `${Math.round(pct)}%` : '—'}
                      </Text>
                    </View>
                    <ProgressBar pct={pct} tone={pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'accent'} />

                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                      <Btn
                        title={blocked ? 'Разблокировать' : 'Заблокировать'}
                        size="s"
                        variant={blocked ? 'ghost' : 'danger'}
                        onPress={() => requestUserStatus(user)}
                      />
                    </View>
                  </View>
                </GlassCard>
              );
            })
          )}
        </SettingsSection>
      ) : null}

      {tab === 'nodes' ? (
        <SettingsSection
          title="Узлы"
          right={<Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>{loading ? 'загрузка…' : `${count} шт.`}</Text>}
        >
          {loading ? (
            <GlassCard><View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Загрузка узлов…</Text></View></GlassCard>
          ) : count === 0 ? (
            <GlassCard><View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Узлов нет.</Text></View></GlassCard>
          ) : (
            (nodes.data ?? []).map((node) => {
              const used = Number(node.used_bytes ?? 0);
              const cap = Number(node.capacity_bytes ?? 0);
              const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
              const blocked = node.status === 'banned';
              return (
                <GlassCard key={node.id} style={{ marginBottom: 8 }}>
                  <View style={{ padding: 12, gap: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                      <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.warningSoft }}>
                        <Ionicons name="server-outline" size={17} color={theme.warning} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }} numberOfLines={1}>
                          {node.name}
                        </Text>
                        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                          @{node.owner_username ?? '—'} · {node.region || 'регион не указан'}
                        </Text>
                      </View>
                      <StatusBadge text={node.status} tone={toneForStatus(node.status)} />
                    </View>

                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      <StatusBadge text={`subnet ${node.subnet || '—'}`} tone="neutral" />
                      <StatusBadge text={`IP ${node.last_ip || '—'}`} tone="neutral" />
                      <StatusBadge text={`репутация ${node.reputation ?? 0}`} tone={Number(node.reputation ?? 0) >= 0 ? 'accent' : 'danger'} />
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontVariant: ['tabular-nums'] as never }}>
                        Занято {formatBytes(used)} из {formatBytes(cap)}
                      </Text>
                      <Text style={{ color: theme.textPrimary, fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] as never }}>
                        {cap > 0 ? `${Math.round(pct)}%` : '—'}
                      </Text>
                    </View>
                    <ProgressBar pct={pct} tone={pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'accent'} />

                    <Text style={{ color: theme.textDisabled, fontSize: 11.5 }} numberOfLines={2}>
                      HW {node.hw_hash ? `${node.hw_hash.slice(0, 10)}…` : '—'} · heartbeat {formatRelative(node.last_heartbeat_at)}
                      {node.blocked_reason ? ` · причина: ${node.blocked_reason}` : ''}
                    </Text>

                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                      <Btn
                        title={blocked ? 'Разблокировать' : 'Заблокировать'}
                        size="s"
                        variant={blocked ? 'ghost' : 'danger'}
                        onPress={() => requestNodeBlock(node)}
                      />
                    </View>
                  </View>
                </GlassCard>
              );
            })
          )}
        </SettingsSection>
      ) : null}

      {tab === 'modules' ? (
        <SettingsSection
          title="Модули"
          right={<Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>{loading ? 'загрузка…' : `${count} шт.`}</Text>}
        >
          {loading ? (
            <GlassCard><View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Загрузка модулей…</Text></View></GlassCard>
          ) : count === 0 ? (
            <GlassCard><View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Модулей нет.</Text></View></GlassCard>
          ) : (
            (modules.data ?? []).map((module) => {
              const battery = Math.max(0, Math.min(100, Number(module.battery ?? 0)));
              const blocked = Boolean(module.blocked_reason);
              return (
                <GlassCard key={module.id} style={{ marginBottom: 8 }}>
                  <View style={{ padding: 12, gap: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                      <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.successSoft }}>
                        <Ionicons name="hardware-chip-outline" size={17} color={theme.success} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }} numberOfLines={1}>
                          {module.board_uuid.slice(0, 12)}… · {module.module_type}
                        </Text>
                        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                          @{module.owner_username} · {module.kind} · прошивка {module.firmware || '—'}
                        </Text>
                      </View>
                      <StatusBadge text={blocked ? 'blocked' : module.status} tone={blocked ? 'danger' : toneForStatus(module.status)} />
                    </View>

                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      <StatusBadge text={module.is_public ? 'публичный' : 'личный'} tone={module.is_public ? 'accent' : 'neutral'} />
                      <StatusBadge text={module.gateway ? 'шлюз есть' : 'без шлюза'} tone={module.gateway ? 'success' : 'neutral'} />
                      <StatusBadge text={`соседей ${module.neighbors}`} tone={module.neighbors > 0 ? 'accent' : 'neutral'} />
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <Text style={{ color: theme.textSecondary, fontSize: 11.5 }}>Заряд</Text>
                      <Text style={{ color: theme.textPrimary, fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] as never }}>
                        {battery}%
                      </Text>
                    </View>
                    <ProgressBar pct={battery} tone={battery <= 20 ? 'danger' : battery <= 50 ? 'warning' : 'success'} />

                    <Text style={{ color: theme.textDisabled, fontSize: 11.5 }} numberOfLines={2}>
                      Последняя связь {formatRelative(module.last_seen_at)}
                      {module.blocked_reason ? ` · причина: ${module.blocked_reason}` : ''}
                    </Text>

                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                      <Btn
                        title={blocked ? 'Разблокировать' : 'Заблокировать'}
                        size="s"
                        variant={blocked ? 'ghost' : 'danger'}
                        onPress={() => requestModuleBlock(module)}
                      />
                    </View>
                  </View>
                </GlassCard>
              );
            })
          )}
        </SettingsSection>
      ) : null}

      {tab === 'chats' ? (
        <SettingsSection
          title="Чаты"
          right={<Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>{loading ? 'загрузка…' : `${count} шт.`}</Text>}
        >
          {loading ? (
            <GlassCard><View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Загрузка чатов…</Text></View></GlassCard>
          ) : count === 0 ? (
            <GlassCard><View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Чатов нет.</Text></View></GlassCard>
          ) : (
            (chats.data ?? []).map((chat) => {
              const blocked = Boolean(chat.blocked_reason);
              return (
                <GlassCard key={chat.id} style={{ marginBottom: 8 }}>
                  <View style={{ padding: 12, gap: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                      <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.accentSoft }}>
                        <Text style={{ fontSize: 17 }}>{chatIcon(chat.type)}</Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }} numberOfLines={1}>
                          {chat.title || chat.type}
                        </Text>
                        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                          @{chat.owner_username ?? '—'} · участников {chat.members} · сообщений {chat.messages}
                        </Text>
                      </View>
                      <StatusBadge text={blocked ? 'blocked' : 'active'} tone={blocked ? 'danger' : 'success'} />
                    </View>

                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      <StatusBadge text={chat.type} tone="neutral" />
                      <StatusBadge text={chat.is_public ? 'публичный' : 'приватный'} tone={chat.is_public ? 'accent' : 'neutral'} />
                    </View>

                    {chat.blocked_reason ? (
                      <Text style={{ color: theme.danger, fontSize: 11.5 }} numberOfLines={2}>
                        Причина: {chat.blocked_reason}
                      </Text>
                    ) : null}

                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                      <Btn
                        title={blocked ? 'Разблокировать' : 'Заблокировать'}
                        size="s"
                        variant={blocked ? 'ghost' : 'danger'}
                        onPress={() => requestChatBlock(chat)}
                      />
                    </View>
                  </View>
                </GlassCard>
              );
            })
          )}
        </SettingsSection>
      ) : null}

      {tab === 'reports' ? <ReportsTab /> : null}

      {tab === 'debug' ? <ModuleDebugPanel /> : null}

      <Text style={{ color: theme.textDisabled, fontSize: 11.5, paddingHorizontal: 4, marginBottom: 4 }}>
        {tabTitle}: действия применяются сразу и записываются в журнал модерации.
      </Text>

      <SettingsConfirm
        visible={pending !== null}
        title={pending?.title ?? ''}
        message={pending?.message ?? ''}
        confirmLabel={pending?.confirmLabel ?? 'Подтвердить'}
        danger={pending?.danger}
        loading={busy}
        onClose={() => {
          if (!busy) setPending(null);
        }}
        onConfirm={() => void runPending()}
      />
    </SettingsPage>
  );
}

/* --------------------------------------------------------------- жалобы --- */

type ConfirmAction = {
  title: string;
  message: string;
  label: string;
  danger: boolean;
  run: () => Promise<void>;
};

function reportStatusLabel(status: string): string {
  if (status === 'resolved') return 'решена';
  if (status === 'dismissed') return 'отклонена';
  return 'открыта';
}

function reportStatusTone(status: string): BadgeTone {
  if (status === 'resolved') return 'success';
  if (status === 'dismissed') return 'neutral';
  return 'warning';
}

function ErrorBanner({ text }: { text: string }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 8,
        padding: 10,
        marginBottom: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.danger,
        backgroundColor: theme.dangerSoft,
      }}
    >
      <Ionicons name="alert-circle-outline" size={17} color={theme.danger} style={{ marginTop: 1 }} />
      <Text style={{ flex: 1, color: theme.danger, fontSize: 12.5, lineHeight: 18 }}>{text}</Text>
    </View>
  );
}

function ToastBanner({ text }: { text: string }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: 10,
        marginBottom: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.success,
        backgroundColor: theme.successSoft,
      }}
    >
      <Ionicons name="checkmark-circle-outline" size={17} color={theme.success} />
      <Text style={{ flex: 1, color: theme.success, fontSize: 12.5, lineHeight: 18 }}>{text}</Text>
    </View>
  );
}

function ReportsTab() {
  const theme = useTheme();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const reports = useAdminReports(filter);
  const [active, setActive] = useState<AdminReport | null>(null);
  const [chatRef, setChatRef] = useState<AdminChatRef | null>(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const list = reports.data ?? [];

  return (
    <View>
      <ToastBanner text={toast} />

      <SettingsSection
        title="Жалобы"
        right={
          <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>
            {reports.isLoading ? 'загрузка…' : `${list.length} шт.`}
          </Text>
        }
      >
        <View
          style={{
            flexDirection: 'row',
            gap: 4,
            padding: 4,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: theme.glassBorder,
            backgroundColor: theme.glass,
            marginBottom: 10,
          }}
        >
          {([
            { id: 'open' as const, label: 'Открытые' },
            { id: 'all' as const, label: 'Все' },
          ]).map((item) => {
            const selected = filter === item.id;
            return (
              <Pressable
                key={item.id}
                onPress={() => setFilter(item.id)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`Фильтр жалоб: ${item.label}`}
                style={({ pressed }) => ({
                  flex: 1,
                  alignItems: 'center',
                  paddingVertical: 7,
                  borderRadius: 10,
                  backgroundColor: selected ? theme.accentSoft : pressed ? theme.surfacePressed : 'transparent',
                })}
              >
                <Text style={{ color: selected ? theme.accent : theme.textSecondary, fontSize: 12, fontWeight: '700' }}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <ErrorBanner text={reports.error ? humanError(reports.error) : ''} />

        {reports.isLoading ? (
          <GlassCard><View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Загрузка жалоб…</Text></View></GlassCard>
        ) : list.length === 0 ? (
          <GlassCard><View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Жалоб нет.</Text></View></GlassCard>
        ) : (
          list.map((report) => (
            <GlassCard key={report.id} style={{ marginBottom: 8 }}>
              <View style={{ padding: 12, gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
                  <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.warningSoft }}>
                    <Ionicons name="flag-outline" size={17} color={theme.warning} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }} numberOfLines={2}>
                      {report.reason}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                      {report.reporter.displayName || report.reporter.username} → {report.target.displayName || report.target.username}
                    </Text>
                  </View>
                  <StatusBadge text={reportStatusLabel(report.status)} tone={reportStatusTone(report.status)} />
                </View>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <StatusBadge text={`@${report.reporter.username}`} tone="neutral" />
                  <StatusBadge text={`@${report.target.username}`} tone="accent" />
                  <StatusBadge text={`чатов ${report.chatsCount}`} tone="neutral" />
                  <StatusBadge text={formatDateTime(report.createdAt)} tone="neutral" />
                </View>

                {report.note ? (
                  <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17 }} numberOfLines={3}>
                    {report.note}
                  </Text>
                ) : null}

                <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                  <Btn title="Разобрать" size="s" variant="primary" onPress={() => setActive(report)} />
                </View>
              </View>
            </GlassCard>
          ))
        )}
      </SettingsSection>

      <ReportModal
        report={active}
        onClose={() => setActive(null)}
        onToast={setToast}
        onOpenChat={setChatRef}
      />
      <AdminChatViewModal
        chat={chatRef}
        onClose={() => setChatRef(null)}
        onToast={setToast}
      />
    </View>
  );
}

function ReportModal({
  report,
  onClose,
  onToast,
  onOpenChat,
}: {
  report: AdminReport | null;
  onClose: () => void;
  onToast: (text: string) => void;
  onOpenChat: (chat: AdminChatRef) => void;
}) {
  const theme = useTheme();
  const qc = useQueryClient();
  const chats = useAdminUserChats(report?.target.userId ?? null);
  const resolveReport = useResolveReport();
  const warnUser = useWarnUser();

  const [note, setNote] = useState('');
  const [targetStatus, setTargetStatus] = useState('active');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [warnVisible, setWarnVisible] = useState(false);
  const [warnNote, setWarnNote] = useState('');

  useEffect(() => {
    setNote('');
    setErr('');
    setTargetStatus(report?.target.status ?? 'active');
    setWarnVisible(false);
    setWarnNote('');
    setConfirm(null);
  }, [report?.id, report?.target.status]);

  const target = report?.target;
  const blocked = targetStatus !== 'active';
  const chatList = chats.data ?? [];

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    setErr('');
    try {
      await confirm.run();
    } catch (error) {
      setErr(humanError(error));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const requestBlock = () => {
    if (!report || !target) return;
    setConfirm({
      title: blocked ? 'Разблокировать пользователя?' : 'Заблокировать пользователя?',
      message: blocked
        ? `@${target.username} снова сможет пользоваться аккаунтом.`
        : `@${target.username} потеряет доступ, активные сессии будут отозваны.`,
      label: blocked ? 'Разблокировать' : 'Заблокировать',
      danger: !blocked,
      run: async () => {
        await api.api.adminUserStatus(target.userId, blocked ? 'active' : 'banned', note.trim() || report.reason);
        setTargetStatus(blocked ? 'active' : 'suspended');
        await qc.invalidateQueries({ queryKey: ['admin', 'reports'] });
        onToast(blocked ? 'Пользователь разблокирован' : 'Пользователь заблокирован');
      },
    });
  };

  const requestResolve = (status: 'open' | 'resolved' | 'dismissed') => {
    if (!report) return;
    const title = status === 'resolved' ? 'Отметить жалобу решённой?' : status === 'dismissed' ? 'Отклонить жалобу?' : 'Вернуть жалобу в работу?';
    const label = status === 'resolved' ? 'Решена' : status === 'dismissed' ? 'Отклонить' : 'Вернуть';
    setConfirm({
      title,
      message: note.trim()
        ? `Комментарий к решению: ${note.trim()}`
        : 'Комментарий к решению не указан — его можно добавить в поле выше.',
      label,
      danger: status === 'dismissed',
      run: async () => {
        await resolveReport.mutateAsync({ id: report.id, status, note: note.trim() || undefined });
        onToast('Статус жалобы обновлён');
        onClose();
      },
    });
  };

  const requestWarn = async () => {
    if (!report || !target) return;
    setBusy(true);
    setErr('');
    try {
      await warnUser.mutateAsync({ userId: target.userId, note: warnNote.trim() });
      setWarnVisible(false);
      setWarnNote('');
      onToast('Предупреждение отправлено');
    } catch (error) {
      setErr(humanError(error));
    } finally {
      setBusy(false);
    }
  };

  const requestDeleteChat = (chat: AdminChatRef) => {
    if (!report) return;
    setConfirm({
      title: 'Удалить чат?',
      message: `Чат «${chat.title || chat.type}» и все его сообщения будут удалены без возможности восстановления.`,
      label: 'Удалить чат',
      danger: true,
      run: async () => {
        await api.api.adminChatDelete(chat.id, note.trim() || report.reason);
        await qc.invalidateQueries({ queryKey: ['admin'] });
        onToast('Чат удалён');
      },
    });
  };

  return (
    <>
      <SettingsModal
        visible={Boolean(report)}
        title="Разбор жалобы"
        subtitle={report ? `Жалоба #${report.id} · ${formatDateTime(report.createdAt)}` : undefined}
        onClose={onClose}
        maxWidth={560}
      >
        {report && target ? (
          <ScrollView style={{ maxHeight: 540 }} showsVerticalScrollIndicator={false}>
            <ErrorBanner text={err} />

            <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>
              ЖАЛОБА
            </Text>
            <GlassCard style={{ marginBottom: 14 }}>
              <View style={{ padding: 12, gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                  <Text style={{ flex: 1, color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }}>{report.reason}</Text>
                  <StatusBadge text={reportStatusLabel(report.status)} tone={reportStatusTone(report.status)} />
                </View>
                {report.note ? (
                  <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 }}>{report.note}</Text>
                ) : (
                  <Text style={{ color: theme.textDisabled, fontSize: 12 }}>Комментарий к жалобе не указан.</Text>
                )}
                <Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>
                  {formatDateTime(report.createdAt)} · {report.reporter.displayName || report.reporter.username} (@{report.reporter.username})
                  {report.resolvedAt ? ` · решена ${formatDateTime(report.resolvedAt)}` : ''}
                </Text>
                {report.resolutionNote ? (
                  <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Решение: {report.resolutionNote}</Text>
                ) : null}
              </View>
            </GlassCard>

            <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>
              НАРУШИТЕЛЬ
            </Text>
            <GlassCard style={{ marginBottom: 14 }}>
              <View style={{ padding: 12, gap: 9 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                  <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.dangerSoft }}>
                    <Ionicons name="person-outline" size={17} color={theme.danger} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '700' }} numberOfLines={1}>
                      {target.displayName || target.username}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                      @{target.username}
                    </Text>
                  </View>
                  <StatusBadge text={blocked ? 'заблокирован' : 'активен'} tone={blocked ? 'danger' : 'success'} />
                </View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                  <Btn
                    title="Профиль"
                    size="s"
                    variant="ghost"
                    onPress={() => router.push(`/user/${encodeURIComponent(target.username)}` as never)}
                  />
                  <Btn
                    title={blocked ? 'Разблокировать' : 'Заблокировать'}
                    size="s"
                    variant={blocked ? 'ghost' : 'danger'}
                    onPress={requestBlock}
                  />
                  <Btn title="Предупреждение" size="s" variant="ghost" onPress={() => setWarnVisible(true)} />
                </View>
              </View>
            </GlassCard>

            <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>
              ЧАТЫ НАРУШИТЕЛЯ
            </Text>
            <ErrorBanner text={chats.error ? humanError(chats.error) : ''} />
            {chats.isLoading ? (
              <GlassCard style={{ marginBottom: 14 }}>
                <View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Загрузка чатов…</Text></View>
              </GlassCard>
            ) : chatList.length === 0 ? (
              <GlassCard style={{ marginBottom: 14 }}>
                <View style={{ padding: 14 }}><Text style={{ color: theme.textSecondary, fontSize: 13 }}>Пользователь не состоит в чатах.</Text></View>
              </GlassCard>
            ) : (
              chatList.map((chat) => (
                <GlassCard key={chat.id} style={{ marginBottom: 8 }}>
                  <View style={{ padding: 12, gap: 8 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                      <View style={{ width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.accentSoft }}>
                        <Text style={{ fontSize: 16 }}>{chatIcon(chat.type)}</Text>
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '700' }} numberOfLines={1}>
                          {chat.title || chat.type}
                        </Text>
                        <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
                          участников {chat.membersCount} · сообщений {chat.lastSeq}
                        </Text>
                      </View>
                      <StatusBadge text={chat.encryption === 'e2e' ? 'E2E' : 'server'} tone={chat.encryption === 'e2e' ? 'warning' : 'accent'} />
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
                      <Btn title="Переписка" size="s" variant="ghost" onPress={() => onOpenChat(chat)} />
                      <Btn title="Удалить чат" size="s" variant="danger" onPress={() => requestDeleteChat(chat)} />
                    </View>
                  </View>
                </GlassCard>
              ))
            )}

            <View style={{ marginTop: 12 }}>
              <SettingsInput
                label="Комментарий модератора"
                value={note}
                onChangeText={setNote}
                placeholder="Причина решения, что сделано с нарушителем"
                accessibilityLabel="Комментарий к решению по жалобе"
                maxLength={500}
              />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Btn title="Отметить решённой" size="s" variant="primary" onPress={() => requestResolve('resolved')} />
                <Btn title="Отклонить" size="s" variant="ghost" onPress={() => requestResolve('dismissed')} />
                <Btn title="Вернуть в работу" size="s" variant="ghost" onPress={() => requestResolve('open')} />
              </View>
            </View>
          </ScrollView>
        ) : null}
      </SettingsModal>

      <SettingsModal
        visible={warnVisible}
        title="Предупреждение"
        subtitle={target ? `@${target.username} получит запись в журнале предупреждений.` : undefined}
        onClose={() => {
          if (!busy) setWarnVisible(false);
        }}
        maxWidth={400}
      >
        <ErrorBanner text={err} />
        <SettingsInput
          label="Текст предупреждения"
          value={warnNote}
          onChangeText={setWarnNote}
          placeholder="Например: прекратите спам в чатах"
          accessibilityLabel="Текст предупреждения"
          maxLength={500}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <Btn title="Отмена" size="s" variant="ghost" onPress={() => setWarnVisible(false)} />
          <Btn title="Отправить" size="s" variant="primary" loading={busy} onPress={() => void requestWarn()} />
        </View>
      </SettingsModal>

      <SettingsConfirm
        visible={confirm !== null}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.label ?? 'Подтвердить'}
        danger={confirm?.danger}
        loading={busy}
        onClose={() => {
          if (!busy) setConfirm(null);
        }}
        onConfirm={() => void runConfirm()}
      />
    </>
  );
}

function AdminChatViewModal({
  chat,
  onClose,
  onToast,
}: {
  chat: AdminChatRef | null;
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const theme = useTheme();
  const view = useAdminChatView(chat?.id ?? null);
  const deleteMessage = useAdminDeleteMessage();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [decrypting, setDecrypting] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);

  useEffect(() => {
    setTexts({});
    setErr('');
    setConfirm(null);
    const data = view.data;
    if (!chat || !data) {
      setDecrypting(false);
      return;
    }
    if (data.chat.encryption !== 'server' || !data.key) {
      setDecrypting(false);
      return;
    }

    let cancelled = false;
    const key = fromB64(data.key.key);
    setDecrypting(true);
    void (async () => {
      const map: Record<string, string> = {};
      for (const message of data.messages) {
        if (!message.objectId) {
          map[message.id] = '';
          continue;
        }
        try {
          const bytes = await downloadObject(message.objectId);
          if (!bytes) {
            map[message.id] = '';
            continue;
          }
          const payload = await decryptPayload(key, toB64(bytes), message.nonce);
          map[message.id] = payload
            ? (payload.text ?? (payload.file ? `📎 ${payload.file.name}` : ''))
            : '';
        } catch {
          map[message.id] = '';
        }
      }
      if (!cancelled) {
        setTexts(map);
        setDecrypting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chat?.id, view.data]);

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    setErr('');
    try {
      await confirm.run();
    } catch (error) {
      setErr(humanError(error));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const requestDelete = (message: { id: string; seq: number }) => {
    if (!chat) return;
    setConfirm({
      title: 'Удалить сообщение?',
      message: `Сообщение #${message.seq} будет удалено из чата у всех участников.`,
      label: 'Удалить',
      danger: true,
      run: async () => {
        await deleteMessage.mutateAsync({ chatId: chat.id, messageId: message.id });
        onToast('Сообщение удалено');
      },
    });
  };

  const data = view.data;
  const isE2e = data?.chat.encryption === 'e2e';
  const messages = data?.messages ?? [];

  return (
    <>
      <SettingsModal
        visible={Boolean(chat)}
        title={chat?.title || 'Переписка'}
        subtitle={chat ? (chat.encryption === 'e2e' ? 'Секретный чат · только метаданные' : 'Серверный чат · расшифровка на клиенте') : undefined}
        onClose={onClose}
        maxWidth={600}
      >
        <ScrollView style={{ maxHeight: 560 }} showsVerticalScrollIndicator={false}>
          <ErrorBanner text={err} />
          <ErrorBanner text={view.error ? humanError(view.error) : ''} />

          {view.isLoading ? (
            <Text style={{ color: theme.textSecondary, fontSize: 13, paddingVertical: 10 }}>Загрузка переписки…</Text>
          ) : null}

          {isE2e ? (
            <View
              style={{
                padding: 11,
                marginBottom: 10,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: theme.warning,
                backgroundColor: theme.warningSoft,
              }}
            >
              <Text style={{ color: theme.warning, fontSize: 12.5, lineHeight: 18, fontWeight: '600' }}>
                Секретный чат — содержимое зашифровано на устройствах. Доступны только метаданные.
              </Text>
            </View>
          ) : null}

          {data && data.chat.encryption === 'server' && !data.key ? (
            <Text style={{ color: theme.textDisabled, fontSize: 12, marginBottom: 8 }}>
              Ключ серверного чата ещё не создан — текст сообщений недоступен.
            </Text>
          ) : null}

          {data && data.chat.encryption === 'server' && data.key ? (
            <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginBottom: 8 }}>
              Ключ сервера v{data.key.version} · расшифровка выполняется на этом устройстве
              {decrypting ? ' · идёт расшифровка…' : ''}
            </Text>
          ) : null}

          {messages.length === 0 && !view.isLoading ? (
            <Text style={{ color: theme.textSecondary, fontSize: 13, paddingVertical: 8 }}>Сообщений нет.</Text>
          ) : null}

          {messages.map((message) => {
            const text = texts[message.id];
            return (
              <View
                key={message.id}
                style={{
                  paddingVertical: 9,
                  borderBottomWidth: 1,
                  borderBottomColor: theme.line,
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700' }} numberOfLines={1}>
                    @{message.senderUsername}
                  </Text>
                  <Text style={{ color: theme.textDisabled, fontSize: 11, fontVariant: ['tabular-nums'] as never }}>
                    #{message.seq} · {formatDateTime(message.createdAt)}
                  </Text>
                </View>
                {isE2e ? (
                  <Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>Тип: {message.kind} · зашифровано</Text>
                ) : (
                  <Text style={{ color: text ? theme.textPrimary : theme.textDisabled, fontSize: 13, lineHeight: 19 }}>
                    {decrypting && text === undefined ? 'Расшифровка…' : text || (message.objectId ? 'Не удалось расшифровать' : 'Без текста')}
                  </Text>
                )}
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                  <Btn title="Удалить сообщение" size="s" variant="danger" onPress={() => requestDelete(message)} />
                </View>
              </View>
            );
          })}
        </ScrollView>
      </SettingsModal>

      <SettingsConfirm
        visible={confirm !== null}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.label ?? 'Удалить'}
        danger={confirm?.danger}
        loading={busy}
        onClose={() => {
          if (!busy) setConfirm(null);
        }}
        onConfirm={() => void runConfirm()}
      />
    </>
  );
}
