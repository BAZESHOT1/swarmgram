import React, { useState } from 'react';
import {  KeyboardAvoidingView, Platform, Text, TextInput , StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { register as doRegister, type AuthResult } from '../../src/data/auth';
import * as api from '../../src/data/api';
import { Btn } from '../../src/components/Btn';
import { useTheme } from '../../src/theme/useTheme';
import { AuthShell } from '../../src/components/AuthShell';
import { useStore } from '../../src/state/useStore';
import { humanError } from '../../src/data/queries';

const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

export default function RegisterScreen() {
  const router = useRouter();
  const theme = useTheme();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);

  async function checkName(name: string) {
    const normalized = name.trim().toLowerCase();
    if (!USERNAME_RE.test(normalized)) {
      setAvailable(null);
      return;
    }
    try {
      const r = await api.api.checkUsername(normalized);
      setAvailable(r.available);
    } catch {
      setAvailable(null);
    }
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res: AuthResult = await doRegister({ email, username, password, displayName });
      if (res.needEmailVerify) {
        router.replace(`/verify?email=${encodeURIComponent(res.user.email)}` as never);
      } else {
        router.replace('/chats' as never);
      }
    } catch (e) {
      const msg = humanError(e);
      setError(msg);
      useStore.getState().pushToast({ kind: 'error', message: msg, actionLabel: 'Повторить', action: () => void submit() });
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <AuthShell>
        <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: theme.fontL }}>Регистрация</Text>
        <Text style={{ color: theme.textSecondary, fontSize: 13, marginTop: 4, marginBottom: 14 }}>
          Username — публичный идентификатор. Смена не чаще раза в 90 дней.
        </Text>

        <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 6 }}>Email</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          spellCheck={false}
          inputMode="email"
          accessibilityLabel="Email"
          style={[styles.input, { backgroundColor: theme.surface, color: theme.textPrimary, borderColor: theme.line }]}
        />

        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 12, marginBottom: 6 }}>Username (a-z, 0-9, _)</Text>
        <TextInput
          value={username}
          onChangeText={(v) => {
            setUsername(v.toLowerCase());
            void checkName(v);
          }}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          accessibilityLabel="Username"
          style={[styles.input, { backgroundColor: theme.surface, color: theme.textPrimary, borderColor: theme.line }]}
        />
        {available !== null ? (
          <Text style={{ color: available ? theme.success : theme.danger, fontSize: 12, marginTop: 4 }}>
            {available ? 'Имя свободно' : 'Имя уже занято'}
          </Text>
        ) : null}

        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 12, marginBottom: 6 }}>Отображаемое имя</Text>
        <TextInput
          value={displayName}
          onChangeText={setDisplayName}
          accessibilityLabel="Отображаемое имя"
          style={[styles.input, { backgroundColor: theme.surface, color: theme.textPrimary, borderColor: theme.line }]}
        />

        <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 12, marginBottom: 6 }}>Пароль (минимум 8 символов)</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          textContentType="newPassword"
          autoComplete="new-password"
          accessibilityLabel="Пароль"
          style={[styles.input, { backgroundColor: theme.surface, color: theme.textPrimary, borderColor: theme.line }]}
        />

        {error ? <Text style={{ color: theme.danger, fontSize: 13, marginTop: 10 }}>{error}</Text> : null}

        <Btn title="Создать аккаунт" loading={busy} accessibilityLabel="Создать аккаунт" style={{ marginTop: 16 }} onPress={submit} />
        <Text
          onPress={() => router.replace('/login' as never)}
          style={{ color: theme.accent, marginTop: 14, textAlign: 'center', fontSize: 14 }}
          accessibilityLabel="Вернуться ко входу"
        >
          Уже есть аккаунт — войти
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
