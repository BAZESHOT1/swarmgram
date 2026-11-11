import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useRouter } from 'expo-router';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { Btn } from '../Btn';
import { GlassCard, GlassSectionTitle } from './Glass';
import { ConfirmModal } from './ConfirmModal';
import { PressableScale } from './PressableScale';
import { DeviceRowSkeleton } from '../skeletons/PageSkeletons';
import { useStore } from '../../state/useStore';
import { humanError } from '../../data/queries';
import * as api from '../../data/api';
import type { DeviceRow } from './DeviceList';

function deviceIcon(platform: string): keyof typeof Ionicons.glyphMap {
  const p = platform.toLowerCase();
  if (p.includes('ios') || p.includes('iphone') || p.includes('mac')) return 'phone-portrait-outline';
  if (p.includes('android')) return 'phone-portrait-outline';
  if (p.includes('web')) return 'globe-outline';
  return 'hardware-chip-outline';
}

/**
 * Вкладка «Безопасность» своего профиля: активные устройства и завершение сессий.
 * Данные — GET /v1/me/devices, отзыв — DELETE /v1/me/devices/:id.
 */
export function SecurityPanel() {
  const theme = useTheme();
  const router = useRouter();
  const reduced = useReducedMotion();
  const session = useStore((s) => s.session);
  const pushToast = useStore((s) => s.pushToast);

  const [devices, setDevices] = React.useState<DeviceRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = React.useState<DeviceRow | null>(null);

  const load = React.useCallback(async () => {
    const token = session?.accessToken;
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const rows = await api.api.listDevices(token);
      setDevices((rows ?? []) as DeviceRow[]);
    } catch (e: unknown) {
      setError(humanError(e));
    } finally {
      setLoading(false);
    }
  }, [session?.accessToken]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function revoke() {
    if (!pendingRevoke || revoking) return;
    const device = pendingRevoke;
    setRevoking(device.id);
    try {
      await api.api.revokeDevice(device.id);
      setDevices((rows) => rows.filter((row) => row.id !== device.id));
      pushToast({ kind: 'success', message: 'Устройство завершено' });
      setPendingRevoke(null);
    } catch (e: unknown) {
      pushToast({ kind: 'error', message: humanError(e) });
    } finally {
      setRevoking(null);
    }
  }

  return (
    <>
      <GlassCard>
        <GlassSectionTitle
          title="Активные устройства"
          right={<Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>{loading ? '' : devices.length}</Text>}
        />

        {loading ? (
          <View>
            {[0, 1, 2, 3].map((index) => (
              <DeviceRowSkeleton key={index} />
            ))}
          </View>
        ) : error ? (
          <View style={{ gap: 8, paddingVertical: 6 }}>
            <Text style={{ color: theme.danger, fontSize: 13 }}>{error}</Text>
            <Btn title="Повторить" size="s" variant="ghost" onPress={() => void load()} />
          </View>
        ) : devices.length === 0 ? (
          <Text style={{ color: theme.textSecondary, fontSize: 13, paddingVertical: 6 }}>Нет активных устройств.</Text>
        ) : (
          <View style={{ gap: 6 }}>
            {devices.map((device, index) => (
              <MotiView
                key={device.id}
                from={reduced ? { opacity: 1 } : { opacity: 0, translateY: 6 }}
                animate={{ opacity: 1, translateY: 0 }}
                transition={reduced ? { type: 'timing', duration: 0 } : { ...motion.spring, delay: index * motion.staggerStepMs }}
              >
                <View style={[styles.row, { borderColor: theme.line }]}>
                  <View style={[styles.iconBox, { backgroundColor: theme.accentSoft }]}>
                    <Ionicons name={deviceIcon(device.platform)} size={16} color={theme.accent} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
                      {device.name || 'Устройство'}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
                      {Platform.OS === 'web' ? device.platform || 'web' : device.platform || 'device'}
                      {device.created_at ? ` · с ${new Date(device.created_at).toLocaleDateString('ru-RU')}` : ''}
                    </Text>
                  </View>
                  <Btn
                    title="Завершить"
                    size="s"
                    variant="ghost"
                    loading={revoking === device.id}
                    onPress={() => setPendingRevoke(device)}
                    accessibilityLabel={`Завершить устройство ${device.name || device.platform}`}
                  />
                </View>
              </MotiView>
            ))}
          </View>
        )}
      </GlassCard>

      <GlassCard style={{ marginTop: 12 }}>
        <GlassSectionTitle title="Пароль и вход" />
        <PressableRow
          icon="key-outline"
          title="Сменить пароль"
          subtitle="Настройки безопасности аккаунта"
          onPress={() => router.push('/settings/security' as never)}
        />
        <PressableRow
          icon="shield-checkmark-outline"
          title="Настройки приватности"
          subtitle="Кто видит последний визит, био и ссылки"
          onPress={() => router.push('/settings/privacy' as never)}
        />
      </GlassCard>

      <ConfirmModal
        visible={Boolean(pendingRevoke)}
        title="Завершить устройство?"
        message={`Сессия «${pendingRevoke?.name || pendingRevoke?.platform || 'Устройство'}» будет завершена. Для входа потребуется пароль.`}
        confirmLabel="Завершить"
        loading={Boolean(revoking)}
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => void revoke()}
      />
    </>
  );
}

function PressableRow({
  icon,
  title,
  subtitle,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      style={[styles.linkRow, { borderColor: theme.line }]}
    >
      <View style={[styles.iconBox, { backgroundColor: theme.accentSoft }]}>
        <Ionicons name={icon} size={16} color={theme.accent} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }}>{title}</Text>
        <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={2}>
          {subtitle}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={15} color={theme.textDisabled} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 9, minHeight: 54 },
  iconBox: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 9, minHeight: 52, marginBottom: 6 },
});
