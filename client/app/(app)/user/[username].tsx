import React from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../../../src/theme/useTheme';
import { motion } from '../../../src/theme/motion';
import { EmptyState } from '../../../src/components/EmptyState';
import { ProfileSkeleton } from '../../../src/components/skeletons/PageSkeletons';
import { useReducedMotion } from '../../../src/components/useReducedMotion';
import { PressableScale } from '../../../src/components/profile/PressableScale';
import { Avatar } from '../../../src/components/Avatar';
import { ProfileHero } from '../../../src/components/profile/ProfileHero';
import { ProfileActions, type ProfileAction } from '../../../src/components/profile/ProfileActions';
import { ProfileLinks } from '../../../src/components/profile/ProfileLinks';
import { ProfileBadges, buildProfileBadges, type ProfileBadgeFacts } from '../../../src/components/profile/ProfileBadges';
import { bannerBackground, bannerPreset } from '../../../src/components/profile/banner';
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
import { formatBytes } from '../../../src/components/settings/SettingsWidgets';

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
  const { width } = useWindowDimensions();
  const compactParam = String((params as { compact?: string | string[] }).compact ?? '');
  /** Мобильная/нативная вёрстка профиля: карточка без hero-контейнера. */
  const compact = Platform.OS !== 'web' || width < 720 || compactParam === '1';
  const mutedUsers = useStore((s) => s.mutedUsers);
  const toggleMutedUser = useStore((s) => s.toggleMutedUser);

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

  const roleLabel =
    profile.role === 'admin' ? 'Администратор' : profile.role === 'moderator' ? 'Модератор' : '';
  const userMuted = mutedUsers.includes(profile.username.toLowerCase());

  /** Действия для мобильного профиля — по требованию: без лишних плиток. */
  const mobileActions: ProfileAction[] = [];
  if (isSelf) {
    mobileActions.push({ key: 'edit', icon: 'pencil-outline', label: 'Редактировать', onPress: () => router.push(`/user/${profile.username}/edit` as never) });
    mobileActions.push({ key: 'qr', icon: 'qr-code-outline', label: 'QR-код', onPress: () => setQrOpen(true) });
    mobileActions.push({ key: 'share', icon: 'share-social-outline', label: 'Поделиться', onPress: () => void share() });
  } else {
    if (canChat) {
      mobileActions.push({
        key: 'write',
        icon: 'paper-plane-outline',
        label: 'Написать',
        onPress: () => void openChat('server'),
        loading: creating === 'server',
      });
      mobileActions.push({
        key: 'invite',
        icon: 'people-outline',
        label: 'В группу или канал',
        onPress: () => setInviteOpen(true),
      });
    }
    mobileActions.push({
      key: 'mute',
      icon: userMuted ? 'notifications-outline' : 'notifications-off-outline',
      label: userMuted ? 'Включить уведомления' : 'Выключить уведомления',
      onPress: () => {
        toggleMutedUser(profile.username);
        pushToast({
          kind: 'success',
          message: userMuted ? 'Уведомления от пользователя включены' : 'Уведомления от пользователя выключены',
        });
      },
    });
    mobileActions.push({
      key: 'block',
      icon: blockedByMe ? 'lock-open-outline' : 'ban-outline',
      label: blockedByMe ? 'Разблокировать' : 'Заблокировать',
      danger: !blockedByMe,
      onPress: () => setBlockOpen(true),
    });
    mobileActions.push({
      key: 'report',
      icon: 'flag-outline',
      label: 'Пожаловаться',
      danger: true,
      onPress: () => setReportOpen(true),
    });
  }

  return (
    <>
      <ScrollView
        contentContainerStyle={
          compact
            ? { paddingBottom: 120, flexGrow: 1, backgroundColor: bannerPreset(banner).colors[1] }
            : { paddingBottom: 120 }
        }
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
          {compact ? (
            <MobileProfile
              profile={profile}
              isSelf={isSelf}
              title={title}
              username={profile.username}
              avatar={avatar}
              banner={banner}
              roleLabel={roleLabel}
              status={status}
              statusText={statusText}
              online={isSelf ? true : profile.online}
              bio={profile.bio}
              links={links}
              location={location}
              birthday={birthday}
              badgeFacts={badgeFacts}
              actions={mobileActions}
              blockedByMe={blockedByMe}
              blockedMe={blockedMe}
              nodeOnline={nodeOnline}
              moduleOnline={moduleOnline}
              onBack={() => router.back()}
              onQr={() => setQrOpen(true)}
              onShare={() => void share()}
              onCopyUsername={() => {
                void copyText(profile.username)
                  .then(() => pushToast({ kind: 'success', message: 'Username скопирован' }))
                  .catch(() => pushToast({ kind: 'error', message: 'Не удалось скопировать username' }));
              }}
              onOpenChat={(id) => router.push(`/chat/${id}` as never)}
            />
          ) : (
          <>
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
          </>
          )}
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

/* ------------------------------------------------------ мобильный профиль -- */

function MobileProfile({
  profile,
  isSelf,
  title,
  username,
  avatar,
  banner,
  roleLabel,
  status,
  statusText,
  online,
  bio,
  links,
  location,
  birthday,
  badgeFacts,
  actions,
  blockedByMe,
  blockedMe,
  nodeOnline,
  moduleOnline,
  onBack,
  onQr,
  onShare,
  onCopyUsername,
  onOpenChat,
}: {
  profile: UserProfile;
  isSelf: boolean;
  title: string;
  username: string;
  avatar?: UserProfile['avatar'];
  banner?: string;
  roleLabel: string;
  status: string;
  statusText: string;
  online: boolean;
  bio: string;
  links?: { label: string; url: string }[];
  location: string;
  birthday?: string | null;
  badgeFacts: ProfileBadgeFacts;
  actions: ProfileAction[];
  blockedByMe: boolean;
  blockedMe: boolean;
  nodeOnline: boolean;
  moduleOnline: boolean;
  onBack: () => void;
  onQr: () => void;
  onShare: () => void;
  onCopyUsername: () => void;
  onOpenChat: (id: string) => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const preset = bannerPreset(banner);
  const badges = buildProfileBadges(badgeFacts, theme);

  const modulesTotal = Number(profile.modulesTotal ?? 0);
  const modulesOnline = Number(profile.modulesOnline ?? 0);
  const nodesTotal = Number(profile.nodesTotal ?? 0);
  const nodesOnline = Number(profile.nodesOnline ?? 0);
  const contribution = Number(profile.nodeCapacityBytes ?? 0);

  return (
    <View style={[styles.mRoot, bannerBackground(banner)]}>
      {/* Верхний блок: фон профиля на всей странице, без карточки/бокса. */}
      <View style={styles.mHeader}>
        {Platform.OS !== 'web' ? (
          <>
            <View pointerEvents="none" style={[styles.mBlob, { backgroundColor: preset.colors[0], opacity: 0.45 }]} />
            <View pointerEvents="none" style={[styles.mBlob2, { backgroundColor: preset.colors[2], opacity: 0.55 }]} />
          </>
        ) : null}

        <PressableScale
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Назад"
          hitSlop={10}
          style={[styles.mBack, { backgroundColor: 'rgba(10,14,20,0.42)', borderColor: 'rgba(255,255,255,0.22)' }]}
        >
          <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
        </PressableScale>

        <MotiView
          from={reduced ? { opacity: 0.3 } : { opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
          style={styles.mIdentity}
        >
          <Avatar
            name={title || '?'}
            size={104}
            avatar={avatar ?? null}
            radius={10}
            nodeOnline={nodeOnline}
            moduleOnline={moduleOnline}
          />
          <Text style={styles.mName} numberOfLines={2}>
            {title || 'Пользователь'}
          </Text>
          {roleLabel ? (
            <View style={styles.mRole}>
              <Ionicons name="shield-checkmark-outline" size={11} color="#FFFFFF" />
              <Text style={styles.mRoleText}>{roleLabel}</Text>
            </View>
          ) : null}
          <View style={styles.mStatusRow}>
            <View style={[styles.mStatusDot, { backgroundColor: online ? theme.success : 'rgba(255,255,255,0.55)' }]} />
            <Text style={styles.mStatusText} numberOfLines={1}>
              {statusText}
            </Text>
          </View>
        </MotiView>

        {actions.length ? (
          <View style={styles.mActions}>
            {actions.map((action) => (
              <PressableScale
                key={action.key}
                onPress={action.onPress}
                disabled={action.disabled || action.loading}
                accessibilityRole="button"
                accessibilityLabel={action.label}
                style={[
                  styles.mAction,
                  {
                    backgroundColor: action.danger ? 'rgba(180,32,42,0.34)' : 'rgba(10,14,20,0.30)',
                    borderColor: 'rgba(255,255,255,0.20)',
                    opacity: action.disabled ? 0.5 : 1,
                  },
                ]}
              >
                <Ionicons
                  name={action.loading ? 'hourglass-outline' : action.icon}
                  size={16}
                  color={action.danger ? '#FFB4B8' : '#FFFFFF'}
                />
                <Text style={[styles.mActionText, action.danger ? { color: '#FFB4B8' } : null]} numberOfLines={1}>
                  {action.loading ? 'Подождите…' : action.label}
                </Text>
              </PressableScale>
            ))}
          </View>
        ) : null}
      </View>

      {blockedByMe ? (
        <View style={[styles.notice, { backgroundColor: theme.dangerSoft, borderColor: theme.danger, marginHorizontal: 12 }]}>
          <Ionicons name="ban" size={17} color={theme.danger} />
          <Text style={{ color: theme.danger, fontSize: 12.5, flex: 1, fontWeight: '600' }}>
            Вы заблокировали этого пользователя. Переписка недоступна.
          </Text>
        </View>
      ) : null}
      {!blockedByMe && blockedMe ? (
        <View style={[styles.notice, { backgroundColor: theme.warningSoft, borderColor: theme.warning, marginHorizontal: 12 }]}>
          <Ionicons name="lock-closed-outline" size={17} color={theme.warning} />
          <Text style={{ color: theme.warning, fontSize: 12.5, flex: 1, fontWeight: '600' }}>
            Пользователь ограничил возможность писать ему.
          </Text>
        </View>
      ) : null}

      {/* Непрозрачная карточка с подробной информацией. */}
      <View
        style={[
          styles.mCard,
          {
            backgroundColor: theme.dark ? '#161C26' : '#FFFFFF',
            borderColor: theme.dark ? 'rgba(255,255,255,0.07)' : 'rgba(16,24,40,0.08)',
          },
        ]}
      >
        {status ? (
          <View style={{ marginBottom: 12 }}>
            <Text style={[styles.mLabel, { color: theme.textDisabled }]}>СТАТУС</Text>
            <Text style={{ color: theme.textPrimary, fontSize: 14, lineHeight: 20 }}>{status}</Text>
          </View>
        ) : null}

        <View style={styles.mUsernameRow}>
          <PressableScale
            onPress={onCopyUsername}
            accessibilityRole="button"
            accessibilityLabel={`Скопировать username @${username}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}
          >
            <Text style={{ color: theme.accent, fontSize: 16, fontWeight: '700' }} numberOfLines={1}>
              @{username}
            </Text>
            <Ionicons name="copy-outline" size={14} color={theme.textSecondary} />
          </PressableScale>
          <PressableScale
            onPress={onQr}
            accessibilityRole="button"
            accessibilityLabel="QR-код профиля"
            style={[styles.mQrBtn, { borderColor: theme.line, backgroundColor: theme.surfacePressed }]}
          >
            <Ionicons name="qr-code-outline" size={17} color={theme.textPrimary} />
          </PressableScale>
        </View>

        {location || birthday ? (
          <View style={{ gap: 8, marginTop: 12 }}>
            {location ? (
              <View style={styles.mMetaRow}>
                <Ionicons name="location-outline" size={15} color={theme.textSecondary} />
                <Text style={{ color: theme.textSecondary, fontSize: 13 }}>{location}</Text>
              </View>
            ) : null}
            {birthday ? (
              <View style={styles.mMetaRow}>
                <Ionicons name="gift-outline" size={15} color={theme.textSecondary} />
                <Text style={{ color: theme.textSecondary, fontSize: 13 }}>{birthdayLabel(birthday)}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={styles.mDivider}>
          <View style={[styles.mLine, { backgroundColor: theme.line }]} />
        </View>

        <Text style={[styles.mLabel, { color: theme.textDisabled }]}>О СЕБЕ</Text>
        {bio ? (
          <Text style={{ color: theme.textPrimary, fontSize: 14, lineHeight: 21 }}>{bio}</Text>
        ) : (
          <Text style={{ color: theme.textDisabled, fontSize: 13, fontStyle: 'italic' }}>
            {isSelf ? 'Добавьте пару слов о себе в редактировании профиля.' : 'Пользователь пока ничего не рассказал о себе.'}
          </Text>
        )}

        {links?.length ? (
          <View style={{ gap: 6, marginTop: 10 }}>
            {links.slice(0, 4).map((link) => (
              <Text key={`${link.label}:${link.url}`} style={{ color: theme.accent, fontSize: 12.5 }} numberOfLines={1}>
                {link.label || link.url}
              </Text>
            ))}
          </View>
        ) : null}

        {modulesTotal > 0 ? (
          <>
            <View style={styles.mDivider}>
              <View style={[styles.mLine, { backgroundColor: theme.line }]} />
            </View>
            <View style={styles.mStatRow}>
              <View style={[styles.mStatIcon, { backgroundColor: theme.accentSoft }]}>
                <Ionicons name="hardware-chip-outline" size={16} color={theme.accent} />
              </View>
              <Text style={{ color: theme.textPrimary, fontSize: 13.5, flex: 1 }}>Модули</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 13 }}>
                {modulesTotal} всего · {modulesOnline} онлайн
              </Text>
            </View>
          </>
        ) : null}

        {nodesTotal > 0 || nodesOnline > 0 ? (
          <View style={{ gap: 8, marginTop: modulesTotal > 0 ? 8 : 12 }}>
            <View style={styles.mStatRow}>
              <View style={[styles.mStatIcon, { backgroundColor: theme.successSoft }]}>
                <Ionicons name="server-outline" size={16} color={theme.success} />
              </View>
              <Text style={{ color: theme.textPrimary, fontSize: 13.5, flex: 1 }}>Узлы сети</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 13 }}>
                {nodesOnline} из {nodesTotal} онлайн
              </Text>
            </View>
            {contribution > 0 ? (
              <View style={styles.mStatRow}>
                <View style={[styles.mStatIcon, { backgroundColor: theme.warningSoft }]}>
                  <Ionicons name="cloud-upload-outline" size={16} color={theme.warning} />
                </View>
                <Text style={{ color: theme.textPrimary, fontSize: 13.5, flex: 1 }}>Вклад в сеть</Text>
                <Text style={{ color: theme.textSecondary, fontSize: 13 }}>{formatBytes(contribution)}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {badges.length ? (
          <>
            <View style={styles.mDivider}>
              <View style={[styles.mLine, { backgroundColor: theme.line }]} />
            </View>
            <Text style={[styles.mLabel, { color: theme.textDisabled }]}>ДОСТИЖЕНИЯ</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {badges.map((badge) => (
                <View
                  key={badge.key}
                  style={[
                    styles.mBadge,
                    {
                      borderColor: theme.line,
                      backgroundColor: theme.dark ? 'rgba(255,255,255,0.04)' : 'rgba(16,24,40,0.03)',
                    },
                  ]}
                >
                  <View style={[styles.mBadgeIcon, { backgroundColor: badge.soft, borderColor: badge.color }]}>
                    <Ionicons name={badge.icon} size={15} color={badge.color} />
                  </View>
                  <View style={{ minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '700' }} numberOfLines={1}>
                      {badge.title}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 10.5 }} numberOfLines={1}>
                      {badge.description}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : null}
      </View>

      {!isSelf && profile.sharedChats.length ? (
        <View style={[styles.mCard, { backgroundColor: theme.dark ? '#161C26' : '#FFFFFF', borderColor: theme.dark ? 'rgba(255,255,255,0.07)' : 'rgba(16,24,40,0.08)' }]}>
          <Text style={[styles.mLabel, { color: theme.textDisabled }]}>ОБЩИЕ ЧАТЫ · {profile.sharedChats.length}</Text>
          <View style={{ gap: 4 }}>
            {profile.sharedChats.slice(0, 6).map((chat) => (
              <PressableScale
                key={chat.id}
                onPress={() => onOpenChat(chat.id)}
                accessibilityRole="button"
                accessibilityLabel={`Открыть ${chat.title}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}
              >
                <Ionicons
                  name={chat.type === 'channel' ? 'megaphone-outline' : chat.type === 'group' ? 'people-outline' : 'chatbubble-outline'}
                  size={16}
                  color={theme.textSecondary}
                />
                <Text style={{ color: theme.textPrimary, fontSize: 13.5, flex: 1 }} numberOfLines={1}>
                  {chat.title}
                </Text>
                <Ionicons name="chevron-forward" size={14} color={theme.textDisabled} />
              </PressableScale>
            ))}
          </View>
        </View>
      ) : null}
    </View>
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
  mHeader: { paddingTop: 14, paddingBottom: 18, paddingHorizontal: 14, overflow: 'hidden' },
  mRoot: { width: '100%', flexGrow: 1 },
  mBlob: { position: 'absolute', top: -90, left: -60, width: 260, height: 260, borderRadius: 130 },
  mBlob2: { position: 'absolute', bottom: -120, right: -70, width: 300, height: 300, borderRadius: 150 },
  mBack: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  mIdentity: { alignItems: 'center', marginTop: 10 },
  mName: { color: '#FFFFFF', fontSize: 23, fontWeight: '800', marginTop: 10, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.35)', textShadowRadius: 6 },
  mRole: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)' },
  mRoleText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  mStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7 },
  mStatusDot: { width: 7, height: 7, borderRadius: 4 },
  mStatusText: { color: 'rgba(255,255,255,0.88)', fontSize: 12.5, fontWeight: '600' },
  mActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 7, marginTop: 14 },
  mAction: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 7 },
  mActionText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
  mCard: { marginHorizontal: 12, marginTop: 12, borderRadius: 16, borderWidth: 1, padding: 16 },
  mLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.6, marginBottom: 6 },
  mUsernameRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mQrBtn: { width: 38, height: 38, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  mMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  mDivider: { marginVertical: 12 },
  mLine: { height: StyleSheet.hairlineWidth },
  mStatRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  mStatIcon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  mBadge: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 8, flexGrow: 1, flexBasis: '46%', minWidth: 140 },
  mBadgeIcon: { width: 28, height: 28, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
