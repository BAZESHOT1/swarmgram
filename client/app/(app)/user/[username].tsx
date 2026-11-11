import React from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../../../src/theme/useTheme';
import { motion } from '../../../src/theme/motion';
import { EmptyState } from '../../../src/components/EmptyState';
import { ProfileSkeleton } from '../../../src/components/skeletons/PageSkeletons';
import { useReducedMotion } from '../../../src/components/useReducedMotion';
import { PressableScale } from '../../../src/components/profile/PressableScale';
import { ProfileHero } from '../../../src/components/profile/ProfileHero';
import { ProfileActions, type ProfileAction } from '../../../src/components/profile/ProfileActions';
import { ProfileLinks } from '../../../src/components/profile/ProfileLinks';
import { ProfileBadges, type ProfileBadgeFacts } from '../../../src/components/profile/ProfileBadges';
import { ProfileQrModal, copyText, shareUrl } from '../../../src/components/profile/ProfileQrModal';
import { InviteToChatModal } from '../../../src/components/profile/InviteToChatModal';
import { ReportModal } from '../../../src/components/profile/ReportModal';
import { ConfirmModal } from '../../../src/components/profile/ConfirmModal';
import { SharedChatsList } from '../../../src/components/profile/SharedChatsList';
import { GlassCard, GlassSectionTitle } from '../../../src/components/profile/Glass';
import { Btn } from '../../../src/components/Btn';
import {
  useMe,
  useUserProfile,
  useSetBlock,
  useReportUser,
  useCreateChat,
  humanError,
} from '../../../src/data/queries';
import * as api from '../../../src/data/api';
import type { UserProfile } from '../../../src/data/api';
import { useStore } from '../../../src/state/useStore';

/** «был(а) недавно» / точная дата последнего визита. */
function lastSeenLabel(iso: string | null): string {
  if (!iso) return 'был(а) недавно';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'был(а) недавно';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'был(а) только что';
  if (diff < 3_600_000) return `был(а) ${Math.max(1, Math.round(diff / 60_000))} мин назад`;
  if (diff < 86_400_000) return `был(а) ${Math.max(1, Math.round(diff / 3_600_000))} ч назад`;
  if (diff < 7 * 86_400_000) return `был(а) ${Math.max(1, Math.round(diff / 86_400_000))} дн назад`;
  return `был(а) ${new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

/** Публичная ссылка на профиль — та же, что уходит в QR и шеринг. */
function profileUrl(username: string): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.origin}/user/${encodeURIComponent(username)}`;
  }
  return `https://swarmgram.app/user/${encodeURIComponent(username)}`;
}

