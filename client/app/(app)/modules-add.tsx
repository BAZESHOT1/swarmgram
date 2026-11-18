/**
 * «Добавить модуль»: выбор между подключением уже прошитого модуля и прошивкой нового.
 * Оба сценария открывают мастер ConnectModuleFlow в нужном режиме.
 */
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { GlassCard, SettingsPage } from '../../src/components/settings/SettingsUI';
import { ConnectModuleFlow } from '../../src/components/modules/ConnectModuleFlow';
import { useTheme } from '../../src/theme/useTheme';

type Mode = 'prepared' | 'flash';

function Choice({
  icon,
  title,
  text,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  text: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}>
      {({ pressed }) => (
        <GlassCard style={{ marginBottom: 10, opacity: pressed ? 0.8 : 1 }}>
          <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View
              style={{
                width: 48,
                height: 48,
                borderRadius: 14,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: theme.accentSoft,
              }}
            >
              <Ionicons name={icon} size={24} color={theme.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.textPrimary, fontSize: 15, fontWeight: '800' }}>{title}</Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 3, lineHeight: 17 }}>{text}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={theme.textDisabled} />
          </View>
        </GlassCard>
      )}
    </Pressable>
  );
}

export default function ModulesAddScreen() {
  const [mode, setMode] = useState<Mode | null>(null);
  return (
    <SettingsPage title="Добавить модуль">
      <View style={{ height: 12 }} />
      <Choice
        icon="bluetooth-outline"
        title="Добавить прошитый модуль"
        text="Модуль уже с прошивкой KMesh: найдём его по Bluetooth или USB и привяжем к аккаунту по MAC."
        onPress={() => setMode('prepared')}
      />
      <Choice
        icon="hardware-chip-outline"
        title="Прошить новый модуль"
        text="Выберите тип, интерфейсы и плату — соберём прошивку и запишем её по USB."
        onPress={() => setMode('flash')}
      />
      <ConnectModuleFlow
        visible={mode !== null}
        initialMode={mode ?? undefined}
        onClose={() => setMode(null)}
        onComplete={() => {
          setMode(null);
          router.back();
        }}
      />
    </SettingsPage>
  );
}
