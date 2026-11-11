/**
 * Безопасность: смена пароля, активные устройства/сессии и удаление аккаунта.
 * Все операции идут через реальные API; выход из аккаунта — на главной настройке.
 */
import React from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useTheme } from '../../../src/theme/useTheme';
import {
  GlassCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../../../src/components/settings/SettingsUI';
import { SettingsInput, SettingsModal } from '../../../src/components/settings/SettingsWidgets';
import { SettingsRowsSkeleton } from '../../../src/components/skeletons/PageSkeletons';
import { ConfirmModal } from '../../../src/components/profile/ConfirmModal';
import { Btn } from '../../../src/components/Btn';
import { useChangePassword, useDevices, useRevokeDevice, humanError } from '../../../src/data/queries';
import { getSession } from '../../../src/data/api';
import * as api from '../../../src/data/api';
import { logout } from '../../../src/data/auth';
import { useStore } from '../../../src/state/useStore';

export default function SecurityScreen() {
  const theme = useTheme();
  const router = useRouter();
  const pushToast = useStore((s) => s.pushToast);
  const session = useStore((s) => s.session);

  const token = getSession()?.accessToken ?? session?.accessToken ?? '';
  const devices = useDevices(token);
  const revoke = useRevokeDevice();
  const changePassword = useChangePassword();

  const [oldPass, setOldPass] = React.useState('');
  const [newPass, setNewPass] = React.useState('');
  const [confirmPass, setConfirmPass] = React.useState('');
  const [passError, setPassError] = React.useState('');
  const [revokeId, setRevokeId] = React.useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deletePass, setDeletePass] = React.useState('');
  const [deleteError, setDeleteError] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);

  const mismatch = confirmPass.length > 0 && confirmPass !== newPass;
  const tooShort = newPass.length > 0 && newPass.length < 8;
  const canSubmit = Boolean(oldPass) && newPass.length >= 8 && newPass === confirmPass;

  const inputStyle = {
    backgroundColor: theme.dark ? 'rgba(10,14,20,0.45)' : 'rgba(255,255,255,0.85)',
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.textPrimary,
    fontSize: 14.5,
  } as const;

  async function submitPassword() {
    setPassError('');
    if (newPass.length < 8) {
      setPassError('Новый пароль должен содержать минимум 8 символов.');
      return;
    }
    if (newPass !== confirmPass) {
      setPassError('Пароли не совпадают.');
      return;
    }
    try {
      await changePassword.mutateAsync({ oldPassword: oldPass, newPassword: newPass });
      pushToast({ kind: 'success', message: 'Пароль обновлён' });
      setOldPass('');
      setNewPass('');
      setConfirmPass('');
    } catch (e: unknown) {
      setPassError(humanError(e));
    }
  }

  async function confirmRevoke() {
    if (!revokeId) return;
    try {
      await revoke.mutateAsync(revokeId);
      pushToast({ kind: 'success', message: 'Устройство завершено' });
      setRevokeId(null);
      await devices.refetch();
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    }
  }

  /** Удаление аккаунта: пароль подтверждает владельца, затем сессия завершается. */
  async function confirmDeleteAccount() {
    if (!deletePass) {
      setDeleteError('Введите пароль для подтверждения.');
      return;
    }
    setDeleteError('');
    setDeleting(true);
    try {
      // api.deleteAccount появится в контракте параллельного агента — приводим тип локально.
      await (api.api as any).deleteAccount(deletePass);
      await logout();
      router.replace('/login' as never);
    } catch (e: unknown) {
      setDeleteError(humanError(e));
    } finally {
      setDeleting(false);
    }
  }

  const deviceRows = devices.data ?? [];

  return (
    <SettingsPage title="Безопасность" subtitle="Пароль, устройства и сессии, удаление аккаунта">
      {/* ------------------------------------------------------- пароль --- */}
      <SettingsSection title="Смена пароля" delay={0}>
        <GlassCard>
          <View style={{ padding: 8, gap: 8 }}>
            <Text style={{ color: theme.textSecondary, fontSize: 12 }}>Старый пароль</Text>
            <TextInput
              value={oldPass}
              onChangeText={setOldPass}
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="Старый пароль"
              placeholder="Текущий пароль"
              placeholderTextColor={theme.textDisabled}
              style={inputStyle}
            />
            <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>Новый пароль</Text>
            <TextInput
              value={newPass}
              onChangeText={setNewPass}
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="Новый пароль"
              placeholder="Минимум 8 символов"
              placeholderTextColor={theme.textDisabled}
              style={inputStyle}
            />
            <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 4 }}>Подтверждение</Text>
            <TextInput
              value={confirmPass}
              onChangeText={setConfirmPass}
              secureTextEntry
              autoCapitalize="none"
              accessibilityLabel="Подтверждение нового пароля"
              placeholder="Повторите новый пароль"
              placeholderTextColor={theme.textDisabled}
              style={inputStyle}
            />
            {tooShort ? (
              <Text style={{ color: theme.warning, fontSize: 12 }}>Минимум 8 символов.</Text>
            ) : null}
            {mismatch ? <Text style={{ color: theme.danger, fontSize: 12 }}>Пароли не совпадают.</Text> : null}
            {passError ? <Text style={{ color: theme.danger, fontSize: 12.5 }}>{passError}</Text> : null}
            <View style={{ marginTop: 6 }}>
              <Btn
                title="Сменить пароль"
                size="s"
                disabled={!canSubmit}
                loading={changePassword.isPending}
                onPress={() => void submitPassword()}
              />
            </View>
            <Text style={{ color: theme.textDisabled, fontSize: 11 }}>
              Пароль используется для локального шифрования резерва ключей и не хранится на сервере в открытом виде.
            </Text>
          </View>
        </GlassCard>
      </SettingsSection>

      {/* ---------------------------------------------------- устройства -- */}
      <SettingsSection
        title="Активные устройства"
        delay={40}
        right={<Text style={{ color: theme.textDisabled, fontSize: 12 }}>{deviceRows.length}</Text>}
      >
        <GlassCard>
          <View style={{ padding: 8, gap: 8 }}>
            {devices.isLoading ? (
              <SettingsRowsSkeleton rows={4} />
            ) : devices.isError ? (
              <Text style={{ color: theme.danger, fontSize: 13 }}>{humanError(devices.error)}</Text>
            ) : deviceRows.length === 0 ? (
              <Text style={{ color: theme.textSecondary, fontSize: 13 }}>Нет активных устройств.</Text>
            ) : (
              deviceRows.map((d) => (
                <View
                  key={d.id}
                  style={[styles.device, { borderColor: theme.line, backgroundColor: theme.surfacePressed }]}
                >
                  <View style={[styles.deviceIcon, { backgroundColor: theme.accentSoft }]}>
                    <Ionicons
                      name={
                        d.platform?.toLowerCase().includes('web')
                          ? 'globe-outline'
                          : d.platform?.toLowerCase().includes('android') || d.platform?.toLowerCase().includes('ios')
                            ? 'phone-portrait-outline'
                            : 'hardware-chip-outline'
                      }
                      size={17}
                      color={theme.accent}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
                      {d.name || 'Устройство'}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
                      {d.platform || 'device'} · с {new Date(d.created_at).toLocaleDateString('ru-RU')}
                    </Text>
                  </View>
                  <Btn
                    title="Завершить"
                    variant="danger"
                    size="s"
                    onPress={() => setRevokeId(d.id)}
                    accessibilityLabel={`Завершить сессию ${d.name || 'устройства'}`}
                  />
                </View>
              ))
            )}
          </View>
        </GlassCard>
      </SettingsSection>

      {/* ---------------------------------------------------- опасная зона -- */}
      <SettingsSection title="Опасная зона" delay={80}>
        <GlassCard>
          <SettingsRow
            icon="trash-outline"
            title="Удалить аккаунт"
            subtitle="Безвозвратно удалить аккаунт и все данные"
            danger
            onPress={() => {
              setDeleteError('');
              setDeletePass('');
              setDeleteOpen(true);
            }}
          />
        </GlassCard>
        <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 8, paddingHorizontal: 4, lineHeight: 17 }}>
          Удаление аккаунта необратимо: профиль, чаты и резерв ключей будут удалены. Локальные ключи шифрования на этом
          устройстве останутся, но восстановить аккаунт не получится.
        </Text>
      </SettingsSection>

      <SettingsModal
        visible={deleteOpen}
        title="Удалить аккаунт навсегда?"
        subtitle="Действие необратимо. Введите пароль, чтобы подтвердить удаление аккаунта и всех связанных данных."
        onClose={() => {
          if (!deleting) setDeleteOpen(false);
        }}
        maxWidth={420}
      >
        <SettingsInput
          label="Пароль"
          value={deletePass}
          onChangeText={setDeletePass}
          secureTextEntry
          autoCapitalize="none"
          placeholder="Текущий пароль"
          accessibilityLabel="Пароль для удаления аккаунта"
          editable={!deleting}
        />
        {deleteError ? (
          <Text style={{ color: theme.danger, fontSize: 12.5, marginBottom: 4 }}>{deleteError}</Text>
        ) : null}
        <View style={styles.modalButtons}>
          <View style={{ flex: 1 }}>
            <Btn
              title="Отмена"
              variant="ghost"
              disabled={deleting}
              onPress={() => setDeleteOpen(false)}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Btn
              title="Удалить навсегда"
              variant="danger"
              loading={deleting}
              disabled={!deletePass}
              onPress={() => void confirmDeleteAccount()}
            />
          </View>
        </View>
      </SettingsModal>

      <ConfirmModal
        visible={revokeId !== null}
        title="Завершить сессию?"
        message="Устройство будет отозвано, и на нём потребуется повторный вход."
        confirmLabel="Завершить"
        loading={revoke.isPending}
        onClose={() => setRevokeId(null)}
        onConfirm={() => void confirmRevoke()}
      />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  device: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  deviceIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  modalButtons: { flexDirection: 'row', gap: 10, marginTop: 6 },
});
