import React from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { AuthCard } from '../../src/components/auth/AuthCard';

/** Вход и регистрация — один экран с переключателем. */
export default function LoginScreen() {
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <AuthCard key="login" initialMode="login" />
    </KeyboardAvoidingView>
  );
}
