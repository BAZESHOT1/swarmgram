/**
 * Страница входа по пригласительной ссылке `/join/[token]`.
 *
 * Показывает публичную стеклянную карточку чата, тип видимости, описание и
 * число участников. Для закрытых чатов отправляет заявку, для публичных и
 * частных — вступает сразу. После успеха открывает чат.
 */
import React from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../src/theme/useTheme';
import { motion } from '../../src/theme/motion';
import { useReducedMotion } from '../../src/components/useReducedMotion';
import { PressableScale } from '../../src/components/profile/PressableScale';
import { GlassCard } from '../../src/components/profile/Glass';
import { Avatar } from '../../src/components/Avatar';
import { Btn } from '../../src/components/Btn';
import { SkeletonBlock, SkeletonCircle } from '../../src/components/skeletons/Skeleton';
import { useStore } from '../../src/state/useStore';
import {
  joinByInvite,
  manageActions,
  manageError,
  normalizePreview,
  useInvitePreviewSafe,
  type InvitePreviewData,
} from '../../src/components/chatinfo/ManageData';
import {
  normalizeVisibility,
  visibilityLabel,
} from '../../src/components/chatinfo/ManageTypes';

const VIS_META: Record<
  'public' | 'closed' | 'private',
  { icon: 'globe-outline' | 'shield-half-outline' | 'key-outline'; text: string }
> = {
  public: { icon: 'globe-outline', text: 'Публичный чат' },
  closed: { icon: 'shield-half-outline', text: 'Закрытый чат' },
  private: { icon: 'key-outline', text: 'Частный чат' },
};

