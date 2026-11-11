/**
 * Подраздел «Блокировки»: бан участника по username с причиной и сроком,
 * список активных банов и разблокировка.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { Avatar } from '../Avatar';
import { Btn } from '../Btn';
import { SettingsInput } from '../settings/SettingsWidgets';
import { useStore } from '../../state/useStore';
import { ManageBadge, ManageChoice, ManageEmpty, ManageSection } from './ManageUI';
import { manageActions, manageError, useChatBansSafe } from './ManageData';
import { formatWhen, type ManageChat } from './ManageTypes';

const DURATION_OPTIONS = [
  { value: '0', label: 'Навсегда', hint: 'Разблокировать можно вручную' },
  { value: '24', label: '1 день', hint: 'Бан снимется автоматически' },
  { value: '168', label: '7 дней', hint: 'Бан снимется автоматически' },
  { value: '720', label: '30 дней', hint: 'Бан снимется автоматически' },
];

export function ManageBans({
  chat,
  onChanged,
}: {
  chat: ManageChat;
  onChanged: () => Promise<void> | void;
}) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const bans = useChatBansSafe(chat.id);
  const [username, setUsername] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [duration, setDuration] = React.useState('0');
  const [busy, setBusy] = React.useState(false);
  const [unbanBusy, setUnbanBusy] = React.useState('');

  async function ban() {
    const name = username.trim().replace(/^@/, '').toLowerCase();
    if (!name || busy) return;
    const member = (chat.members ?? []).find((m) => m.username.toLowerCase() === name);
    if (!member) {
      pushToast({ kind: 'error', message: 'Пользователь не найден среди участников чата' });
      return;
    }
    if (member.role === 'owner') {
      pushToast({ kind: 'error', message: 'Нельзя заблокировать владельца чата' });
      return;
    }
    setBusy(true);
    try {
      await manageActions.banMember(chat.id, member.userId, {
        reason: reason.trim(),
        durationHours: duration === '0' ? null : Number(duration),
      });
      pushToast({ kind: 'success', message: `@${name} заблокирован(а)` });
      setUsername('');
      setReason('');
      setDuration('0');
      await bans.refetch();
      await onChanged();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function unban(userId: string, name: string) {
    if (unbanBusy) return;
    setUnbanBusy(userId);
    try {
      await manageActions.unbanMember(chat.id, userId);
      pushToast({ kind: 'success', message: `@${name} разблокирован(а)` });
      await bans.refetch();
      await onChanged();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setUnbanBusy('');
    }
  }

  return (
    <>
      <ManageSection
        icon="ban-outline"
        title="Заблокировать участника"
        subtitle="Заблокированный не сможет писать и вступать, пока бан активен."
      >
        <SettingsInput
          label="Username участника"
          value={username}
          onChangeText={(text) => setUsername(text.replace(/^@/, ''))}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          placeholder="username"
          accessibilityLabel="Username для блокировки"
        />
        <SettingsInput
          label="Причина (необязательно)"
          value={reason}
          onChangeText={setReason}
          editable={!busy}
          maxLength={200}
          placeholder="Например, спам"
          accessibilityLabel="Причина блокировки"
        />
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>Срок</Text>
        <ManageChoice options={DURATION_OPTIONS} value={duration} onChange={setDuration} compact disabled={busy} />
        <View style={{ marginTop: 10 }}>
          <Btn title="Заблокировать" variant="danger" loading={busy} disabled={!username.trim()} onPress={() => void ban()} />
        </View>
      </ManageSection>

      <ManageSection
        icon="shield-half-outline"
        title="Активные блокировки"
        right={<ManageBadge text={String(bans.data.length)} tone={bans.data.length ? 'danger' : 'neutral'} />}
      >
        {bans.error ? <Text style={{ color: theme.danger, fontSize: 12, marginBottom: 8 }}>{bans.error}</Text> : null}
        {bans.data.length === 0 ? (
          <ManageEmpty icon="checkmark-circle-outline" text={bans.loading ? 'Загружаем блокировки…' : 'Активных блокировок нет.'} />
        ) : (
          <View style={{ gap: 8 }}>
            {bans.data.map((item) => (
              <View
                key={item.userId || item.username}
                style={{ borderWidth: 1, borderColor: theme.line, backgroundColor: theme.surface, borderRadius: 12, padding: 10 }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
                  <Avatar name={item.displayName || item.username || '?'} size={34} hasModule={false} hasNode={false} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '600' }} numberOfLines={1}>
                      {item.displayName || item.username}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 11 }} numberOfLines={1}>
                      @{item.username} · {item.until ? `до ${formatWhen(item.until)}` : 'навсегда'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void unban(item.userId, item.username)}
                    disabled={unbanBusy === item.userId}
                    accessibilityRole="button"
                    accessibilityLabel={`Разблокировать @${item.username}`}
                    style={({ pressed }) => [
                      styles.unban,
                      { borderColor: theme.success, backgroundColor: theme.successSoft, opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <Ionicons name="lock-open-outline" size={13} color={theme.success} />
                    <Text style={{ color: theme.success, fontSize: 11.5, fontWeight: '700' }}>
                      {unbanBusy === item.userId ? '…' : 'Разблокировать'}
                    </Text>
                  </Pressable>
                </View>
                {item.reason ? (
                  <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 6, lineHeight: 15 }}>
                    Причина: {item.reason}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        )}
      </ManageSection>
    </>
  );
}

const styles = {
  unban: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
};
