/**
 * «Уведомления и звук»: звуки интерфейса, вибрация, уведомления о заявках
 * и управление приглушёнными чатами. Настройки хранятся на устройстве (kv).
 */
import React from 'react';
import { DeviceEventEmitter, Platform, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../../src/theme/useTheme';
import { useIsWide } from '../../../src/theme/useIsWide';
import {
  GlassCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from '../../../src/components/settings/SettingsUI';
import { SettingsRowsSkeleton } from '../../../src/components/skeletons/PageSkeletons';
import { useChats } from '../../../src/data/queries';
import { api } from '../../../src/data/api';
import { kv } from '../../../src/crypto/storage';
import { useStore } from '../../../src/state/useStore';

/** Читает булеву настройку из localStorage/AsyncStorage. */
function useStoredToggle(
  key: string,
  eventName: string,
  defaultValue = true,
): [boolean, (v: boolean) => void] {
  const [value, setValue] = React.useState(defaultValue);

  React.useEffect(() => {
    let alive = true;
    void kv
      .get(key)
      .then((raw) => {
        if (alive) setValue(raw === null ? defaultValue : raw !== '0');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);

  const set = React.useCallback(
    (v: boolean) => {
      setValue(v);
      void kv.set(key, v ? '1' : '0').catch(() => undefined);
      // Внешние слушатели (useHaptics/useSounds) узнают об изменении сразу.
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new Event(eventName));
        } catch {
          /* событие не критично */
        }
      } else {
        try {
          DeviceEventEmitter.emit(eventName);
        } catch {
          /* событие не критично */
        }
      }
    },
    [eventName],
  );

  return [value, set];
}

export default function NotificationsScreen() {
  const theme = useTheme();
  // На ПК вибрации нет — строку настроек показываем только на смартфоне.
  const wide = useIsWide();
  const chats = useChats();
  const mutedChats = useStore((s) => s.mutedChats);
  const toggleMuted = useStore((s) => s.toggleMuted);

  const [sounds, setSounds] = useStoredToggle('sg:sounds', 'sg-sounds-changed');
  const [haptics, setHaptics] = useStoredToggle('sg:haptics', 'sg-haptics-changed');
  const [requests, setRequests] = useStoredToggle('sg:notify-requests', 'sg-notify-requests-changed');
  const [hideContent, setHideContent] = useStoredToggle(
    'sg:notify-hide-content',
    'sg-notify-hide-content-changed',
    false,
  );

  const changeHideContent = React.useCallback(
    (value: boolean) => {
      setHideContent(value);
      // Синхронизируем с сервером: именно он формирует push для iOS/web.
      void api.setPushPreferences(value).catch(() => undefined);
    },
    [setHideContent],
  );

  const chatTitles = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const c of chats.data ?? []) map.set(c.id, c.title);
    return map;
  }, [chats.data]);

  return (
    <SettingsPage title="Уведомления и звук" subtitle="Звуки, вибрация, заявки и приглушённые чаты">
      {/* ------------------------------------------------------- звуки ---- */}
      <SettingsSection title="Звук и отклик" delay={0}>
        <GlassCard>
          <SettingsToggle
            icon="volume-medium-outline"
            title="Звуки интерфейса"
            subtitle="Клики отправки и мягкий сигнал входящих"
            value={sounds}
            onValueChange={setSounds}
          />
          {!wide ? (
            <SettingsToggle
              icon="phone-portrait-outline"
              title="Вибрация (haptics)"
              subtitle="Тактильный отклик на поддерживаемых устройствах"
              value={haptics}
              onValueChange={setHaptics}
            />
          ) : null}
          <SettingsToggle
            icon="mail-unread-outline"
            title="Заявки и приглашения"
            subtitle="Сообщать о новых заявках в группы и приглашениях"
            value={requests}
            onValueChange={setRequests}
          />
        </GlassCard>
        <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 8, paddingHorizontal: 4 }}>
          Настройки применяются на этом устройстве. Звук можно отключить отдельно для каждого чата ниже.
        </Text>
      </SettingsSection>

      {/* ------------------------------------------------ push-контент ----- */}
      <SettingsSection title="Push-уведомления" delay={30}>
        <GlassCard>
          <SettingsToggle
            icon="eye-off-outline"
            title="Скрывать отправителя и текст"
            subtitle="В уведомлениях будет только «Klinto · Новое сообщение»"
            value={hideContent}
            onValueChange={changeHideContent}
          />
        </GlassCard>
        <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 8, paddingHorizontal: 4 }}>
          {hideContent
            ? 'Текст и имя отправителя не показываются на экране блокировки и в шторке.'
            : 'Уведомления показывают отправителя, группу/канал и текст сообщения.'}
        </Text>
      </SettingsSection>

      {/* --------------------------------------------- приглушённые чаты -- */}
      <SettingsSection
        title="Приглушённые чаты"
        delay={60}
        right={<Text style={{ color: theme.textDisabled, fontSize: 12 }}>{mutedChats.length}</Text>}
      >
        <GlassCard>
          {chats.isLoading ? (
            <SettingsRowsSkeleton rows={3} />
          ) : mutedChats.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 24, gap: 8, paddingHorizontal: 16 }}>
              <Ionicons name="notifications-off-outline" size={26} color={theme.textDisabled} />
              <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '600' }}>
                Пока нет приглушённых чатов
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 12.5, textAlign: 'center', lineHeight: 18 }}>
                Отключить звук можно в меню чата. Приглушённые чаты не показывают бейдж непрочитанных.
              </Text>
            </View>
          ) : (
            mutedChats.map((id, index) => (
              <SettingsRow
                key={id}
                icon="notifications-off-outline"
                title={chatTitles.get(id) ?? `Чат ${id.slice(0, 6)}`}
                subtitle="Уведомления отключены"
                delay={index * 30}
                onPress={() => toggleMuted(id)}
                right={
                  <View
                    style={{
                      borderWidth: 1,
                      borderColor: theme.accent,
                      backgroundColor: theme.accentSoft,
                      borderRadius: 999,
                      paddingHorizontal: 9,
                      paddingVertical: 4,
                    }}
                  >
                    <Text style={{ color: theme.accent, fontSize: 11.5, fontWeight: '700' }}>Со звуком</Text>
                  </View>
                }
              />
            ))
          )}
        </GlassCard>
        <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 8, paddingHorizontal: 4 }}>
          «Со звуком» возвращает уведомления чату. Список хранится локально и не синхронизируется с сервером.
        </Text>
      </SettingsSection>
    </SettingsPage>
  );
}