/** Страница профиля: свой — профильные блоки, чужой — действия и приглашения. */
export default function UserProfileScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ username: string }>();
  const username = String(params.username ?? '').trim();
  const reduced = useReducedMotion();

  const pushToast = useStore((s) => s.pushToast);

  const profileQuery = useUserProfile(username || null);
  const profile = profileQuery.data as UserProfile | undefined;
  const meQuery = useMe();
  const setBlock = useSetBlock();
  const reportUser = useReportUser();
  const createChat = useCreateChat();

  const [refreshing, setRefreshing] = React.useState(false);
  const [reportOpen, setReportOpen] = React.useState(false);
  const [blockOpen, setBlockOpen] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [qrOpen, setQrOpen] = React.useState(false);
  const [creating, setCreating] = React.useState<'' | 'server' | 'e2e'>('');

  const isSelf = Boolean(profile?.isSelf);
  const blockedByMe = Boolean(profile?.blockedByMe);
  const blockedMe = Boolean(profile?.blockedMe);
  const canChat = Boolean(profile) && !isSelf && !blockedByMe;

  const share = React.useCallback(async () => {
    const title = profile?.displayName ? `${profile.displayName} · SwarmGram` : `@${username} · SwarmGram`;
    try {
      const result = await shareUrl(profileUrl(username), title, `Профиль @${username} в SwarmGram`);
      if (result === 'copied') pushToast({ kind: 'success', message: 'Ссылка на профиль скопирована' });
    } catch {
      pushToast({ kind: 'error', message: 'Не удалось поделиться' });
    }
  }, [profile?.displayName, pushToast, username]);

  const copyLink = React.useCallback(async () => {
    try {
      await copyText(profileUrl(username));
      pushToast({ kind: 'success', message: 'Ссылка на профиль скопирована' });
    } catch {
      pushToast({ kind: 'error', message: 'Не удалось скопировать ссылку' });
    }
  }, [pushToast, username]);

  async function openChat(encryption: 'server' | 'e2e') {
    if (!profile || !canChat || creating) return;
    setCreating(encryption);
    try {
      const created = await createChat.mutateAsync({
        type: 'direct',
        username: profile.username,
        ...(encryption === 'e2e' ? { encryption: 'e2e' as const } : {}),
      });
      if (encryption === 'e2e') {
        // Сразу раскладываем ключ по устройствам — иначе новый E2E-чат будет «пустым».
        try {
          const core = await import('../../../src/crypto/core');
          const keys = await core.storage.loadKeys();
          if (keys) {
            const bundle = await api.api
              .getBundle(profile.username)
              .catch(() => ({ devices: [] as { deviceId: string; ecdhPub: string }[] }));
            const { createAndShareChatKey } = await import('../../../src/data/chatkit');
            await createAndShareChatKey(
              created.id,
              [
                { deviceId: keys.deviceId, ecdhPub: JSON.stringify(core.publicJwkOf(keys.ecdhPriv)) },
                ...bundle.devices.map((d) => ({ deviceId: d.deviceId, ecdhPub: d.ecdhPub })),
              ],
              keys,
            );
            const { refreshKeyBackup } = await import('../../../src/data/auth');
            void refreshKeyBackup();
          }
        } catch {
          /* ключ можно дослать позже: чат уже создан */
        }
        pushToast({ kind: 'success', message: 'Секретный чат создан — история не синхронизируется' });
      }
      router.push(`/chat/${created.id}` as never);
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    } finally {
      setCreating('');
    }
  }

  async function toggleBlock() {
    if (!profile) return;
    try {
      await setBlock.mutateAsync({ username: profile.username, blocked: !profile.blockedByMe });
      pushToast({ kind: 'success', message: profile.blockedByMe ? 'Пользователь разблокирован' : 'Пользователь заблокирован' });
      setBlockOpen(false);
      await profileQuery.refetch();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  async function sendReport(reason: string, note: string) {
    if (!profile) return;
    try {
      await reportUser.mutateAsync({ username: profile.username, reason, note });
      pushToast({ kind: 'success', message: 'Жалоба отправлена' });
      setReportOpen(false);
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  /** Pull-to-refresh профиля: сам профиль и /me (узлы/модуль приходят оттуда). */
  async function refreshProfile() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.allSettled([profileQuery.refetch(), meQuery.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }

  /* ------------------------------------------------------------- loading */
  if (profileQuery.isLoading) {
    return <ProfileSkeleton onBack={() => router.back()} />;
  }

  /* --------------------------------------------------------------- error */
  if (profileQuery.isError || !profile) {
    return (
      <View style={{ flex: 1, paddingTop: 44 }}>
        <EmptyState
          title="Пользователь не найден"
          subtitle="Возможно, аккаунт удалён или username изменился."
          actionLabel="Назад"
          onAction={() => router.back()}
        />
      </View>
    );
  }

  const title = profile.displayName || profile.username;
  const statusText = profile.online ? 'в сети' : lastSeenLabel(profile.lastSeenAt);

  // Онлайн-узлы/модули приходят в профиле (контракт data-слоя).
  const nodeOnline =
    profile.nodeOnline ?? (isSelf ? (meQuery.data?.nodes ?? []).some((n) => n.status === 'online') : false);
  const moduleOnline = profile.moduleOnline ?? (isSelf ? Boolean(meQuery.data?.moduleOnline) : false);

  // Свой профиль может отдавать расширенные поля и из /v1/me.
  const avatar = profile.avatar ?? (isSelf ? meQuery.data?.avatar : null);
  const banner = profile.banner ?? (isSelf ? meQuery.data?.banner : undefined);
  const links = profile.links ?? (isSelf ? meQuery.data?.links : undefined);
  const location = profile.location ?? (isSelf ? meQuery.data?.location : '');
  const birthday = profile.birthday ?? (isSelf ? meQuery.data?.birthday : null);
  // Статус появится в типах вместе с серверной частью — читаем безопасно.
  const status = String((profile as UserProfile & { status?: string }).status ?? (isSelf ? meQuery.data?.status ?? '' : '')).trim();

  const nodes = isSelf ? meQuery.data?.nodes ?? [] : [];

  const badgeFacts: ProfileBadgeFacts = {
    createdAt: profile.createdAt,
    sharedChats: profile.sharedChats?.length ?? 0,
    nodeOnline,
    hasNodes: isSelf ? nodes.length > 0 : undefined,
    moduleOnline,
  };

  const actions: ProfileAction[] = [];
  if (!isSelf) {
    if (canChat) {
      actions.push({
        key: 'write',
        icon: 'paper-plane-outline',
        label: 'Написать',
        onPress: () => void openChat('server'),
        loading: creating === 'server',
      });
      actions.push({
        key: 'secret',
        icon: 'lock-closed-outline',
        label: 'Секретный чат',
        onPress: () => void openChat('e2e'),
        loading: creating === 'e2e',
      });
      actions.push({
        key: 'invite',
        icon: 'person-add-outline',
        label: 'Пригласить в чат',
        onPress: () => setInviteOpen(true),
      });
    }
    actions.push({ key: 'qr', icon: 'qr-code-outline', label: 'QR-код', onPress: () => setQrOpen(true) });
    actions.push({ key: 'share', icon: 'share-social-outline', label: 'Поделиться', onPress: () => void share() });
  }

  return (
    <>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshProfile()}
            tintColor={theme.accent}
            colors={[theme.accent]}
          />
        }
      >
        <View style={styles.center}>
          <ProfileHero
            name={title}
            username={profile.username}
            avatar={avatar}
            banner={banner}
            location={location}
            birthday={birthday}
            bio={isSelf ? undefined : profile.bio}
            status={status || undefined}
            statusText={statusText}
            online={isSelf ? true : profile.online}
            isSelf={isSelf}
            nodeOnline={nodeOnline}
            moduleOnline={moduleOnline}
            onBack={() => router.back()}
            onShare={() => void share()}
            onQr={() => setQrOpen(true)}
            onEdit={isSelf ? () => router.push(`/user/${profile.username}/edit` as never) : undefined}
          />

          <View style={styles.body}>
            {blockedByMe ? (
              <View style={[styles.notice, { backgroundColor: theme.dangerSoft, borderColor: theme.danger }]}>
                <Ionicons name="ban" size={17} color={theme.danger} />
                <Text style={{ color: theme.danger, fontSize: 12.5, flex: 1, fontWeight: '600' }}>
                  Вы заблокировали этого пользователя. Переписка недоступна.
                </Text>
              </View>
            ) : null}
            {!blockedByMe && blockedMe ? (
              <View style={[styles.notice, { backgroundColor: theme.warningSoft, borderColor: theme.warning }]}>
                <Ionicons name="lock-closed-outline" size={17} color={theme.warning} />
                <Text style={{ color: theme.warning, fontSize: 12.5, flex: 1, fontWeight: '600' }}>
                  Пользователь ограничил возможность писать ему.
                </Text>
              </View>
            ) : null}

            {isSelf ? (
              <OverviewSelf
                profile={profile}
                links={links}
                badgeFacts={badgeFacts}
                onQr={() => setQrOpen(true)}
                onShare={() => void share()}
                onCopy={() => void copyLink()}
                reduced={reduced}
              />
            ) : (
              <>
                {/* -------------------------------------------------- чужой профиль */}
                <MotiView
                  from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.99 }}
                  animate={{ opacity: 1, translateY: 0, scale: 1 }}
                  transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay: motion.staggerStepMs }}
                  style={{ marginTop: 12 }}
                >
                  <GlassCard>
                    <GlassSectionTitle title={links?.length ? 'Ссылки' : 'Аккаунт'} />
                    {links?.length ? (
                      <ProfileLinks links={links} />
                    ) : (
                      <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 19 }}>
                        Пользователь не добавил ссылок.
                      </Text>
                    )}
                  </GlassCard>
                </MotiView>

                <MotiView
                  from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.99 }}
                  animate={{ opacity: 1, translateY: 0, scale: 1 }}
                  transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay: motion.staggerStepMs * 2 }}
                  style={{ marginTop: 12 }}
                >
                  <ProfileBadges facts={badgeFacts} />
                </MotiView>

                <MotiView
                  from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.99 }}
                  animate={{ opacity: 1, translateY: 0, scale: 1 }}
                  transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay: motion.staggerStepMs * 3 }}
                  style={{ marginTop: 12 }}
                >
                  <ProfileActions actions={actions} />
                </MotiView>

                <MotiView
                  from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.99 }}
                  animate={{ opacity: 1, translateY: 0, scale: 1 }}
                  transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay: motion.staggerStepMs * 4 }}
                  style={{ marginTop: 12 }}
                >
                  <GlassCard>
                    <GlassSectionTitle
                      title="Общие чаты"
                      right={<Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>{profile.sharedChats.length}</Text>}
                    />
                    <SharedChatsList chats={profile.sharedChats} onOpen={(id) => router.push(`/chat/${id}` as never)} />
                  </GlassCard>
                </MotiView>

                <MotiView
                  from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10 }}
                  animate={{ opacity: 1, translateY: 0 }}
                  transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay: motion.staggerStepMs * 5 }}
                  style={{ marginTop: 12, gap: 8 }}
                >
                  <PressableScale
                    onPress={() => setBlockOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={blockedByMe ? 'Разблокировать пользователя' : 'Заблокировать пользователя'}
                    style={[
                      styles.dangerRow,
                      {
                        backgroundColor: blockedByMe ? theme.successSoft : theme.dangerSoft,
                        borderColor: blockedByMe ? theme.success : theme.danger,
                      },
                    ]}
                  >
                    <Ionicons name={blockedByMe ? 'lock-open-outline' : 'ban-outline'} size={17} color={blockedByMe ? theme.success : theme.danger} />
                    <Text style={{ color: blockedByMe ? theme.success : theme.danger, fontSize: 13.5, fontWeight: '600', flex: 1 }}>
                      {blockedByMe ? 'Разблокировать' : 'Заблокировать'}
                    </Text>
                  </PressableScale>
                  <PressableScale
                    onPress={() => setReportOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Пожаловаться на пользователя"
                    style={[styles.dangerRow, { backgroundColor: 'transparent', borderColor: theme.line }]}
                  >
                    <Ionicons name="flag-outline" size={17} color={theme.textSecondary} />
                    <Text style={{ color: theme.textSecondary, fontSize: 13.5, fontWeight: '600', flex: 1 }}>Пожаловаться</Text>
                    <Ionicons name="chevron-forward" size={15} color={theme.textDisabled} />
                  </PressableScale>
                </MotiView>
              </>
            )}
          </View>
        </View>
      </ScrollView>

      {!isSelf ? (
        <InviteToChatModal
          visible={inviteOpen}
          username={profile.username}
          displayName={profile.displayName}
          onClose={() => setInviteOpen(false)}
        />
      ) : null}

      <ProfileQrModal
        visible={qrOpen}
        username={profile.username}
        displayName={profile.displayName}
        onClose={() => setQrOpen(false)}
      />

      <ReportModal
        visible={reportOpen}
        loading={reportUser.isPending}
        onClose={() => setReportOpen(false)}
        onSubmit={(reason, note) => void sendReport(reason, note)}
      />

      <ConfirmModal
        visible={blockOpen}
        title={blockedByMe ? 'Разблокировать пользователя?' : 'Заблокировать пользователя?'}
        message={
          blockedByMe
            ? 'Пользователь снова сможет писать вам и видеть ваш профиль.'
            : 'Пользователь не сможет писать вам, а переписка будет скрыта. Разблокировать можно в любой момент.'
        }
        confirmLabel={blockedByMe ? 'Разблокировать' : 'Заблокировать'}
        danger={!blockedByMe}
        loading={setBlock.isPending}
        onClose={() => setBlockOpen(false)}
        onConfirm={() => void toggleBlock()}
      />
    </>
  );
}