export default function JoinByInviteScreen() {
  const theme = useTheme();
  const router = useRouter();
  const reduced = useReducedMotion();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = React.useMemo(() => {
    try {
      return decodeURIComponent(String(rawToken ?? ''));
    } catch {
      return String(rawToken ?? '');
    }
  }, [rawToken]);

  const session = useStore((s) => s.session);
  const pushToast = useStore((s) => s.pushToast);
  const qc = useQueryClient();

  const hook = useInvitePreviewSafe(token);
  const [manual, setManual] = React.useState<InvitePreviewData | null>(null);
  const [manualLoading, setManualLoading] = React.useState(false);
  const [manualError, setManualError] = React.useState('');
  const [joining, setJoining] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [joined, setJoined] = React.useState('');

  // Если хука превью ещё нет в data-слое — пробуем прямой вызов api.
  React.useEffect(() => {
    if (!token || hook.available) return;
    let alive = true;
    setManualLoading(true);
    setManualError('');
    manageActions
      .previewInvite(token)
      .then((res) => {
        if (!alive) return;
        setManual(normalizePreview(res));
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setManualError(manageError(e));
      })
      .finally(() => {
        if (alive) setManualLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [token, hook.available]);

  const preview = hook.available ? hook.preview : manual;
  const hasData = hook.available ? hook.hasData : Boolean(manual);
  const loading = hook.available ? hook.loading : manualLoading;
  const loadError = hook.available ? hook.error : manualError;

  const visibility = normalizeVisibility(preview?.visibility ?? 'public');
  const meta = VIS_META[visibility];
  const isChannel = preview?.type === 'channel';
  const invalid =
    !token ||
    Boolean(preview?.invalid || preview?.expired) ||
    (!loading && !hasData);
  const banned = Boolean(preview?.banned);
  const alreadyMember = Boolean(preview?.isMember) || Boolean(joined);
  const targetChatId = joined || preview?.chatId || '';

  const roomTitle = preview?.title || (isChannel ? 'Канал' : 'Группа');
  const membersLabel = `${preview?.membersCount ?? 0} ${isChannel ? 'подписчиков' : 'участников'}`;

  function goBack() {
    if (session) router.replace('/chats' as never);
    else router.replace('/login' as never);
  }

  async function join() {
    if (joining || !token) return;
    setJoining(true);
    try {
      const outcome = await joinByInvite(token);
      void qc.invalidateQueries({ queryKey: ['chats'] });
      if (outcome.status === 'pending') {
        setPending(true);
        pushToast({ kind: 'success', message: 'Заявка отправлена, ожидайте одобрения' });
      } else {
        const id = outcome.chatId || targetChatId;
        pushToast({ kind: 'success', message: 'Вы присоединились к чату' });
        if (id) {
          setJoined(id);
          router.replace(`/chat/${id}` as never);
        } else {
          router.replace('/chats' as never);
        }
      }
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setJoining(false);
    }
  }

  function openChat() {
    if (targetChatId) router.replace(`/chat/${targetChatId}` as never);
    else router.replace('/chats' as never);
  }

  function goLogin() {
    const next = `/join/${encodeURIComponent(token)}`;
    // login пока не читает next — передаём параметр и оставляем понятную ссылку.
    router.push(`/login?next=${encodeURIComponent(next)}` as never);
  }

  return (
    <ScrollView
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 16, paddingTop: 52, paddingBottom: 48 }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.center}>
        <View style={styles.topRow}>
          <PressableScale
            onPress={goBack}
            accessibilityRole="button"
            accessibilityLabel="Назад"
            hitSlop={8}
            style={[styles.iconBtn, { backgroundColor: theme.dark ? 'rgba(24,32,46,0.6)' : 'rgba(255,255,255,0.7)' }]}
          >
            <Ionicons name="chevron-back" size={21} color={theme.textPrimary} />
          </PressableScale>
          <Text style={{ color: theme.textSecondary, fontSize: 12.5, fontWeight: '600' }}>Приглашение в Klinto</Text>
        </View>

        <MotiView
          from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 14, scale: 0.98 }}
          animate={{ opacity: 1, translateY: 0, scale: 1 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
        >
          <GlassCard glow padding={20} style={{ alignItems: 'center' }}>
            {loading && !hasData ? (
              <View style={{ alignItems: 'center', gap: 12, width: '100%', paddingVertical: 12 }}>
                <SkeletonCircle size={78} />
                <SkeletonBlock width="58%" height={18} radius={7} />
                <SkeletonBlock width="76%" height={12} radius={6} />
                <SkeletonBlock width="90%" height={12} radius={6} />
                <SkeletonBlock width="100%" height={42} radius={12} />
              </View>
            ) : invalid ? (
              <View style={{ alignItems: 'center', gap: 8, paddingVertical: 6 }}>
                <View style={[styles.bigIcon, { backgroundColor: theme.dangerSoft }]}>
                  <Ionicons name="link-outline" size={28} color={theme.danger} />
                </View>
                <Text style={{ color: theme.textPrimary, fontSize: 18, fontWeight: '700', textAlign: 'center' }}>
                  Ссылка недействительна
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 }}>
                  {preview?.expired ? 'Срок действия приглашения истёк.' : 'Проверьте ссылку или попросите новое приглашение.'}
                </Text>
                {loadError ? (
                  <Text style={{ color: theme.textDisabled, fontSize: 11, textAlign: 'center' }}>{loadError}</Text>
                ) : null}
                <View style={{ width: '100%', marginTop: 12 }}>
                  <Btn title={session ? 'К чатам' : 'Войти'} onPress={session ? () => router.replace('/chats' as never) : goLogin} />
                </View>
              </View>
            ) : banned ? (
              <View style={{ alignItems: 'center', gap: 8, paddingVertical: 6 }}>
                <View style={[styles.bigIcon, { backgroundColor: theme.dangerSoft }]}>
                  <Ionicons name="ban-outline" size={28} color={theme.danger} />
                </View>
                <Text style={{ color: theme.textPrimary, fontSize: 18, fontWeight: '700', textAlign: 'center' }}>
                  Доступ запрещён
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 13, textAlign: 'center', lineHeight: 19 }}>
                  Вы заблокированы в этом чате. Если это ошибка — свяжитесь с администратором.
                </Text>
                <View style={{ width: '100%', marginTop: 12 }}>
                  <Btn title="К чатам" variant="ghost" onPress={() => router.replace('/chats' as never)} />
                </View>
              </View>
            ) : (
              <>
                <View style={styles.avatarWrap}>
                  <View
                    pointerEvents="none"
                    style={[
                      StyleSheet.absoluteFill,
                      { alignItems: 'center', justifyContent: 'center' },
                      Platform.OS === 'web'
                        ? ({ filter: 'blur(22px)', opacity: 0.5, transform: [{ scale: 1.3 }] } as any)
                        : { opacity: 0.2, transform: [{ scale: 1.35 }] },
                    ]}
                  >
                    <Avatar name={roomTitle} size={82} hasModule={false} hasNode={false} />
                  </View>
                  <Avatar name={roomTitle} size={76} hasModule={false} hasNode={false} />
                </View>

                <Text style={{ color: theme.textPrimary, fontSize: 21, fontWeight: '800', marginTop: 12, textAlign: 'center' }}>
                  {roomTitle}
                </Text>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9, justifyContent: 'center' }}>
                  <View style={[styles.badge, { backgroundColor: theme.surfacePressed, borderColor: theme.line }]}>
                    <Ionicons name={isChannel ? 'megaphone-outline' : 'people-outline'} size={11} color={theme.textSecondary} />
                    <Text style={{ color: theme.textSecondary, fontSize: 11, fontWeight: '600' }}>
                      {isChannel ? 'Канал' : 'Группа'}
                    </Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}>
                    <Ionicons name={meta.icon} size={11} color={theme.accent} />
                    <Text style={{ color: theme.accent, fontSize: 11, fontWeight: '600' }}>
                      {visibilityLabel(visibility, isChannel ? 'channel' : 'group')}
                    </Text>
                  </View>
                  <View style={[styles.badge, { backgroundColor: theme.surfacePressed, borderColor: theme.line }]}>
                    <Ionicons name="person-outline" size={11} color={theme.textSecondary} />
                    <Text style={{ color: theme.textSecondary, fontSize: 11, fontWeight: '600' }}>{membersLabel}</Text>
                  </View>
                </View>

                {preview?.description ? (
                  <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 12, textAlign: 'center' }}>
                    {preview.description}
                  </Text>
                ) : (
                  <Text style={{ color: theme.textSecondary, fontSize: 13, lineHeight: 19, marginTop: 12, textAlign: 'center' }}>
                    {meta.text}: {visibility === 'closed' ? 'вступление по заявке.' : visibility === 'private' ? 'вступление по приглашению.' : 'вступить может каждый.'}
                  </Text>
                )}

                {loadError ? (
                  <Text style={{ color: theme.warning, fontSize: 11.5, marginTop: 10, textAlign: 'center' }}>{loadError}</Text>
                ) : null}

                <View style={{ width: '100%', marginTop: 16 }}>
                  {!session ? (
                    <Btn title="Войти и присоединиться" onPress={goLogin} />
                  ) : alreadyMember ? (
                    <Btn title="Открыть чат" onPress={openChat} />
                  ) : pending || preview?.alreadyRequested ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 12 }}>
                      <Ionicons name="hourglass-outline" size={16} color={theme.warning} />
                      <Text style={{ color: theme.warning, fontSize: 12.5, fontWeight: '600', textAlign: 'center', flex: 1 }}>
                        Заявка отправлена, ожидайте одобрения
                      </Text>
                    </View>
                  ) : (
                    <Btn
                      title={visibility === 'closed' ? 'Подать заявку' : 'Вступить'}
                      loading={joining}
                      onPress={() => void join()}
                    />
                  )}
                </View>

                {visibility === 'private' ? (
                  <Text style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 10, textAlign: 'center', lineHeight: 14 }}>
                    Ссылка персональная. Не пересылайте её тем, кому не хотите давать доступ.
                  </Text>
                ) : null}
              </>
            )}
          </GlassCard>
        </MotiView>

        <Pressable
          onPress={() => router.replace('/chats' as never)}
          accessibilityRole="button"
          accessibilityLabel="Перейти к чатам"
          style={({ pressed }) => [{ marginTop: 16, opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={{ color: theme.textDisabled, fontSize: 11.5, fontWeight: '600' }}>Klinto · защищённые чаты</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10, paddingHorizontal: 2 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatarWrap: { width: 84, height: 84, alignItems: 'center', justifyContent: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  bigIcon: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
});
