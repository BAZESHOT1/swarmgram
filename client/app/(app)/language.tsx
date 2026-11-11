/**
 * Страница «Язык интерфейса»: выбор языка и примеры системного формата даты/времени.
 * Сейчас доступен только русский; невыбранные языки помечены как «скоро».
 */
import React, { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useStore } from '../../src/state/useStore';
import { useTheme } from '../../src/theme/useTheme';
import { GlassCard, SettingsPage, SettingsRow, SettingsSection } from '../../src/components/settings/SettingsUI';
import { SettingsDivider, StatusBadge } from '../../src/components/settings/SettingsWidgets';

type LanguageOption = {
  code: string;
  flag: string;
  name: string;
  native: string;
  available: boolean;
};

const LANGUAGES: LanguageOption[] = [
  { code: 'ru', flag: '🇷🇺', name: 'Русский', native: 'Русский', available: true },
  { code: 'en', flag: '🇬🇧', name: 'Английский', native: 'English', available: false },
  { code: 'de', flag: '🇩🇪', name: 'Немецкий', native: 'Deutsch', available: false },
];

export default function LanguageScreen() {
  const theme = useTheme();
  // Язык живёт в store: его подхватывает синхронизация настроек и пишет в sg:locale.
  const locale = useStore((s) => s.locale);
  const setLocale = useStore((s) => s.setLocale);

  const selectLanguage = (option: LanguageOption) => {
    if (!option.available) return;
    setLocale(option.code);
  };

  const examples = useMemo(() => {
    const now = new Date();
    const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return {
      date: now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
      time,
      short: `${now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${time}`,
      deviceLocale: Intl.DateTimeFormat().resolvedOptions().locale || 'ru-RU',
    };
  }, []);

  return (
    <SettingsPage title="Язык интерфейса" subtitle="Язык меню, подсказок и системных сообщений">
      <SettingsSection title="Языки">
        <GlassCard>
          {LANGUAGES.map((option, index) => {
            const selected = option.code === locale;
            return (
              <View key={option.code}>
                {index > 0 ? <SettingsDivider /> : null}
                <Pressable
                  onPress={() => selectLanguage(option)}
                  disabled={!option.available}
                  accessibilityRole="button"
                  accessibilityLabel={`${option.name}${selected ? ', выбран' : option.available ? '' : ', скоро'}`}
                  accessibilityState={{ selected, disabled: !option.available }}
                  style={({ pressed }) => [
                    {
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 11,
                      paddingHorizontal: 10,
                      paddingVertical: 11,
                      borderRadius: 14,
                      minHeight: 52,
                      opacity: option.available ? 1 : 0.55,
                      backgroundColor: pressed && option.available ? theme.surfacePressed : 'transparent',
                    },
                  ]}
                >
                  <View
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 10,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: selected ? theme.accentSoft : theme.surfacePressed,
                    }}
                  >
                    <Text style={{ fontSize: 19 }}>{option.flag}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      style={{ color: selected ? theme.accent : theme.textPrimary, fontSize: 14.5, fontWeight: '600' }}
                      numberOfLines={1}
                    >
                      {option.name}
                    </Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 12, marginTop: 1.5 }} numberOfLines={1}>
                      {option.native}
                    </Text>
                  </View>
                  {selected ? (
                    <Ionicons name="checkmark-circle" size={21} color={theme.accent} accessibilityLabel="Выбран" />
                  ) : option.available ? (
                    <Ionicons name="ellipse-outline" size={20} color={theme.textDisabled} />
                  ) : (
                    <StatusBadge text="скоро" tone="neutral" />
                  )}
                </Pressable>
              </View>
            );
          })}
        </GlassCard>
        <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: 8, paddingHorizontal: 4, lineHeight: 16 }}>
          Сейчас интерфейс полностью на русском. Выбор языка сохраняется на этом устройстве и
          синхронизируется с другими устройствами аккаунта; он применится, когда переводы будут готовы.
        </Text>
      </SettingsSection>

      <SettingsSection title="Формат даты и времени">
        <GlassCard>
          <SettingsRow icon="calendar-outline" title="Полная дата" right={<Text style={{ color: theme.textPrimary, fontSize: 13 }}>{examples.date}</Text>} />
          <SettingsDivider />
          <SettingsRow icon="time-outline" title="Время" right={<Text style={{ color: theme.textPrimary, fontSize: 13 }}>{examples.time}</Text>} />
          <SettingsDivider />
          <SettingsRow icon="today-outline" title="Коротко" right={<Text style={{ color: theme.textPrimary, fontSize: 13 }}>{examples.short}</Text>} />
        </GlassCard>
        <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: 8, paddingHorizontal: 4, lineHeight: 16 }}>
          Формат зависит от локали устройства ({examples.deviceLocale}). Отдельных переключателей формата нет, чтобы
          не дублировать системные настройки.
        </Text>
      </SettingsSection>
    </SettingsPage>
  );
}
