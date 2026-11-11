/**
 * Приватность: кто может приглашать в группы/каналы и список заблокированных.
 * Данные — GET /v1/me и GET /v1/me/blocked, без локальных заглушек.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../../src/theme/useTheme';
import { motion } from '../../../src/theme/motion';
import { useReducedMotion } from '../../../src/components/useReducedMotion';
import {
  GlassCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../../../src/components/settings/SettingsUI';
import { EmptyState } from '../../../src/components/EmptyState';
import { SettingsRowsSkeleton } from '../../../src/components/skeletons/PageSkeletons';
import { Avatar } from '../../../src/components/Avatar';
import { Btn } from '../../../src/components/Btn';
import {
  useBlockedUsers,
  useSetBlock,
  useMe,
  useUpdateProfile,
  humanError,
} from '../../../src/data/queries';
import { useStore } from '../../../src/state/useStore';

/** Кто может добавлять пользователя в группы и каналы напрямую. */
type InvitePrivacy = 'everyone' | 'shared' | 'chat' | 'nobody';

const INVITE_OPTIONS: { value: InvitePrivacy; title: string; subtitle: string }[] = [
  { value: 'everyone', title: 'Все', subtitle: 'Любой пользователь может добавить вас без подтверждения' },
  { value: 'shared', title: 'Только из общих групп', subtitle: 'Участники групп, где вы состоите' },
  { value: 'chat', title: 'С кем есть личный чат', subtitle: 'Только те, с кем вы уже переписывались' },
  { value: 'nobody', title: 'Никто', subtitle: 'Вас нельзя добавить в группу или канал напрямую' },
];

