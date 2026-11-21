/**
 * Аккаунт заблокирован администрацией: всё приложение размыто, по центру — сообщение.
 * Доступно только одно действие — выйти из аккаунта.
 */
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { useStore } from '../state/useStore';
import { useTheme } from '../theme/useTheme';
import { Glass } from './Glass';

export function SuspendedOverlay() {
  const theme = useTheme();
  const qc = useQueryClient();
  const me = useStore((s) => s.me);
  const flagged = useStore((s) => (s as unknown as { accountSuspended?: boolean }).accountSuspended);
  const [busy, setBusy] = React.useState(false);
  const suspended = me?.accountStatus === 'suspended' || Boolean(flagged);
  if (!suspended) return null;

  async function signOut() {
    setBusy(true);
    try {
      const { logout } = await import('../data/auth');
      await logout();
      qc.clear();
      useStore.setState({ accountSuspended: false } as never);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 1000, elevation: 1000 }]}>
      <Glass radius={0} borderWidth={0} intensity={70} fill={theme.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)'} style={StyleSheet.absoluteFill}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <View style={{ width: '100%', maxWidth: 420, alignItems: 'center', gap: 14, padding: 24, borderRadius: 26, backgroundColor: theme.surfaceElevated, borderWidth: 1, borderColor: theme.line }}>
            <View style={{ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.dangerSoft }}>
              <Ionicons name="lock-closed" size={30} color={theme.danger} />
            </View>
            <Text style={{ color: theme.textPrimary, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>
              Аккаунт заблокирован администрацией сайта
            </Text>
            <Text style={{ color: theme.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
              Пользоваться аккаунтом нельзя. Если считаете, что это ошибка, свяжитесь с поддержкой.
            </Text>
            <Pressable
              onPress={() => void signOut()}
              disabled={busy}
              accessibilityRole="button"
              style={({ pressed }) => ({ marginTop: 6, alignSelf: 'stretch', paddingVertical: 14, borderRadius: 16, alignItems: 'center', backgroundColor: theme.danger, opacity: pressed ? 0.85 : 1 })}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>Выйти из аккаунта</Text>}
            </Pressable>
          </View>
        </View>
      </Glass>
    </View>
  );
}
