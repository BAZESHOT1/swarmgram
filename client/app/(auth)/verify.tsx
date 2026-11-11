import React, { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { verifyEmail } from '../../src/data/auth';
import { getSession } from '../../src/data/api';
import { humanError } from '../../src/data/queries';
import { Btn } from '../../src/components/Btn';
import { useTheme } from '../../src/theme/useTheme';
import { AuthShell } from '../../src/components/AuthShell';
import { useStore } from '../../src/state/useStore';

export default function VerifyScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ email?: string }>();
  const email = params.email ?? '';
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [timesSent, setTimesSent] = useState(0);
  const [resendLeft, setResendLeft] = useState(60);

  const canResend = useMemo(() => resendLeft === 0, [resendLeft]);

  React.useEffect(() => {
    if (resendLeft <= 0) return;
    const t = setInterval(() => setResendLeft((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [resendLeft]);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await verifyEmail(email, code);
      // После регистрации сессия уже есть в api, но не в store — иначе
      // (app)-layout сразу уводит обратно на логин.
      const session = getSession();
      if (session) useStore.getState().setSession(session);
      useStore.getState().pushToast({ kind: 'success', message: 'Email подтверждён' });
      // Навигацию на /chats выполнит RootLayout после появления сессии в store.
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <AuthShell>
        <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: theme.fontL }}>Подтверждение почты</Text>
        <Text style={{ color: theme.textSecondary, fontSize: 13, marginTop: 4, marginBottom: 14 }}>
          Код отправлен на {email}. Введите его ниже.
        </Text>

        <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 6 }}>Код из письма</Text>
        <TextInput
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          autoComplete="one-time-code"
          spellCheck={false}
          inputMode="numeric"
          accessibilityLabel="Код подтверждения"
          placeholder="XXXXXX…"
          placeholderTextColor={theme.textDisabled}
          style={[styles.input, { backgroundColor: theme.surface, color: theme.textPrimary, borderColor: theme.line }]}
        />

        {error ? <Text style={{ color: theme.danger, fontSize: 13, marginTop: 10 }}>{error}</Text> : null}

        <Btn title="Подтвердить" loading={busy} disabled={!code} accessibilityLabel="Подтвердить" style={{ marginTop: 16 }} onPress={submit} />

        <Text
          onPress={canResend ? () => { setResendLeft(60); setTimesSent((c) => c + 1); } : undefined}
          style={{ color: canResend ? theme.accent : theme.textDisabled, marginTop: 14, textAlign: 'center', fontSize: 13 }}
          accessibilityLabel={canResend ? 'Отправить код заново' : `Повторная отправка доступна через ${resendLeft} секунд`}
        >
          {canResend ? 'Отправить код заново' : `Повторная отправка через ${resendLeft} с`}
        </Text>
      </AuthShell>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
});
