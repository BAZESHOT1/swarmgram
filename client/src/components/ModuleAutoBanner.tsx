/**
 * Глобальное окно модуля: найден / подключается / подключён.
 * Показывается поверх любого экрана приложения.
 */
import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/useTheme';
import { useReducedMotion } from './useReducedMotion';
import { useModuleConnection } from '../modules/ModuleProvider';

export function ModuleAutoBanner() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const connection = useModuleConnection();
  const auto = connection.autoModule;

  if (!auto) return null;

  const connecting = auto.phase === 'connecting';
  const connected = auto.phase === 'connected';
  const failed = auto.phase === 'failed';

  const title = connected
    ? 'Модуль подключён'
    : failed
      ? 'Не удалось подключить'
      : connecting
        ? 'Подключение модуля'
        : 'Найден модуль SwarmGram';

  return (
    <MotiView
      pointerEvents="box-none"
      from={reduced ? { opacity: 0 } : { opacity: 0, translateY: -16 }}
      animate={{ opacity: 1, translateY: 0 }}
      transition={reduced ? { type: 'timing', duration: 0 } : { type: 'timing', duration: 180 }}
      style={{
        position: 'absolute',
        top: insets.top + 8,
        left: 12,
        right: 12,
        zIndex: 300,
        elevation: 30,
      }}
    >
      <View
        style={[
          {
            borderRadius: 16,
            borderWidth: 1,
            borderColor: connected ? theme.success : failed ? theme.danger : theme.glassBorder,
            backgroundColor: theme.surfaceElevated,
            padding: 12,
            gap: 9,
            shadowColor: '#000',
            shadowOpacity: 0.28,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 8 },
          },
        ]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View
            style={{
              width: 38,
              height: 38,
              borderRadius: 12,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: connected ? theme.successSoft : failed ? theme.dangerSoft : theme.accentSoft,
            }}
          >
            {connected ? (
              <Ionicons name="checkmark-circle" size={22} color={theme.success} />
            ) : connecting ? (
              <ActivityIndicator color={theme.accent} />
            ) : failed ? (
              <Ionicons name="alert-circle-outline" size={22} color={theme.danger} />
            ) : (
              <Ionicons name="bluetooth" size={20} color={theme.accent} />
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '800' }} numberOfLines={1}>
              {title}
            </Text>
            <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
              {auto.name}
              {auto.isMine ? ' · ваш модуль' : ' · не привязан к аккаунту'}
            </Text>
          </View>
        </View>

        {connecting ? (
          <View style={{ gap: 5 }}>
            <View style={{ height: 3, borderRadius: 999, backgroundColor: theme.surfacePressed, overflow: 'hidden' }}>
              <MotiView
                animate={reduced ? { translateX: 0 } : { translateX: [-120, 220] }}
                transition={
                  reduced ? { type: 'timing', duration: 0 } : { loop: true, type: 'timing', duration: 1200 }
                }
                style={{ width: 120, height: 3, borderRadius: 999, backgroundColor: theme.accent }}
              />
            </View>
            <Text style={{ color: theme.textDisabled, fontSize: 11 }}>Устанавливаем связь с модулем…</Text>
          </View>
        ) : null}

        {failed ? (
          <Text style={{ color: theme.danger, fontSize: 11.5, lineHeight: 16 }} numberOfLines={3}>
            {auto.error ?? 'Проверьте, что модуль включён и находится рядом.'}
          </Text>
        ) : null}

        {connected ? null : (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {!connecting ? (
              <Pressable
                onPress={() => void connection.acceptAutoModule()}
                accessibilityRole="button"
                accessibilityLabel={failed ? 'Повторить подключение' : 'Подключить модуль'}
                style={({ pressed }) => ({
                  flex: 1,
                  minHeight: 38,
                  borderRadius: 12,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.accent,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text style={{ color: theme.onAccent, fontSize: 13, fontWeight: '800' }}>
                  {failed ? 'Повторить' : 'Подключить'}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={connection.dismissAutoModule}
              accessibilityRole="button"
              accessibilityLabel={connecting ? 'Отменить подключение' : 'Отменить'}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 38,
                borderRadius: 12,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: theme.line,
                backgroundColor: theme.surfacePressed,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '600' }}>
                {connecting ? 'Отменить подключение' : 'Отменить'}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </MotiView>
  );
}