/* --------------------------------------------------------- свой профиль -- */

function OverviewSelf({
  profile,
  links,
  badgeFacts,
  onQr,
  onShare,
  onCopy,
  reduced,
}: {
  profile: UserProfile;
  links?: { label: string; url: string }[];
  badgeFacts: ProfileBadgeFacts;
  onQr: () => void;
  onShare: () => void;
  onCopy: () => void;
  reduced: boolean;
}) {
  const theme = useTheme();
  const url = profileUrl(profile.username);

  return (
    <>
      <MotiView
        from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.99 }}
        animate={{ opacity: 1, translateY: 0, scale: 1 }}
        transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
        style={{ marginTop: 12 }}
      >
        <GlassCard>
          <GlassSectionTitle title="О себе" />
          {profile.bio ? (
            <Text style={{ color: theme.textPrimary, fontSize: 14, lineHeight: 20 }}>{profile.bio}</Text>
          ) : (
            <Text style={{ color: theme.textDisabled, fontSize: 13, fontStyle: 'italic' }}>
              Добавьте пару слов о себе — это можно сделать в редактировании профиля.
            </Text>
          )}

          {links?.length ? (
            <View style={{ marginTop: 12 }}>
              <ProfileLinks links={links} />
            </View>
          ) : null}
        </GlassCard>
      </MotiView>

      <MotiView
        from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.99 }}
        animate={{ opacity: 1, translateY: 0, scale: 1 }}
        transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay: motion.staggerStepMs }}
        style={{ marginTop: 12 }}
      >
        <ProfileBadges facts={badgeFacts} />
      </MotiView>

      <MotiView
        from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 10, scale: 0.99 }}
        animate={{ opacity: 1, translateY: 0, scale: 1 }}
        transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay: motion.staggerStepMs * 2 }}
        style={{ marginTop: 12 }}
      >
        <GlassCard>
          <GlassSectionTitle
            title="QR и шеринг"
            right={<Ionicons name="qr-code-outline" size={15} color={theme.textSecondary} />}
          />
          <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18 }}>
            Поделитесь профилем: ссылка и QR открывают @{profile.username} в SwarmGram.
          </Text>
          <View
            style={[
              styles.linkBox,
              {
                borderColor: theme.line,
                backgroundColor: theme.dark ? 'rgba(255,255,255,0.04)' : 'rgba(16,24,40,0.03)',
              },
            ]}
          >
            <Ionicons name="link-outline" size={14} color={theme.textSecondary} />
            <Text selectable style={{ color: theme.textPrimary, fontSize: 12.5, flex: 1 }} numberOfLines={1}>
              {url}
            </Text>
          </View>
          <View style={styles.qrButtons}>
            <View style={styles.qrButtonCell}>
              <Btn title="QR-код" size="s" onPress={onQr} />
            </View>
            <View style={styles.qrButtonCell}>
              <Btn title="Скопировать" size="s" variant="ghost" onPress={onCopy} />
            </View>
            <View style={styles.qrButtonCell}>
              <Btn title="Поделиться" size="s" variant="ghost" onPress={onShare} />
            </View>
          </View>
        </GlassCard>
      </MotiView>
    </>
  );
}

const styles = StyleSheet.create({
  center: { width: '100%', maxWidth: 720, alignSelf: 'center' },
  body: { paddingHorizontal: 12 },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, marginTop: 12 },
  dangerRow: { flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 12, minHeight: 46 },
  linkBox: { flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderRadius: 11, paddingHorizontal: 10, paddingVertical: 9, marginTop: 12 },
  qrButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  qrButtonCell: { flex: 1, minWidth: 104 },
});
