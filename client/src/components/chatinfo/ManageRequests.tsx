/**
 * Подраздел «Заявки»: входящие заявки на вступление с ролью из заявки.
 * Принять/отклонить — с понятными тостами и обновлением списка.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { Avatar } from '../Avatar';
import { EmptyState } from '../EmptyState';
import { useStore } from '../../state/useStore';
import { ManageBadge, ManageEmpty, ManageSection } from './ManageUI';
import { manageActions, manageError, useJoinRequestsSafe } from './ManageData';
import { ROLE_LABEL, formatWhen } from './ManageTypes';

export function ManageRequests({
  chatId,
  onChanged,
}: {
  chatId: string;
  onChanged: () => Promise<void> | void;
}) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const requests = useJoinRequestsSafe(chatId);
  const [busy, setBusy] = React.useState('');

  async function decide(item: { userId: string; username: string }, approve: boolean) {
    if (busy) return;
    setBusy(item.userId);
    try {
      if (approve) await manageActions.approveRequest(chatId, item.userId);
      else await manageActions.rejectRequest(chatId, item.userId);
      pushToast({
        kind: 'success',
        message: approve ? `@${item.username} принят(а) в чат` : `Заявка @${item.username} отклонена`,
      });
      await requests.refetch();
      await onChanged();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setBusy('');
    }
  }

  if (!requests.loading && requests.data.length === 0) {
    return (
      <View style={{ minHeight: 240, marginBottom: 10 }}>
        <EmptyState
          icon="mail-open-outline"
          title="Заявок нет"
          subtitle={
            requests.error
              ? requests.error
              : 'Новые заявки на вступление появятся здесь. Ссылки и прямые приглашения действуют сразу.'
          }
        />
      </View>
    );
  }

  return (
    <ManageSection
      icon="mail-unread-outline"
      title="Заявки на вступление"
      subtitle="Примите или отклоните запрос. Пользователь получит уведомление."
      right={<ManageBadge text={String(requests.data.length)} tone="warning" />}
    >
      {requests.error ? <Text style={{ color: theme.danger, fontSize: 12, marginBottom: 8 }}>{requests.error}</Text> : null}
      {requests.loading && requests.data.length === 0 ? (
        <ManageEmpty icon="mail-unread-outline" text="Загружаем заявки…" />
      ) : null}
      <View style={{ gap: 8 }}>
        {requests.data.map((item) => (
          <View
            key={item.id}
            style={{ borderWidth: 1, borderColor: theme.line, backgroundColor: theme.surface, borderRadius: 12, padding: 10 }}
          >
            <Pressable
              accessibilityRole="text"
              accessibilityLabel={`Заявка от ${item.displayName || item.username}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}
            >
              <Avatar name={item.displayName || item.username || '?'} size={36} hasModule={false} hasNode={false} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
                  {item.displayName || item.username || 'Пользователь'}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 11 }} numberOfLines={1}>
                  @{item.username} · {formatWhen(item.createdAt)}
                </Text>
              </View>
              <ManageBadge text={ROLE_LABEL[item.role]} tone="accent" />
            </Pressable>

            {item.note ? (
              <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 7, lineHeight: 16 }}>{item.note}</Text>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 7, marginTop: 9 }}>
              <Pressable
                onPress={() => void decide(item, true)}
                disabled={Boolean(busy)}
                accessibilityRole="button"
                accessibilityLabel={`Принять заявку @${item.username}`}
                style={({ pressed }) => [
                  styles.btn,
                  { backgroundColor: theme.successSoft, borderColor: theme.success, opacity: pressed || busy ? 0.7 : 1 },
                ]}
              >
                <Ionicons name="checkmark" size={14} color={theme.success} />
                <Text style={{ color: theme.success, fontSize: 12, fontWeight: '700' }}>
                  {busy === item.userId ? 'Обрабатываем…' : 'Принять'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void decide(item, false)}
                disabled={Boolean(busy)}
                accessibilityRole="button"
                accessibilityLabel={`Отклонить заявку @${item.username}`}
                style={({ pressed }) => [
                  styles.btn,
                  { backgroundColor: theme.dangerSoft, borderColor: theme.danger, opacity: pressed || busy ? 0.7 : 1 },
                ]}
              >
                <Ionicons name="close" size={14} color={theme.danger} />
                <Text style={{ color: theme.danger, fontSize: 12, fontWeight: '700' }}>Отклонить</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>
    </ManageSection>
  );
}

const styles = {
  btn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 5,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
};
