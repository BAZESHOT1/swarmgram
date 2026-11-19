/**
 * Глобальный error boundary: вместо чёрного экрана на native показывает
 * читаемую ошибку и кнопку «Повторить». Помогает диагностировать iOS-сборки.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/useTheme';
import { APP_VERSION_LABEL } from '../version';

interface State {
  error: Error | null;
  stack: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ stack: info.componentStack || '' });
    console.error('[Kinto] render error:', error?.message, error?.stack, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return <ErrorScreen error={this.state.error} stack={this.state.stack} onRetry={() => this.setState({ error: null, stack: '' })} />;
  }
}

function ErrorScreen({ error, stack, onRetry }: { error: Error; stack: string; onRetry: () => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <Text style={{ color: theme.textPrimary, fontSize: 20, fontWeight: '800', textAlign: 'center' }}>
        Что-то пошло не так
      </Text>
      <Text selectable style={{ color: theme.textSecondary, fontSize: 12.5, textAlign: 'center', marginTop: 10, lineHeight: 18 }}>
        {error.message || 'Неизвестная ошибка'}
      </Text>
      <Text selectable style={{ color: theme.textDisabled, fontSize: 9, textAlign: 'left', marginTop: 10 }}>
        {(error.stack || '').slice(0, 1200)}
        {'\n'}
        {(stack || '').slice(0, 1200)}
      </Text>
      <Text style={{ color: theme.textDisabled, fontSize: 10.5, marginTop: 8 }}>{APP_VERSION_LABEL}</Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Повторить"
        style={({ pressed }) => ({
          marginTop: 20,
          paddingHorizontal: 22,
          paddingVertical: 12,
          borderRadius: 14,
          backgroundColor: theme.accent,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Text style={{ color: theme.onAccent, fontSize: 14, fontWeight: '700' }}>Повторить</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
});
