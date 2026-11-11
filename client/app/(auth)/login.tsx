import React, { useEffect, useState } from 'react';
import {  KeyboardAvoidingView, Platform, Text, TextInput , StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { login as doLogin } from '../../src/data/auth';
import { Btn } from '../../src/components/Btn';
import { useTheme } from '../../src/theme/useTheme';
import { AuthShell } from '../../src/components/AuthShell';
import { useStore } from '../../src/state/useStore';

export default function LoginScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ next?: string }>();
  const nextPath = typeof params.next === 'string' && params.next.startsWith('/') ? params.next : '/chats';
  const theme = useTheme();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Страховка: как только сессия появилась (в т.ч. после восстановления),
  // сразу уводим на главную — независимо от того, где завершился запрос.
  const hasSession = useStore((s) => Boolean(s.session));
  useEffect(() => {
    if (hasSession) router.replace(nextPath as never);
  }, [hasSession, nextPath, router]);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await doLogin(login.trim(), password);
      useStore.getState().pushToast({ kind: 'success', message: 'Вход выполнен' });
      router.replace(nextPath as never);
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Error:\s*/, '') : 'Ошибка входа';
      setError(msg);
      useStore.getState().pushToast({ kind: 'error', message: msg, actionLabel: 'Повторить', action: () => void submit() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <AuthShell>
        <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: theme.fontL }}>Вход</Text>
        <Text style={{ color: theme.textSecondary, fontSize: 13, marginTop: 4, marginBottom: 14 }}>
          Конверты шифруются на устройстве. Маршруты — только на сервере.
        </Text>

        <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 6 }}>Email или username</Text>
        <TextInput
          value={login}
          onChangeText={setLogin}
          autoCapitalize="none"
          autoComplete="username"
          spellCheck={false}
          inputMode="email"
          textContentType="username"
          accessibilityLabel="Email или username"
          style={[styles.input, { backgroundColor: theme.surface, color: theme.textPrimary, borderColor: theme.line }]}
        />
        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 12, marginBottom: 6 }}>Пароль</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="password"
          autoComplete="current-password"
          accessibilityLabel="Пароль"
          style={[styles.input, { backgroundColor: theme.surface, color: theme.textPrimary, borderColor: theme.line }]}
        />

        {error ? <Text style={{ color: theme.danger, fontSize: 13, marginTop: 10 }}>{error}</Text> : null}

        <Btn title="Войти" loading={busy} accessibilityLabel="Войти" style={{ marginTop: 16 }} onPress={submit} />

        <Text
          onPress={() => router.replace('/register' as never)}
          style={{ color: theme.accent, marginTop: 14, textAlign: 'center', fontSize: 14 }}
          accessibilityLabel="Перейти к регистрации"
        >
          Нет аккаунта — регистрация
        </Text>
      </AuthShell>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 46,
    fontSize: 16,
  },
});
