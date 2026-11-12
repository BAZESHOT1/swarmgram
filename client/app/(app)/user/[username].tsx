import React from 'react';
import { Platform, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
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
import { ProfileHero, birthdayLabel } from '../../../src/components/profile/ProfileHero';
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
  useUpdateProfile,
  humanError,
} from '../../../src/data/queries';
import * as api from '../../../src/data/api';
import type { UserProfile } from '../../../src/data/api';
import { useStore } from '../../../src/state/useStore';
import { formatBytes } from '../../../src/components/settings/SettingsWidgets';

type EditField = 'displayName' | 'status' | 'bio' | 'location' | 'birthday';

const EDIT_LABELS: Record<EditField, string> = {
  displayName: 'Имя',
  status: 'Статус',
  bio: 'О себе',
  location: 'Адрес',
  birthday: 'День рождения',
};

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
  const updateProfile = useUpdateProfile();

  const [refreshing, setRefreshing] = React.useState(false);
  const [reportOpen, setReportOpen] = React.useState(false);
  const [blockOpen, setBlockOpen] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [qrOpen, setQrOpen] = React.useState(false);
  const [creating, setCreating] = React.useState<'' | 'server' | 'e2e'>('');
  const [editField, setEditField] = React.useState<EditField | null>(null);
  const [editValue, setEditValue] = React.useState('');

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
  if (!profile) {
    return (
      <View style={{ flex: 1, paddingTop: 44 }}>
        <EmptyState
          title={profileQuery.isError ? 'Профиль недоступен офлайн' : 'Пользователь не найден'}
          subtitle={
            profileQuery.isError
              ? 'Нет связи с сервером, а этот профиль ещё не сохранён на устройстве.'
              : 'Возможно, аккаунт удалён или username изменился.'
          }
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

  const startEdit = (field: EditField, value: string) => {
    setEditField(field);
    setEditValue(value ?? '');
  };

  const saveEdit = async () => {
    if (!editField) return;
    const value = editValue.trim();
    try {
      const patch =
        editField === 'birthday'
          ? { birthday: value || null }
          : { [editField]: value };
      await updateProfile.mutateAsync(patch as never);
      pushToast({ kind: 'success', message: 'Профиль обновлён' });
      setEditField(null);
    } catch (e) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  };

  return (
    <>
      <ScrollView
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 120 }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refreshProfile()}
            tintColor="#FFFFFF"
            colors={[theme.accent]}
          />
        }
      >
        <BrightProfile
          profile={profile}
          isSelf={isSelf}
          title={title}
          avatar={avatar}
          banner={banner}
          roleLabel={roleLabel}
          status={status}
          statusText={statusText}
          online={isSelf ? true : profile.online}
          bio={profile.bio}
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
          forceMobile={compactParam === '1'}
          onEdit={startEdit}
        />
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

      {/* Inline-редактирование полей профиля. */}
      <Modal visible={Boolean(editField)} transparent animationType="fade" onRequestClose={() => setEditField(null)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 20 }} onPress={() => setEditField(null)}>
          <Pressable
            onPress={(event) => event.stopPropagation()}
            style={{ backgroundColor: theme.surfaceElevated, borderRadius: 18, borderWidth: 1, borderColor: theme.line, padding: 16 }}
          >
            <Text style={{ color: theme.textPrimary, fontSize: 17, fontWeight: '800' }}>
              {editField ? EDIT_LABELS[editField] : ''}
            </Text>
            <TextInput
              value={editValue}
              onChangeText={setEditValue}
              autoFocus
              multiline={editField === 'bio'}
              placeholder={editField === 'birthday' ? 'ГГГГ-ММ-ДД' : editField === 'status' ? 'Короткий статус' : ''}
              placeholderTextColor={theme.textDisabled}
              keyboardType={editField === 'birthday' ? 'numbers-and-punctuation' : 'default'}
              style={{
                marginTop: 12,
                minHeight: editField === 'bio' ? 110 : 46,
                maxHeight: 220,
                borderWidth: 1,
                borderColor: theme.line,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 10,
                color: theme.textPrimary,
                backgroundColor: theme.surface,
                textAlignVertical: editField === 'bio' ? 'top' : 'center',
              }}
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
              <View style={{ flex: 1 }}>
                <Btn title="Отмена" size="s" variant="ghost" onPress={() => setEditField(null)} />
              </View>
              <View style={{ flex: 1 }}>
                <Btn title="Сохранить" size="s" loading={updateProfile.isPending} onPress={() => void saveEdit()} />
              </View>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
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

