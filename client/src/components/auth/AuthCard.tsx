/**
 * Единый экран входа/регистрации: стеклянная карточка, переключатель режимов,
 * показ пароля и сила пароля, «запомнить меня», восстановление доступа и
 * RU/EN для экранов авторизации.
 */
import React from 'react';
import { Modal, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useRouter } from 'expo-router';
import { Btn } from '../Btn';
import { AuthShell } from '../AuthShell';
import { useTheme } from '../../theme/useTheme';
import { useStore } from '../../state/useStore';
import { kv } from '../../crypto/storage';
import { login as doLogin, register as doRegister } from '../../data/auth';
import * as api from '../../data/api';
import { humanError } from '../../data/queries';
import { APP_VERSION_LABEL } from '../../version';

type Mode = 'login' | 'register';
type Lang = 'ru' | 'en';

const T = {
  ru: {
    login: 'Вход',
    register: 'Регистрация',
    loginSub: 'Конверты шифруются на устройстве. Маршруты — только на сервере.',
    registerSub: 'Username — публичный идентификатор. Смена не чаще раза в 90 дней.',
    identifier: 'Email или username',
    password: 'Пароль',
    newPassword: 'Пароль (минимум 8 символов)',
    confirm: 'Повторите пароль',
    email: 'Email',
    username: 'Username (a-z, 0-9, _)',
    displayName: 'Отображаемое имя',
    remember: 'Запомнить меня',
    forgot: 'Забыли пароль?',
    submitLogin: 'Войти',
    submitRegister: 'Создать аккаунт',
    toRegister: 'Нет аккаунта? Регистрация',
    toLogin: 'Уже есть аккаунт? Войти',
    terms: 'Я принимаю условия использования и политику конфиденциальности',
    freeName: 'Имя свободно',
    busyName: 'Имя уже занято',
    nameHint: 'Можно менять раз в 90 дней',
    resetTitle: 'Восстановление доступа',
    resetEmail: 'Введите email — пришлём код сброса.',
    resetCode: 'Код из письма',
    resetNew: 'Новый пароль',
    sendCode: 'Отправить код',
    savePassword: 'Сохранить пароль',
    cancel: 'Отмена',
    resetSent: 'Код отправлен на email',
    resetDone: 'Пароль обновлён. Войдите с новым паролем.',
    needTerms: 'Примите условия, чтобы продолжить.',
    mismatch: 'Пароли не совпадают.',
    weak: 'Слишком простой пароль.',
  },
  en: {
    login: 'Sign in',
    register: 'Sign up',
    loginSub: 'Envelopes are encrypted on device. Routes stay on the server.',
    registerSub: 'Username is public. It can be changed once every 90 days.',
    identifier: 'Email or username',
    password: 'Password',
    newPassword: 'Password (min 8 characters)',
    confirm: 'Repeat password',
    email: 'Email',
    username: 'Username (a-z, 0-9, _)',
    displayName: 'Display name',
    remember: 'Remember me',
    forgot: 'Forgot password?',
    submitLogin: 'Sign in',
    submitRegister: 'Create account',
    toRegister: 'No account? Sign up',
    toLogin: 'Already have an account? Sign in',
    terms: 'I accept the terms of use and privacy policy',
    freeName: 'Username is available',
    busyName: 'Username is taken',
    nameHint: 'Can be changed once every 90 days',
    resetTitle: 'Account recovery',
    resetEmail: 'Enter your email and we will send a reset code.',
    resetCode: 'Code from email',
    resetNew: 'New password',
    sendCode: 'Send code',
    savePassword: 'Save password',
    cancel: 'Cancel',
    resetSent: 'Reset code sent',
    resetDone: 'Password updated. Sign in with the new password.',
    needTerms: 'Accept the terms to continue.',
    mismatch: 'Passwords do not match.',
    weak: 'Password is too weak.',
  },
} as const;

const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

function passwordScore(value: string): number {
  let score = 0;
  if (value.length >= 8) score += 1;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;
  return Math.min(4, score);
}

