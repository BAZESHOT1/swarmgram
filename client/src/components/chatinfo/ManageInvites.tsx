/**
 * Подраздел «Ссылки»: создание/отзыв пригласительных ссылок и прямое
 * приглашение пользователя по username.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { Btn } from '../Btn';
import { SettingsInput } from '../settings/SettingsWidgets';
import { useStore } from '../../state/useStore';
import { ManageBadge, ManageChoice, ManageEmpty, ManageSection } from './ManageUI';
import {
  copyText,
  inviteUrl,
  manageActions,
  manageError,
  shareText,
  useInvitesSafe,
} from './ManageData';
import {
  ROLE_LABEL,
  formatWhen,
  type ChatRole,
} from './ManageTypes';

const ROLE_OPTIONS: { value: ChatRole; label: string; hint: string }[] = [
  { value: 'member', label: ROLE_LABEL.member, hint: 'Обычное участие в чате' },
  { value: 'moderator', label: ROLE_LABEL.moderator, hint: 'Права по матрице модератора' },
  { value: 'admin', label: ROLE_LABEL.admin, hint: 'Полные права по матрице администратора' },
];

const EXPIRY_OPTIONS = [
  { value: '0', label: 'Бессрочно', hint: 'Ссылка действует, пока её не отзовут' },
  { value: '24', label: '24 часа', hint: 'Истечёт через сутки' },
  { value: '168', label: '7 дней', hint: 'Истечёт через неделю' },
  { value: '720', label: '30 дней', hint: 'Истечёт через месяц' },
];

export function ManageInvites({
  chatId,
  chatTitle,
  onChanged,
}: {
  chatId: string;
  chatTitle: string;
  onChanged: () => Promise<void> | void;
}) {
  const theme = useTheme();
  const pushToast = useStore((s) => s.pushToast);
  const invites = useInvitesSafe(chatId);

  const [role, setRole] = React.useState<ChatRole>('member');
  const [expiry, setExpiry] = React.useState('0');
  const [maxUses, setMaxUses] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [busyToken, setBusyToken] = React.useState('');
  const [direct, setDirect] = React.useState('');
  const [inviting, setInviting] = React.useState(false);

  const active = React.useMemo(() => {
    const now = Date.now();
    return invites.data.filter((inv) => {
      if (inv.revokedAt) return false;
      if (inv.expiresAt) {
        const t = new Date(inv.expiresAt).getTime();
        if (Number.isFinite(t) && t <= now) return false;
      }
      return Boolean(inv.token);
    });
  }, [invites.data]);

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      const limit = Number.parseInt(maxUses, 10);
      await manageActions.createInvite(chatId, {
        role,
        expiresInHours: expiry === '0' ? null : Number(expiry),
        maxUses: Number.isFinite(limit) && limit > 0 ? limit : null,
      });
      pushToast({ kind: 'success', message: 'Ссылка создана' });
      setMaxUses('');
      await invites.refetch();
      await onChanged();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setCreating(false);
    }
  }

  async function copy(token: string) {
    const url = inviteUrl(token);
    const ok = await copyText(url);
    pushToast({
      kind: ok ? 'success' : 'error',
      message: ok ? 'Ссылка скопирована' : `Не удалось скопировать. Ссылка: ${url}`,
    });
  }

  async function share(token: string) {
    const url = inviteUrl(token);
    const ok = await shareText(`Приглашение в «${chatTitle}»`, url);
    if (!ok) await copy(token);
  }

  async function revoke(inviteId: string, token: string) {
    if (busyToken) return;
    setBusyToken(token);
    try {
      await manageActions.revokeInvite(chatId, inviteId || token);
      pushToast({ kind: 'success', message: 'Ссылка отозвана' });
      await invites.refetch();
      await onChanged();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setBusyToken('');
    }
  }

  async function sendDirect() {
    const username = direct.trim().toLowerCase();
    if (!username || inviting) return;
    setInviting(true);
    try {
      const res: any = await manageActions.directInvite(chatId, username);
      pushToast({
        kind: 'success',
        message: res?.added === false ? `Приглашение отправлено @${username}` : `@${username} добавлен(а) в чат`,
      });
      setDirect('');
      await onChanged();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: manageError(e) });
    } finally {
      setInviting(false);
    }
  }

  return (
    <>
      <ManageSection
        icon="link-outline"
        title="Новая ссылка"
        subtitle="Ссылка открывает экран вступления. Роль и срок можно задать заранее."
      >
        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 6 }}>Роль при входе</Text>
        <ManageChoice options={ROLE_OPTIONS} value={role} onChange={setRole} compact disabled={creating} />

        <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '700', marginTop: 10, marginBottom: 6 }}>
          Срок действия
        </Text>
        <ManageChoice options={EXPIRY_OPTIONS} value={expiry} onChange={setExpiry} compact disabled={creating} />

        <View style={{ marginTop: 10 }}>
          <SettingsInput
            label="Лимит вступлений"
            value={maxUses}
            onChangeText={(text) => setMaxUses(text.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            editable={!creating}
            placeholder="Без ограничений"
            accessibilityLabel="Лимит вступлений"
          />
        </View>

        <Btn title="Создать ссылку" loading={creating} onPress={() => void create()} />
      </ManageSection>

      <ManageSection
        icon="link"
        title="Активные ссылки"
        subtitle="Полная ссылка ведёт на страницу входа по приглашению."
        right={<ManageBadge text={String(active.length)} tone="accent" />}
      >
        {invites.error ? (
          <Text style={{ color: theme.danger, fontSize: 12, marginBottom: 8 }}>{invites.error}</Text>
        ) : null}

        {active.length === 0 ? (
          <ManageEmpty icon="link-outline" text={invites.loading ? 'Загружаем ссылки…' : 'Активных ссылок пока нет.'} />
        ) : (
          <View style={{ gap: 8 }}>
            {active.map((inv) => (
              <View
                key={inv.id || inv.token}
                style={[{ borderWidth: 1, borderColor: theme.line, backgroundColor: theme.surface, borderRadius: 12, padding: 10 }]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <ManageBadge text={ROLE_LABEL[inv.role]} tone="accent" />
                  <ManageBadge
                    text={inv.maxUses ? `${inv.uses} / ${inv.maxUses}` : `${inv.uses} вступлений`}
                  />
                  <ManageBadge text={inv.expiresAt ? `до ${formatWhen(inv.expiresAt)}` : 'Бессрочно'} tone="neutral" />
                </View>
                <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 6 }} numberOfLines={1}>
                  {inviteUrl(inv.token)}
                </Text>
                <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  <Pressable
                    onPress={() => void copy(inv.token)}
                    accessibilityRole="button"
                    accessibilityLabel="Копировать ссылку"
                    style={({ pressed }) => [
                      styles.actionBtn,
                      { borderColor: theme.line, backgroundColor: theme.surfacePressed, opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <Ionicons name="copy-outline" size={13} color={theme.textSecondary} />
                    <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontWeight: '600' }}>Копировать</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void share(inv.token)}
                    accessibilityRole="button"
                    accessibilityLabel="Поделиться ссылкой"
                    style={({ pressed }) => [
                      styles.actionBtn,
                      { borderColor: theme.line, backgroundColor: theme.surfacePressed, opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <Ionicons name="share-outline" size={13} color={theme.textSecondary} />
                    <Text style={{ color: theme.textSecondary, fontSize: 11.5, fontWeight: '600' }}>Поделиться</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void revoke(inv.id, inv.token)}
                    disabled={busyToken === inv.token}
                    accessibilityRole="button"
                    accessibilityLabel="Отозвать ссылку"
                    style={({ pressed }) => [
                      styles.actionBtn,
                      { borderColor: theme.dangerSoft, backgroundColor: theme.dangerSoft, opacity: pressed ? 0.7 : 1 },
                    ]}
                  >
                    <Ionicons name="trash-outline" size={13} color={theme.danger} />
                    <Text style={{ color: theme.danger, fontSize: 11.5, fontWeight: '600' }}>
                      {busyToken === inv.token ? 'Отзываем…' : 'Отозвать'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}
      </ManageSection>

      <ManageSection
        icon="person-add-outline"
        title="Прямое приглашение"
        subtitle="Пользователь получит приглашение в чат. Его приватность может запретить такие приглашения."
      >
        <SettingsInput
          label="Username"
          value={direct}
          onChangeText={(text) => setDirect(text.replace(/^@/, ''))}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!inviting}
          placeholder="например, imbirok"
          accessibilityLabel="Username для приглашения"
          onSubmitEditing={() => void sendDirect()}
        />
        <Btn
          title="Пригласить"
          loading={inviting}
          disabled={!direct.trim()}
          onPress={() => void sendDirect()}
        />
      </ManageSection>
    </>
  );
}

const styles = {
  actionBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 5,
    borderWidth: 1,
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
};