/* ---------------------------------------------------------- яркий профиль -- */

function BSection({
  title,
  icon,
  children,
  right,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.bCard,
        {
          backgroundColor: theme.dark ? '#111821' : '#FFFFFF',
          borderColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(16,24,40,0.08)',
        },
        theme.dark ? null : { shadowColor: '#0A1628' },
      ]}
    >
      <View style={styles.bCardHead}>
        <View style={[styles.bCardIcon, { backgroundColor: theme.accentSoft }]}>
          <Ionicons name={icon} size={15} color={theme.accent} />
        </View>
        <Text style={{ color: theme.textPrimary, fontSize: 15, fontWeight: '800', flex: 1 }}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function BrightProfile({
  profile,
  isSelf,
  title,
  avatar,
  banner,
  roleLabel,
  status,
  statusText,
  online,
  bio,
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
  forceMobile,
  onEdit,
}: {
  profile: UserProfile;
  isSelf: boolean;
  title: string;
  avatar?: UserProfile['avatar'];
  banner?: string;
  roleLabel: string;
  status: string;
  statusText: string;
  online: boolean;
  bio: string;
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
  forceMobile?: boolean;
  onEdit?: (field: EditField, value: string) => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const desktop = width >= 900 && !forceMobile;
  const badges = buildProfileBadges(badgeFacts, theme);
  const [badgesOpen, setBadgesOpen] = React.useState(false);

  const primary = actions[0] ?? null;
  const secondary = actions.slice(1);

  const modulesTotal = Number(profile.modulesTotal ?? 0);
  const modulesOnline = Number(profile.modulesOnline ?? 0);
  const nodesTotal = Number(profile.nodesTotal ?? 0);
  const nodesOnline = Number(profile.nodesOnline ?? 0);
  const contribution = Number(profile.nodeCapacityBytes ?? 0);
  const hasActivity = modulesTotal > 0 || nodesTotal > 0 || nodesOnline > 0 || contribution > 0;

  const identity = (
    <View style={{ alignItems: desktop ? 'flex-start' : 'center' }}>
      <Avatar
        name={title || '?'}
        size={desktop ? 132 : 112}
        radius={10}
        avatar={avatar ?? null}
        nodeOnline={nodeOnline}
        moduleOnline={moduleOnline}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: desktop ? 'flex-start' : 'center' }}>
        <Text style={[styles.bName, { marginTop: 0, textAlign: desktop ? 'left' : 'center' }]} numberOfLines={2}>
          {title || 'Пользователь'}
        </Text>
        {isSelf && onEdit ? (
          <Pressable onPress={() => onEdit('displayName', title)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Изменить имя">
            <Ionicons name="pencil-outline" size={16} color="rgba(255,255,255,0.75)" />
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.bUsername} numberOfLines={1}>
        @{profile.username}
      </Text>
      {roleLabel ? (
        <View style={styles.bRolePill}>
          <Ionicons name="shield-checkmark-outline" size={11} color="#FFFFFF" />
          <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700' }}>{roleLabel}</Text>
        </View>
      ) : null}
      <View style={styles.bStatusRow}>
        <View style={[styles.bStatusDot, { backgroundColor: online ? theme.success : 'rgba(255,255,255,0.55)' }]} />
        <Text style={styles.bStatusText} numberOfLines={1}>
          {statusText}
        </Text>
      </View>

      {primary ? (
        <Pressable
          onPress={primary.onPress}
          disabled={primary.disabled || primary.loading}
          accessibilityRole="button"
          accessibilityLabel={primary.label}
          style={({ pressed }) => ({
            marginTop: 14,
            width: desktop ? '100%' : '100%',
            minHeight: 44,
            borderRadius: 14,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: 7,
            backgroundColor: primary.danger ? theme.danger : theme.accent,
            opacity: primary.disabled ? 0.5 : pressed ? 0.86 : 1,
          })}
        >
          <Ionicons name={primary.loading ? 'hourglass-outline' : primary.icon} size={17} color={primary.danger ? '#FFFFFF' : theme.onAccent} />
          <Text style={{ color: primary.danger ? '#FFFFFF' : theme.onAccent, fontSize: 14, fontWeight: '800' }}>
            {primary.loading ? 'Подождите…' : primary.label}
          </Text>
        </Pressable>
      ) : null}

      {secondary.length ? (
        <View style={[styles.bSecondary, desktop ? { justifyContent: 'flex-start' } : null]}>
          {secondary.map((action) => (
            <PressableScale
              key={action.key}
              onPress={action.onPress}
              disabled={action.disabled || action.loading}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={[
                styles.bSecondaryBtn,
                {
                  backgroundColor: 'rgba(10,14,20,0.34)',
                  borderColor: 'rgba(255,255,255,0.20)',
                  opacity: action.disabled ? 0.5 : 1,
                },
              ]}
            >
              <Ionicons
                name={action.loading ? 'hourglass-outline' : action.icon}
                size={15}
                color={action.danger ? '#FFB4B8' : '#FFFFFF'}
              />
              <Text style={{ color: action.danger ? '#FFB4B8' : '#FFFFFF', fontSize: 11.5, fontWeight: '600' }} numberOfLines={1}>
                {action.label}
              </Text>
            </PressableScale>
          ))}
        </View>
      ) : null}
    </View>
  );

  const contacts = (
    <BSection title="Контакты" icon="person-circle-outline">
      <PressableScale
        onPress={onCopyUsername}
        accessibilityRole="button"
        accessibilityLabel={`Скопировать username @${profile.username}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 4 }}
      >
        <Text style={{ color: theme.accent, fontSize: 15, fontWeight: '700', flex: 1 }} numberOfLines={1}>
          @{profile.username}
        </Text>
        <Ionicons name="copy-outline" size={14} color={theme.textSecondary} />
      </PressableScale>
      <View style={{ height: 1, backgroundColor: theme.line, marginVertical: 8 }} />
      <View style={{ gap: 9 }}>
        {location ? (
          <View style={styles.bInfoRow}>
            <Ionicons name="location-outline" size={16} color={theme.textSecondary} />
            <Text style={{ color: theme.textSecondary, fontSize: 13.5, flex: 1 }}>{location}</Text>
            {isSelf && onEdit ? (
              <Pressable onPress={() => onEdit('location', location)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Изменить адрес">
                <Ionicons name="pencil-outline" size={14} color={theme.accent} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {birthday ? (
          <View style={styles.bInfoRow}>
            <Ionicons name="gift-outline" size={16} color={theme.textSecondary} />
            <Text style={{ color: theme.textSecondary, fontSize: 13.5, flex: 1 }}>{birthdayLabel(birthday)}</Text>
            {isSelf && onEdit ? (
              <Pressable onPress={() => onEdit('birthday', birthday ?? '')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Изменить день рождения">
                <Ionicons name="pencil-outline" size={14} color={theme.accent} />
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {isSelf && onEdit && !location ? (
          <Pressable onPress={() => onEdit('location', '')} accessibilityRole="button" accessibilityLabel="Добавить адрес" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}>
            <Ionicons name="add-circle-outline" size={16} color={theme.accent} />
            <Text style={{ color: theme.accent, fontSize: 13 }}>Добавить адрес</Text>
          </Pressable>
        ) : null}
        {isSelf && onEdit && !birthday ? (
          <Pressable onPress={() => onEdit('birthday', '')} accessibilityRole="button" accessibilityLabel="Добавить день рождения" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}>
            <Ionicons name="add-circle-outline" size={16} color={theme.accent} />
            <Text style={{ color: theme.accent, fontSize: 13 }}>Добавить день рождения</Text>
          </Pressable>
        ) : null}
        <PressableScale
          onPress={onQr}
          accessibilityRole="button"
          accessibilityLabel="QR-код профиля"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}
        >
          <Ionicons name="qr-code-outline" size={16} color={theme.accent} />
          <Text style={{ color: theme.accent, fontSize: 13.5, fontWeight: '600', flex: 1 }}>QR-код и ссылка</Text>
          <Ionicons name="chevron-forward" size={14} color={theme.textDisabled} />
        </PressableScale>
        <PressableScale
          onPress={onShare}
          accessibilityRole="button"
          accessibilityLabel="Поделиться профилем"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 }}
        >
          <Ionicons name="share-social-outline" size={16} color={theme.accent} />
          <Text style={{ color: theme.accent, fontSize: 13.5, fontWeight: '600', flex: 1 }}>Поделиться профилем</Text>
        </PressableScale>
      </View>
    </BSection>
  );

  const activity = hasActivity ? (
    <BSection title="Активность" icon="pulse-outline">
      <View style={{ gap: 10 }}>
        {modulesTotal > 0 ? (
          <View style={styles.bStatRow}>
            <Ionicons name="hardware-chip-outline" size={17} color={theme.accent} />
            <Text style={{ color: theme.textPrimary, fontSize: 13.5, flex: 1 }}>Модули</Text>
            <Text style={{ color: theme.textSecondary, fontSize: 13 }}>
              {modulesTotal} · онлайн {modulesOnline}
            </Text>
          </View>
        ) : null}
        {nodesTotal > 0 || nodesOnline > 0 ? (
          <View style={styles.bStatRow}>
            <Ionicons name="server-outline" size={17} color={theme.success} />
            <Text style={{ color: theme.textPrimary, fontSize: 13.5, flex: 1 }}>Узлы сети</Text>
            <Text style={{ color: theme.textSecondary, fontSize: 13 }}>
              {nodesOnline} из {nodesTotal} онлайн
            </Text>
          </View>
        ) : null}
        {contribution > 0 ? (
          <View style={styles.bStatRow}>
            <Ionicons name="cloud-upload-outline" size={17} color={theme.warning} />
            <Text style={{ color: theme.textPrimary, fontSize: 13.5, flex: 1 }}>Вклад в сеть</Text>
            <Text style={{ color: theme.textSecondary, fontSize: 13 }}>{formatBytes(contribution)}</Text>
          </View>
        ) : null}
      </View>
    </BSection>
  ) : null;

  const achievements = badges.length ? (
    <BSection
      title="Достижения"
      icon="trophy-outline"
      right={
        <Pressable
          onPress={() => setBadgesOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={badgesOpen ? 'Свернуть достижения' : 'Показать достижения'}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
        >
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }}>{badgesOpen ? 'Свернуть' : `Показать (${badges.length})`}</Text>
          <Ionicons name={badgesOpen ? 'chevron-up' : 'chevron-down'} size={14} color={theme.accent} />
        </Pressable>
      }
    >
      {badgesOpen ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          {badges.map((badge) => (
            <View
              key={badge.key}
              style={[
                styles.bBadge,
                {
                  borderColor: theme.line,
                  backgroundColor: theme.dark ? 'rgba(255,255,255,0.04)' : 'rgba(16,24,40,0.03)',
                },
              ]}
            >
              <View style={[styles.bBadgeIcon, { backgroundColor: badge.soft, borderColor: badge.color }]}>
                <Ionicons name={badge.icon} size={15} color={badge.color} />
              </View>
              <View style={{ minWidth: 0, flex: 1 }}>
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
      ) : null}
    </BSection>
  ) : null;

  const shared = !isSelf && profile.sharedChats.length ? (
    <BSection title="Общие чаты" icon="chatbubbles-outline" right={<Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>{profile.sharedChats.length}</Text>}>
      <View style={{ gap: 2 }}>
        {profile.sharedChats.slice(0, 8).map((chat) => (
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
    </BSection>
  ) : null;

  return (
    <View style={[styles.bPage, bannerBackground(banner)]}>
      <View pointerEvents="none" style={styles.bOverlay} />
      <View style={[styles.bInner, desktop ? styles.bInnerDesktop : null]}>
        <PressableScale
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Назад"
          hitSlop={10}
          style={styles.bBack}
        >
          <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
        </PressableScale>

        {blockedByMe ? (
          <View style={[styles.bNotice, { backgroundColor: 'rgba(180,32,42,0.35)', borderColor: 'rgba(255,180,184,0.4)' }]}>
            <Ionicons name="ban" size={16} color="#FFD0D3" />
            <Text style={styles.bNoticeText}>Вы заблокировали этого пользователя. Переписка недоступна.</Text>
          </View>
        ) : null}
        {!blockedByMe && blockedMe ? (
          <View style={[styles.bNotice, { backgroundColor: 'rgba(150,110,0,0.35)', borderColor: 'rgba(255,220,150,0.4)' }]}>
            <Ionicons name="lock-closed-outline" size={16} color="#FFE2B0" />
            <Text style={styles.bNoticeText}>Пользователь ограничил возможность писать ему.</Text>
          </View>
        ) : null}

        {desktop ? (
          <View style={styles.bDesktopRow}>
            <View style={styles.bDesktopLeft}>{identity}</View>
            <View style={styles.bDesktopRight}>
              <BSection
                title="О себе"
                icon="reader-outline"
                right={
                  isSelf && onEdit ? (
                    <Pressable onPress={() => onEdit('bio', bio)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Изменить описание">
                      <Ionicons name="pencil-outline" size={15} color={theme.accent} />
                    </Pressable>
                  ) : undefined
                }
              >
                {bio ? (
                  <Text style={{ color: theme.textPrimary, fontSize: 14, lineHeight: 21 }}>{bio}</Text>
                ) : (
                  <Text style={{ color: theme.textDisabled, fontSize: 13, fontStyle: 'italic' }}>
                    {isSelf ? 'Добавьте пару слов о себе в редактировании профиля.' : 'Пользователь пока ничего не рассказал о себе.'}
                  </Text>
                )}
                {status ? (
                  <View style={{ marginTop: 10, paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: theme.accent, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18, flex: 1 }}>{status}</Text>
                    {isSelf && onEdit ? (
                      <Pressable onPress={() => onEdit('status', status)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Изменить статус">
                        <Ionicons name="pencil-outline" size={14} color={theme.accent} />
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </BSection>
              {contacts}
              {activity}
              {achievements}
              {shared}
            </View>
          </View>
        ) : (
          <View style={styles.bMobile}>
            <View style={{ paddingTop: 18, paddingBottom: 16 }}>{identity}</View>
            <BSection
              title="О себе"
              icon="reader-outline"
              right={
                isSelf && onEdit ? (
                  <Pressable onPress={() => onEdit('bio', bio)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Изменить описание">
                    <Ionicons name="pencil-outline" size={15} color={theme.accent} />
                  </Pressable>
                ) : undefined
              }
            >
              {bio ? (
                <Text style={{ color: theme.textPrimary, fontSize: 14, lineHeight: 21 }}>{bio}</Text>
              ) : (
                <Text style={{ color: theme.textDisabled, fontSize: 13, fontStyle: 'italic' }}>
                  {isSelf ? 'Добавьте пару слов о себе в редактировании профиля.' : 'Пользователь пока ничего не рассказал о себе.'}
                </Text>
              )}
              {status ? (
                <View style={{ marginTop: 10, paddingLeft: 10, borderLeftWidth: 3, borderLeftColor: theme.accent, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ color: theme.textSecondary, fontSize: 12.5, lineHeight: 18, flex: 1 }}>{status}</Text>
                  {isSelf && onEdit ? (
                    <Pressable onPress={() => onEdit('status', status)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Изменить статус">
                      <Ionicons name="pencil-outline" size={14} color={theme.accent} />
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </BSection>
            {contacts}
            {activity}
            {achievements}
            {shared}
          </View>
        )}
      </View>
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
  bPage: { flexGrow: 1, minHeight: '100%' },
  bOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,10,18,0.30)' },
  bInner: { width: '100%', maxWidth: 1120, alignSelf: 'center', paddingHorizontal: 14, paddingTop: 46, paddingBottom: 24 },
  bInnerDesktop: { paddingHorizontal: 24, paddingTop: 56 },
  bBack: { position: 'absolute', top: 8, left: 14, width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(10,14,20,0.42)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)', zIndex: 5 },
  bDesktopRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 22 },
  bDesktopLeft: { width: 350, flexShrink: 0 },
  bDesktopRight: { flex: 1, minWidth: 0, gap: 12 },
  bMobile: { gap: 12 },
  bName: { color: '#FFFFFF', fontSize: 26, fontWeight: '800', marginTop: 12, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.35)', textShadowRadius: 6 },
  bUsername: { color: 'rgba(255,255,255,0.72)', fontSize: 13.5, marginTop: 2, textAlign: 'center' },
  bRolePill: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 7, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)' },
  bStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  bStatusDot: { width: 7, height: 7, borderRadius: 4 },
  bStatusText: { color: 'rgba(255,255,255,0.9)', fontSize: 12.5, fontWeight: '600' },
  bSecondary: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10, justifyContent: 'center' },
  bSecondaryBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6, maxWidth: '48%' },
  bCard: { borderRadius: 20, borderWidth: 1, padding: 16, gap: 10, shadowOpacity: 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
  bCardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bCardIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  bInfoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bStatRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  bBadge: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 8, flexGrow: 1, flexBasis: '46%', minWidth: 150 },
  bBadgeIcon: { width: 28, height: 28, borderRadius: 9, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  bNotice: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 12 },
  bNoticeText: { color: '#FFFFFF', fontSize: 12.5, flex: 1, fontWeight: '600' },
});