function Field({
  label,
  value,
  onChangeText,
  secure,
  onToggleSecure,
  ...rest
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  secure?: boolean;
  onToggleSecure?: () => void;
  [key: string]: unknown;
}) {
  const theme = useTheme();
  return (
    <View style={{ marginTop: 11 }}>
      <Text style={{ color: theme.textSecondary, fontSize: 12, marginBottom: 6 }}>{label}</Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          borderWidth: 1,
          borderColor: theme.line,
          borderRadius: 13,
          backgroundColor: theme.surface,
          minHeight: 48,
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secure}
          placeholderTextColor={theme.textDisabled}
          accessibilityLabel={label}
          style={{
            flex: 1,
            color: theme.textPrimary,
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 16,
          }}
          {...(rest as object)}
        />
        {onToggleSecure ? (
          <Pressable onPress={onToggleSecure} hitSlop={8} accessibilityRole="button" accessibilityLabel="Показать пароль" style={{ paddingHorizontal: 12 }}>
            <Ionicons name={secure ? 'eye-outline' : 'eye-off-outline'} size={19} color={theme.textSecondary} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function AuthCard({ initialMode = 'login' }: { initialMode?: Mode }) {
  const theme = useTheme();
  const router = useRouter();
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);
  const lang: Lang = locale === 'en' ? 'en' : 'ru';
  const t = T[lang];

  const [mode, setMode] = React.useState<Mode>(initialMode);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [remember, setRemember] = React.useState(true);

  const [identifier, setIdentifier] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [usernameTouched, setUsernameTouched] = React.useState(false);
  const [displayName, setDisplayName] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [terms, setTerms] = React.useState(false);
  const [available, setAvailable] = React.useState<boolean | null>(null);

  const [resetOpen, setResetOpen] = React.useState(false);
  const [resetStep, setResetStep] = React.useState<1 | 2>(1);
  const [resetEmail, setResetEmail] = React.useState('');
  const [resetCode, setResetCode] = React.useState('');
  const [resetPassword, setResetPassword] = React.useState('');
  const [resetBusy, setResetBusy] = React.useState(false);
  const [resetNote, setResetNote] = React.useState('');

  React.useEffect(() => {
    void kv.get('sg:auth-remember').then((v) => setRemember(v !== '0')).catch(() => undefined);
  }, []);

  React.useEffect(() => {
    void kv.set('sg:auth-remember', remember ? '1' : '0').catch(() => undefined);
  }, [remember]);

  // Автогенерация username из email, пока пользователь не изменил вручную.
  React.useEffect(() => {
    if (usernameTouched) return;
    const local = email.split('@')[0] || '';
    const clean = local.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
    setUsername(clean);
  }, [email, usernameTouched]);

  const checkName = React.useCallback(async (name: string) => {
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
  }, []);

  const submitLogin = async () => {
    setError('');
    setBusy(true);
    try {
      await doLogin(identifier.trim(), password);
      useStore.getState().pushToast({ kind: 'success', message: t.login });
      router.replace('/chats' as never);
    } catch (e) {
      const message = humanError(e);
      setError(message);
      useStore.getState().pushToast({ kind: 'error', message });
    } finally {
      setBusy(false);
    }
  };

  const submitRegister = async () => {
    setError('');
    if (!terms) {
      setError(t.needTerms);
      return;
    }
    if (password !== confirm) {
      setError(t.mismatch);
      return;
    }
    if (password.length < 8) {
      setError(t.weak);
      return;
    }
    setBusy(true);
    try {
      const res = await doRegister({ email, username, password, displayName: displayName || username });
      if (res.needEmailVerify) {
        router.replace(`/verify?email=${encodeURIComponent(res.user.email)}` as never);
      } else {
        router.replace('/chats' as never);
      }
    } catch (e) {
      const message = humanError(e);
      setError(message);
      useStore.getState().pushToast({ kind: 'error', message });
    } finally {
      setBusy(false);
    }
  };

  const sendReset = async () => {
    setResetBusy(true);
    setResetNote('');
    try {
      const res = await api.api.resetRequest(resetEmail.trim());
      setResetStep(2);
      setResetNote(res.devCode ? `${t.resetSent}: ${res.devCode}` : t.resetSent);
    } catch (e) {
      setResetNote(humanError(e));
    } finally {
      setResetBusy(false);
    }
  };

  const confirmReset = async () => {
    setResetBusy(true);
    setResetNote('');
    try {
      await api.api.resetConfirm(resetEmail.trim(), resetCode.trim(), resetPassword);
      setResetOpen(false);
      setResetStep(1);
      setResetCode('');
      setResetPassword('');
      useStore.getState().pushToast({ kind: 'success', message: t.resetDone });
    } catch (e) {
      setResetNote(humanError(e));
    } finally {
      setResetBusy(false);
    }
  };

  const score = passwordScore(password);
  const strengthColor = score >= 4 ? theme.success : score >= 3 ? theme.warning : theme.danger;

  return (
    <AuthShell maxWidth={470}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: theme.textPrimary, fontWeight: '800', fontSize: 21 }}>
          {mode === 'login' ? t.login : t.register}
        </Text>
        <View style={{ flexDirection: 'row', gap: 3, backgroundColor: theme.surfacePressed, borderRadius: 999, padding: 3 }}>
          {(['ru', 'en'] as const).map((value) => (
            <Pressable
              key={value}
              onPress={() => setLocale(value)}
              accessibilityRole="button"
              accessibilityLabel={value === 'ru' ? 'Русский' : 'English'}
              style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, backgroundColor: lang === value ? theme.accentSoft : 'transparent' }}
            >
              <Text style={{ color: lang === value ? theme.accent : theme.textSecondary, fontSize: 10.5, fontWeight: '800' }}>
                {value.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <Text style={{ color: theme.textSecondary, fontSize: 12.5, marginTop: 4, marginBottom: 10, lineHeight: 18 }}>
        {mode === 'login' ? t.loginSub : t.registerSub}
      </Text>

      <View style={{ flexDirection: 'row', backgroundColor: theme.surfacePressed, borderRadius: 14, padding: 3, marginBottom: 4 }}>
        {(['login', 'register'] as const).map((value) => (
          <Pressable
            key={value}
            onPress={() => {
              setMode(value);
              setError('');
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === value }}
            style={{ flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 11, backgroundColor: mode === value ? theme.surfaceElevated : 'transparent' }}
          >
            <Text style={{ color: mode === value ? theme.textPrimary : theme.textSecondary, fontSize: 13, fontWeight: '700' }}>
              {value === 'login' ? t.login : t.register}
            </Text>
          </Pressable>
        ))}
      </View>

      <MotiView
        key={mode}
        from={{ opacity: 0, translateY: 8 }}
        animate={{ opacity: 1, translateY: 0 }}
        transition={{ type: 'timing', duration: 180 }}
      >
        {mode === 'login' ? (
          <>
            <Field
              label={t.identifier}
              value={identifier}
              onChangeText={setIdentifier}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="username"
              textContentType="username"
              inputMode="email"
            />
            <Field
              label={t.password}
              value={password}
              onChangeText={setPassword}
              secure={!showPassword}
              onToggleSecure={() => setShowPassword((v) => !v)}
              autoComplete="current-password"
              textContentType="password"
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Switch
                  value={remember}
                  onValueChange={setRemember}
                  trackColor={{ false: theme.surfacePressed, true: theme.accent }}
                  thumbColor={theme.onAccent}
                  accessibilityLabel={t.remember}
                />
                <Text style={{ color: theme.textSecondary, fontSize: 12.5 }}>{t.remember}</Text>
              </View>
              <Pressable onPress={() => { setResetEmail(identifier.includes('@') ? identifier : ''); setResetOpen(true); }} hitSlop={6}>
                <Text style={{ color: theme.accent, fontSize: 12.5, fontWeight: '600' }}>{t.forgot}</Text>
              </Pressable>
            </View>
            {error ? <Text style={{ color: theme.danger, fontSize: 12.5, marginTop: 10 }}>{error}</Text> : null}
            <View style={{ marginTop: 16 }}>
              <Btn title={t.submitLogin} loading={busy} onPress={() => void submitLogin()} />
            </View>
            <Pressable onPress={() => { setMode('register'); setError(''); }} style={{ marginTop: 14, alignItems: 'center' }}>
              <Text style={{ color: theme.accent, fontSize: 13.5 }}>{t.toRegister}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Field
              label={t.email}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              inputMode="email"
              keyboardType="email-address"
            />
            <Field
              label={t.username}
              value={username}
              onChangeText={(v) => {
                setUsernameTouched(true);
                setUsername(v.toLowerCase().replace(/\s/g, ''));
                void checkName(v);
              }}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {available !== null ? (
              <Text style={{ color: available ? theme.success : theme.danger, fontSize: 11.5, marginTop: 4 }}>
                {available ? t.freeName : t.busyName}
              </Text>
            ) : (
              <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: 4 }}>{t.nameHint}</Text>
            )}
            <Field label={t.displayName} value={displayName} onChangeText={setDisplayName} autoComplete="name" />
            <Field
              label={t.newPassword}
              value={password}
              onChangeText={setPassword}
              secure={!showPassword}
              onToggleSecure={() => setShowPassword((v) => !v)}
              autoComplete="new-password"
              textContentType="newPassword"
            />
            {password ? (
              <View style={{ flexDirection: 'row', gap: 4, marginTop: 6 }}>
                {[1, 2, 3, 4].map((n) => (
                  <View key={n} style={{ flex: 1, height: 3, borderRadius: 999, backgroundColor: score >= n ? strengthColor : theme.surfacePressed }} />
                ))}
              </View>
            ) : null}
            <Field
              label={t.confirm}
              value={confirm}
              onChangeText={setConfirm}
              secure={!showPassword}
              onToggleSecure={() => setShowPassword((v) => !v)}
              autoComplete="new-password"
              textContentType="newPassword"
            />
            <Pressable
              onPress={() => setTerms((v) => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: terms }}
              style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 13 }}
            >
              <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, borderColor: terms ? theme.accent : theme.line, backgroundColor: terms ? theme.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                {terms ? <Ionicons name="checkmark" size={14} color={theme.onAccent} /> : null}
              </View>
              <Text style={{ color: theme.textSecondary, fontSize: 11.5, lineHeight: 17, flex: 1 }}>{t.terms}</Text>
            </Pressable>
            {error ? <Text style={{ color: theme.danger, fontSize: 12.5, marginTop: 10 }}>{error}</Text> : null}
            <View style={{ marginTop: 15 }}>
              <Btn title={t.submitRegister} loading={busy} onPress={() => void submitRegister()} />
            </View>
            <Pressable onPress={() => { setMode('login'); setError(''); }} style={{ marginTop: 14, alignItems: 'center' }}>
              <Text style={{ color: theme.accent, fontSize: 13.5 }}>{t.toLogin}</Text>
            </Pressable>
          </>
        )}
      </MotiView>

      <Text style={{ color: theme.textDisabled, fontSize: 10.5, textAlign: 'center', marginTop: 16 }}>
        {APP_VERSION_LABEL}
      </Text>

      <Modal visible={resetOpen} transparent animationType="fade" onRequestClose={() => setResetOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 18 }} onPress={() => setResetOpen(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{ backgroundColor: theme.surfaceElevated, borderColor: theme.line, borderWidth: 1, borderRadius: 18, padding: 16 }}
          >
            <Text style={{ color: theme.textPrimary, fontSize: 16, fontWeight: '800' }}>{t.resetTitle}</Text>
            {resetStep === 1 ? (
              <>
                <Text style={{ color: theme.textSecondary, fontSize: 12.5, marginTop: 6, marginBottom: 8 }}>{t.resetEmail}</Text>
                <Field label={t.email} value={resetEmail} onChangeText={setResetEmail} autoCapitalize="none" keyboardType="email-address" />
                {resetNote ? <Text style={{ color: theme.warning, fontSize: 12, marginTop: 8 }}>{resetNote}</Text> : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                  <View style={{ flex: 1 }}><Btn title={t.cancel} variant="ghost" size="s" onPress={() => setResetOpen(false)} /></View>
                  <View style={{ flex: 1 }}><Btn title={t.sendCode} size="s" loading={resetBusy} onPress={() => void sendReset()} /></View>
                </View>
              </>
            ) : (
              <>
                {resetNote ? <Text style={{ color: theme.success, fontSize: 12, marginTop: 6, marginBottom: 4 }}>{resetNote}</Text> : null}
                <Field label={t.resetCode} value={resetCode} onChangeText={setResetCode} keyboardType="number-pad" />
                <Field
                  label={t.resetNew}
                  value={resetPassword}
                  onChangeText={setResetPassword}
                  secure={!showPassword}
                  onToggleSecure={() => setShowPassword((v) => !v)}
                />
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                  <View style={{ flex: 1 }}><Btn title={t.cancel} variant="ghost" size="s" onPress={() => setResetOpen(false)} /></View>
                  <View style={{ flex: 1 }}><Btn title={t.savePassword} size="s" loading={resetBusy} onPress={() => void confirmReset()} /></View>
                </View>
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </AuthShell>
  );
}