export default function PrivacyScreen() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const blocked = useBlockedUsers();
  const setBlock = useSetBlock();
  const me = useMe();
  const updateProfile = useUpdateProfile();
  const pushToast = useStore((s) => s.pushToast);
  const [showInfo, setShowInfo] = React.useState(false);
  const [pendingInvite, setPendingInvite] = React.useState<InvitePrivacy | null>(null);

  const rows = blocked.data ?? [];
  const invitePrivacy =
    ((me.data as unknown as { invitePrivacy?: InvitePrivacy } | undefined)?.invitePrivacy as InvitePrivacy | undefined) ?? null;

  async function unblock(username: string) {
    try {
      await setBlock.mutateAsync({ username, blocked: false });
      pushToast({ kind: 'success', message: `@${username} разблокирован` });
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  async function chooseInvite(value: InvitePrivacy) {
    if (value === invitePrivacy || updateProfile.isPending) return;
    setPendingInvite(value);
    try {
      // invitePrivacy появится в контракте patchMe параллельно — приводим тип локально.
      await updateProfile.mutateAsync({ invitePrivacy: value } as unknown as { displayName?: string; bio?: string });
      pushToast({ kind: 'success', message: 'Настройка приглашений сохранена' });
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    } finally {
      setPendingInvite(null);
    }
  }

  return (
    <SettingsPage title="Приватность" subtitle="Приглашения, блокировки и как это работает">
      <SettingsSection
        title="Приглашения в группы и каналы"
        delay={0}
        right={me.isLoading ? undefined : invitePrivacy ? <SettingsInviteBadge value={invitePrivacy} /> : null}
      >
        {me.isLoading ? (
          <GlassCard>
            <SettingsRowsSkeleton rows={4} size={34} />
          </GlassCard>
        ) : me.isError ? (
          <GlassCard>
            <View style={{ padding: 14, gap: 8 }}>
              <Text style={{ color: theme.danger, fontSize: 13 }}>{humanError(me.error)}</Text>
              <Btn title="Повторить" size="s" variant="ghost" onPress={() => void me.refetch()} />
            </View>
          </GlassCard>
        ) : (
          <>
            <GlassCard>
              {INVITE_OPTIONS.map((option, index) => {
                const selected = invitePrivacy === option.value;
                const saving = pendingInvite === option.value;
                const disabled = updateProfile.isPending;
                return (
                  <MotiView
                    key={option.value}
                    from={reduced ? { opacity: 1 } : { opacity: 0, translateY: 6 }}
                    animate={{ opacity: 1, translateY: 0 }}
                    transition={
                      reduced
                        ? { type: 'timing', duration: 0 }
                        : { ...motion.spring, delay: Math.min(index, 10) * motion.staggerStepMs }
                    }
                  >
                    <Pressable
                      onPress={() => void chooseInvite(option.value)}
                      disabled={disabled}
                      accessibilityRole="radio"
                      accessibilityState={{ selected, disabled }}
                      accessibilityLabel={`${option.title}. ${option.subtitle}`}
                      style={({ pressed }) => [
                        styles.inviteRow,
                        {
                          backgroundColor: selected
                            ? theme.accentSoft
                            : pressed
                              ? theme.surfacePressed
                              : 'transparent',
                          borderTopColor: theme.line,
                          borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                          opacity: disabled && !saving ? 0.6 : 1,
                        },
                      ]}
                    >
                      <View
                        style={[
                          styles.radio,
                          {
                            borderColor: selected ? theme.accent : theme.line,
                            backgroundColor: selected ? theme.accent : 'transparent',
                          },
                        ]}
                      >
                        {selected ? <Ionicons name="checkmark" size={14} color={theme.onAccent} /> : null}
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '600' }} numberOfLines={1}>
                          {option.title}
                        </Text>
                        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 1.5 }} numberOfLines={2}>
                          {option.subtitle}
                        </Text>
                      </View>
                      {saving ? <ActivityIndicator size="small" color={theme.accent} /> : null}
                    </Pressable>
                  </MotiView>
                );
              })}
            </GlassCard>
            <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 8, paddingHorizontal: 4 }}>
              Кто может добавлять вас в группы и каналы напрямую без вашего подтверждения. Приглашения от остальных
              будут отклонены.
            </Text>
          </>
        )}
      </SettingsSection>

      <SettingsSection title="Заблокированные пользователи" delay={120} right={<Text style={{ color: theme.textDisabled, fontSize: 12 }}>{rows.length}</Text>}>
        {blocked.isLoading ? (
          <GlassCard>
            <SettingsRowsSkeleton rows={4} size={42} />
          </GlassCard>
        ) : blocked.isError ? (
          <GlassCard>
            <View style={{ padding: 14, gap: 8 }}>
              <Text style={{ color: theme.danger, fontSize: 13 }}>{humanError(blocked.error)}</Text>
              <Btn title="Повторить" size="s" variant="ghost" onPress={() => void blocked.refetch()} />
            </View>
          </GlassCard>
        ) : rows.length === 0 ? (
          <View style={{ minHeight: 220 }}>
            <EmptyState
              icon="ban-outline"
              title="Никого не заблокировали"
              subtitle="Заблокировать пользователя можно на его странице профиля."
            />
          </View>
        ) : (
          <GlassCard>
            {rows.map((u, index) => {
              const pending = setBlock.isPending && setBlock.variables?.username === u.username;
              return (
                <MotiView
                  key={u.userId}
                  from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 6 }}
                  animate={{ opacity: 1, translateY: 0 }}
                  transition={
                    reduced
                      ? { type: 'timing', duration: 0 }
                      : { ...motion.spring, delay: Math.min(index, 10) * motion.staggerStepMs }
                  }
                >
                  <View style={[styles.row, { borderBottomColor: theme.line }]}>
                    <Avatar name={u.displayName || u.username} size={42} hasModule={false} hasNode={false} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
                        {u.displayName || u.username}
                      </Text>
                      <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                        @{u.username} · с {new Date(u.blockedAt).toLocaleDateString('ru-RU')}
                      </Text>
                    </View>
                    <Btn
                      title="Разблокировать"
                      size="s"
                      variant="ghost"
                      loading={pending}
                      onPress={() => void unblock(u.username)}
                      accessibilityLabel={`Разблокировать @${u.username}`}
                    />
                  </View>
                </MotiView>
              );
            })}
          </GlassCard>
        )}
      </SettingsSection>

      <SettingsSection title="Как это работает" delay={200}>
        <GlassCard>
          <SettingsRow
            icon="information-circle-outline"
            title="Как работает блокировка"
            subtitle="Коротко о последствиях"
            onPress={() => setShowInfo((v) => !v)}
            right={<Ionicons name={showInfo ? 'chevron-up' : 'chevron-down'} size={16} color={theme.textDisabled} />}
          />
          {showInfo ? (
            <View style={{ paddingHorizontal: 10, paddingBottom: 12, gap: 6 }}>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 }}>
                Заблокированный пользователь не может писать вам и начинать новые чаты. Существующая переписка скрывается
                из списка чатов, но история на устройстве не удаляется.
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 }}>
                Блокировка не влияет на общие групповые чаты, где вы оба участники, и не уведомляет пользователя.
              </Text>
            </View>
          ) : null}
        </GlassCard>
      </SettingsSection>
    </SettingsPage>
  );
}

/** Компактная подпись текущего режима приглашений в шапке секции. */
function SettingsInviteBadge({ value }: { value: InvitePrivacy }) {
  const theme = useTheme();
  const label = INVITE_OPTIONS.find((option) => option.value === value)?.title ?? '';
  if (!label) return null;
  return (
    <Text style={{ color: theme.textDisabled, fontSize: 12, maxWidth: '55%', textAlign: 'right' }} numberOfLines={1}>
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  inviteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 10,
    paddingVertical: 11,
    minHeight: 48,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
