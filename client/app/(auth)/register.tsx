import React from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { AuthCard } from '../../src/components/auth/AuthCard';

/** Регистрация открывается на том же экране, сразу во вкладке «Регистрация». */
export default function RegisterScreen() {
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <AuthCard key="register" initialMode="register" />
    </KeyboardAvoidingView>
  );
}
