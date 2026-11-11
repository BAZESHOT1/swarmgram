import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { Avatar } from '../Avatar';
import { PressableScale } from '../profile/PressableScale';
import { GlassCard } from '../profile/Glass';
import { SettingsConfirm, SettingsModal } from '../settings/SettingsWidgets';
import { Btn } from '../Btn';
import { ROLE_LABEL } from './ManageTypes';

export interface ChatMemberRow {
  userId: string;
  username: string;
  displayName: string;
  role: string;
  /** Онлайн-узел участника (оранжевая обводка). */
  nodeOnline?: boolean;
  /** Онлайн-модуль участника (зелёная обводка). */
  moduleOnline?: boolean;
}

type MemberRole = 'admin' | 'moderator' | 'member';

const ROLE_OPTIONS: { role: MemberRole; label: string; hint: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { role: 'admin', label: 'Сделать администратором', hint: 'Права по матрице администратора', icon: 'shield-checkmark-outline' },
  { role: 'moderator', label: 'Сделать модератором', hint: 'Права по матрице модератора', icon: 'shield-half-outline' },
  { role: 'member', label: 'Сделать участником', hint: 'Обычное участие без прав', icon: 'person-outline' },
];

/** Вкладка участников/подписчиков. Для direct показывает карточку собеседника. */
export function MembersTab({
  members,
  myUsername,
  type,
  onOpenUser,
  myRole,
  canManage,
  onChangeRole,
  onRemove,
}: {
  members: ChatMemberRow[];
  myUsername: string;
  type: string;
  onOpenUser: (username: string) => void;
  /** Моя роль; нужна, чтобы не давать менять владельца. */
  myRole?: string;
  /** Доступно ли управление ролями/исключением (owner/admin по правам). */
  canManage?: boolean;
  onChangeRole?: (member: ChatMemberRow, role: MemberRole) => Promise<void>;
  onRemove?: (member: ChatMemberRow) => Promise<void>;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const isDirect = type === 'direct';
  const peer = isDirect ? members.find((m) => m.username !== myUsername) : null;

  const [actionMember, setActionMember] = React.useState<ChatMemberRow | null>(null);
  const [removeMember, setRemoveMember] = React.useState<ChatMemberRow | null>(null);
  const [busyUser, setBusyUser] = React.useState('');
  const [error, setError] = React.useState('');

  if (isDirect) {
    if (!peer) {
      return (
        <GlassCard>
          <Text style={{ color: theme.textSecondary, fontSize: 13 }}>Собеседник ещё не определён.</Text>
        </GlassCard>
      );
    }
    return (
      <MotiView
        from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 8, scale: 0.99 }}
        animate={{ opacity: 1, translateY: 0, scale: 1 }}
        transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
      >
        <GlassCard>
          <PressableScale
            onPress={() => onOpenUser(peer.username)}
            accessibilityRole="button"
            accessibilityLabel={`Открыть профиль ${peer.displayName || peer.username}`}
            style={styles.peerRow}
          >
            <Avatar
              name={peer.displayName || peer.username}
              size={58}
              nodeOnline={peer.nodeOnline}
              moduleOnline={peer.moduleOnline}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.textPrimary, fontSize: 17, fontWeight: '700' }} numberOfLines={1}>
                {peer.displayName || peer.username}
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
                @{peer.username}
              </Text>
              <Text style={{ color: theme.accent, fontSize: 12, marginTop: 6, fontWeight: '600' }}>Открыть профиль →</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={theme.textDisabled} />
          </PressableScale>
        </GlassCard>
      </MotiView>
    );
  }

  const sorted = [...members].sort((a, b) => {
    const rank = (r: string) => (r === 'owner' ? 0 : r === 'admin' ? 1 : r === 'moderator' ? 2 : 3);
    return rank(a.role) - rank(b.role) || (a.username || '').localeCompare(b.username || '');
  });

  const canEditMember = (m: ChatMemberRow) =>
    Boolean(canManage && onChangeRole) && m.role !== 'owner' && m.username !== myUsername;

  async function changeRole(role: MemberRole) {
    if (!actionMember || !onChangeRole || busyUser) return;
    setBusyUser(actionMember.username);
    setError('');
    try {
      await onChangeRole(actionMember, role);
      setActionMember(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Не удалось изменить роль');
    } finally {
      setBusyUser('');
    }
  }

  async function remove() {
    if (!removeMember || !onRemove || busyUser) return;
    setBusyUser(removeMember.username);
    setError('');
    try {
      await onRemove(removeMember);
      setRemoveMember(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Не удалось исключить участника');
    } finally {
      setBusyUser('');
    }
  }

  return (
    <GlassCard padding={10}>
      {sorted.length === 0 ? (
        <Text style={{ color: theme.textSecondary, fontSize: 13, paddingVertical: 6 }}>Список пока пуст.</Text>
      ) : (
        <View style={{ gap: 2 }}>
          {sorted.map((m, index) => (
            <MotiView
              key={m.userId || m.username}
              from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 6 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={
                reduced
                  ? { type: 'timing', duration: 0 }
                  : { ...motion.spring, delay: Math.min(index, 12) * motion.staggerStepMs }
              }
            >
              <PressableScale
                onPress={() => onOpenUser(m.username)}
                accessibilityRole="button"
                accessibilityLabel={`Профиль @${m.username}`}
                style={styles.row}
              >
                <Avatar
                  name={m.displayName || m.username}
                  size={38}
                  nodeOnline={m.nodeOnline}
                  moduleOnline={m.moduleOnline}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                      {m.displayName || m.username}
                    </Text>
                    {m.username === myUsername ? (
                      <Text style={{ color: theme.accent, fontSize: 10.5, fontWeight: '700' }}>вы</Text>
                    ) : null}
                    {m.role === 'owner' ? <Ionicons name="ribbon" size={12} color={theme.accent} /> : null}
                  </View>
                  <Text style={{ color: theme.textSecondary, fontSize: 11.5 }} numberOfLines={1}>
                    @{m.username}
                  </Text>
                </View>
                <View style={[styles.role, { backgroundColor: m.role === 'owner' ? theme.accentSoft : theme.surfacePressed }]}>
                  <Text style={{ color: m.role === 'owner' ? theme.accent : theme.textSecondary, fontSize: 10.5, fontWeight: '600' }}>
                    {ROLE_LABEL[m.role as keyof typeof ROLE_LABEL] ?? m.role}
                  </Text>
                </View>
                {canEditMember(m) ? (
                  <Pressable
                    onPress={(event) => {
                      event.stopPropagation?.();
                      setError('');
                      setActionMember(m);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Действия для @${m.username}`}
                    hitSlop={8}
                    style={({ pressed }) => [styles.more, { opacity: pressed ? 0.6 : 1 }]}
                  >
                    <Ionicons name="ellipsis-horizontal" size={17} color={theme.textDisabled} />
                  </Pressable>
                ) : null}
              </PressableScale>
            </MotiView>
          ))}
        </View>
      )}

      <SettingsModal
        visible={Boolean(actionMember)}
        title={actionMember ? (actionMember.displayName || actionMember.username) : 'Участник'}
        subtitle={actionMember ? `@${actionMember.username} · ${ROLE_LABEL[actionMember.role as keyof typeof ROLE_LABEL] ?? actionMember.role}` : undefined}
        onClose={() => setActionMember(null)}
      >
        {error ? <Text style={{ color: theme.danger, fontSize: 12.5, marginBottom: 8 }}>{error}</Text> : null}
        <View style={{ gap: 6 }}>
          {ROLE_OPTIONS.filter((option) => option.role !== actionMember?.role).map((option) => (
            <Pressable
              key={option.role}
              onPress={() => void changeRole(option.role)}
              disabled={Boolean(busyUser)}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              style={({ pressed }) => [
                styles.optionRow,
                {
                  borderColor: theme.line,
                  backgroundColor: pressed ? theme.surfacePressed : theme.surface,
                  opacity: busyUser ? 0.55 : 1,
                },
              ]}
            >
              <View style={[styles.optionIcon, { backgroundColor: theme.accentSoft }]}>
                <Ionicons name={option.icon} size={16} color={theme.accent} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }}>{option.label}</Text>
                <Text style={{ color: theme.textSecondary, fontSize: 11, marginTop: 1 }}>{option.hint}</Text>
              </View>
              {busyUser === actionMember?.username ? (
                <Ionicons name="hourglass-outline" size={15} color={theme.textDisabled} />
              ) : (
                <Ionicons name="chevron-forward" size={15} color={theme.textDisabled} />
              )}
            </Pressable>
          ))}
        </View>
        <View style={{ marginTop: 10 }}>
          <Btn
            title="Исключить из чата"
            variant="danger"
            disabled={busyUser === actionMember?.username}
            onPress={() => {
              setRemoveMember(actionMember);
              setActionMember(null);
            }}
          />
        </View>
      </SettingsModal>

      <SettingsConfirm
        visible={Boolean(removeMember)}
        title="Исключить участника?"
        message={
          removeMember
            ? `@${removeMember.username} потеряет доступ к чату. Вернуться можно будет по новой ссылке или заявке.`
            : ''
        }
        confirmLabel="Исключить"
        loading={Boolean(busyUser)}
        onClose={() => setRemoveMember(null)}
        onConfirm={() => void remove()}
      />

      {!isDirect && myRole === 'owner' ? (
        <Text style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 8, paddingHorizontal: 6, lineHeight: 14 }}>
          Владельца нельзя исключить или понизить. Сначала передайте владение в разделе «Управление».
        </Text>
      ) : null}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  peerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingVertical: 7, borderRadius: 10, minHeight: 52 },
  role: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  more: { width: 30, height: 34, alignItems: 'center', justifyContent: 'center' },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  optionIcon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
});
