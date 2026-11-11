/**
 * Подраздел «Журнал»: последние действия в чате — кто, что, над кем и когда.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { ManageBadge, ManageEmpty, ManageSection } from './ManageUI';
import { useChatAuditSafe } from './ManageData';
import { auditActionLabel, formatWhen, type ManageChat } from './ManageTypes';

export function ManageAudit({ chat }: { chat: ManageChat }) {
  const theme = useTheme();
  const audit = useChatAuditSafe(chat.id);
  const [refreshing, setRefreshing] = React.useState(false);

  async function refresh() {
    setRefreshing(true);
    await audit.refetch();
    setRefreshing(false);
  }

  return (
    <ManageSection
      icon="receipt-outline"
      title="Журнал действий"
      subtitle="Последние события управления чатом."
      right={
        <Pressable
          onPress={() => void refresh()}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel="Обновить журнал"
          hitSlop={8}
          style={({ pressed }) => [{ opacity: pressed || refreshing ? 0.5 : 1 }]}
        >
          <Ionicons name="refresh" size={17} color={theme.accent} />
        </Pressable>
      }
    >
      {audit.error ? <Text style={{ color: theme.danger, fontSize: 12, marginBottom: 8 }}>{audit.error}</Text> : null}
      {audit.data.length === 0 ? (
        <ManageEmpty icon="receipt-outline" text={audit.loading ? 'Загружаем журнал…' : 'Пока нет записей.'} />
      ) : (
        <View style={{ gap: 2 }}>
          {audit.data.slice(0, 50).map((item, index) => {
            const member = item.target
              ? (chat.members ?? []).find((m) => m.userId === item.target || m.username === item.target)
              : undefined;
            const targetName = item.target ? member?.username ?? '' : '';
            return (
              <View
                key={`${item.id}-${index}`}
                style={[
                  styles.row,
                  index > 0 ? { borderTopWidth: 1, borderTopColor: theme.line } : null,
                ]}
              >
                <View style={[styles.dot, { backgroundColor: theme.accentSoft }]}>
                  <Ionicons name="pulse-outline" size={12} color={theme.accent} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ color: theme.textPrimary, fontSize: 12.5, lineHeight: 17 }} numberOfLines={2}>
                    <Text style={{ fontWeight: '700' }}>{item.actorUsername ? `@${item.actorUsername}` : 'Система'}</Text>{' '}
                    {auditActionLabel(item.action)}
                    {targetName ? <Text style={{ color: theme.textSecondary }}> · @{targetName}</Text> : null}
                  </Text>
                  <Text style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 1 }}>
                    {formatWhen(item.createdAt)}
                  </Text>
                </View>
                {item.action.includes('ban') ? <ManageBadge text="бан" tone="danger" /> : null}
              </View>
            );
          })}
        </View>
      )}
    </ManageSection>
  );
}

const styles = {
  row: { flexDirection: 'row' as const, alignItems: 'flex-start' as const, gap: 9, paddingVertical: 8, paddingHorizontal: 4 },
  dot: { width: 24, height: 24, borderRadius: 8, alignItems: 'center' as const, justifyContent: 'center' as const },
};
