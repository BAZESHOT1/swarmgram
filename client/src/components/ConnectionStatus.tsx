/** Глобальный индикатор соединения: «Соединение» / «Обновление». */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/useTheme';
import { useStore } from '../state/useStore';

export type ConnectionPhase = 'connecting' | 'updating' | null;

// Глобально между экранами: открытие чата не должно снова показывать «Обновление».
let lastOnline: boolean | null = null;

export function useConnectionPhase(): ConnectionPhase {
  const online = useStore((s) => s.transportOnline);
  const [updating, setUpdating] = React.useState(false);

  React.useEffect(() => {
    const previous = lastOnline;
    lastOnline = online;
    if (!online) {
      setUpdating(false);
      return undefined;
    }
    // Показываем «Обновление» только при реальном переходе offline → online.
    if (previous === false) {
      setUpdating(true);
      const timer = setTimeout(() => setUpdating(false), 1600);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [online]);

  if (!online) return 'connecting';
  if (updating) return 'updating';
  return null;
}

export const CONNECTION_LABEL: Record<'connecting' | 'updating', string> = {
  connecting: 'Соединение',
  updating: 'Обновление',
};

export function ConnectionPill({ phase }: { phase: ConnectionPhase }) {
  const theme = useTheme();
  if (!phase) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 999,
        backgroundColor: phase === 'connecting' ? theme.warningSoft : theme.accentSoft,
      }}
    >
      <Ionicons
        name={phase === 'connecting' ? 'cloud-offline-outline' : 'sync-outline'}
        size={12}
        color={phase === 'connecting' ? theme.warning : theme.accent}
      />
      <Text style={{ color: phase === 'connecting' ? theme.warning : theme.accent, fontSize: 11, fontWeight: '700' }}>
        {CONNECTION_LABEL[phase]}
      </Text>
    </View>
  );
}
