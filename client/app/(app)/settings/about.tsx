/**
 * «О приложении»: версия, лицензии, политика и сведения о шифровании.
 * Выход из аккаунта живёт на главной странице настроек.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../../src/theme/useTheme';
import {
  GlassCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '../../../src/components/settings/SettingsUI';
import { ProfileModal } from '../../../src/components/profile/ProfileModal';
import { useMe } from '../../../src/data/queries';

import { APP_VERSION_LABEL } from '../../../src/version';

const VERSION = APP_VERSION_LABEL;

type InfoKind = 'licenses' | 'privacy' | 'project' | null;

const INFO: Record<Exclude<InfoKind, null>, { title: string; body: string }> = {
  licenses: {
    title: 'Лицензии',
    body:
      'SwarmGram распространяется как частный проект. Используются открытые библиотеки: React и React Native, Expo, Moti, Zustand, TanStack Query, @noble (криптография), Fastify и PostgreSQL. Полные тексты лицензий зависимостей доступны в репозитории проекта.',
  },
  privacy: {
    title: 'Политика конфиденциальности',
    body:
      'Обычные чаты шифруются серверным ключом: содержимое доступно Hub для доставки и восстановления истории на новых устройствах. Секретные чаты используют сквозное шифрование (E2E): ключ создаётся на устройстве и раскладывается по устройствам участников, сервер не может расшифровать сообщения. Пароль и приватные ключи никогда не отправляются на сервер в открытом виде; резерв ключей хранится в зашифрованном виде.',
  },
  project: {
    title: 'О проекте',
    body:
      'SwarmGram — децентрализованный мессенджер: Hub отвечает за аккаунты и маршрутизацию, узлы хранения держат зашифрованные объекты, а ESP32-модули позволяют держать связь без интернета. Проект развивается как эксперимент в области приватной связи и mesh-сетей.',
  },
};

export default function AboutScreen() {
  const theme = useTheme();
  const router = useRouter();
  const me = useMe();
  const [info, setInfo] = React.useState<InfoKind>(null);
  const isAdmin = me.data?.role === 'admin';

  const infoData = info ? INFO[info] : null;

  return (
    <SettingsPage title="О приложении" subtitle="Версия, правовая информация и шифрование">
      <SettingsSection title="SwarmGram" delay={0}>
        <GlassCard>
          <SettingsRow icon="layers-outline" title="Версия" subtitle="Beta-сборка" right={<Text style={[styles.mono, { color: theme.textSecondary }]}>{VERSION}</Text>} />
          <SettingsRow
            icon="document-text-outline"
            title="Лицензии"
            subtitle="Открытые библиотеки и компоненты"
            onPress={() => setInfo('licenses')}
          />
          <SettingsRow
            icon="lock-closed-outline"
            title="Политика конфиденциальности"
            subtitle="Как хранятся сообщения и ключи"
            onPress={() => setInfo('privacy')}
          />
          <SettingsRow
            icon="sparkles-outline"
            title="О проекте"
            subtitle="Зачем нужен SwarmGram"
            onPress={() => setInfo('project')}
          />
          {isAdmin ? (
            <SettingsRow
              icon="shield-checkmark-outline"
              title="Админка"
              subtitle="Управление аккаунтами и сетью"
              onPress={() => router.push('/admin' as never)}
            />
          ) : null}
        </GlassCard>
      </SettingsSection>

      <SettingsSection title="Шифрование" delay={60}>
        <GlassCard>
          <SettingsRow
            icon="chatbubble-ellipses-outline"
            title="Обычные чаты"
            subtitle="Серверный ключ: история синхронизируется между устройствами"
          />
          <SettingsRow
            icon="key-outline"
            title="Секретные чаты"
            subtitle="E2E: ключ только на устройствах участников, сервер не расшифровывает"
          />
          <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
            <Text style={{ color: theme.textDisabled, fontSize: 11.5, lineHeight: 17 }}>
              Резерв ключей шифруется паролем на устройстве (PBKDF2 + AES-GCM) и хранится на Hub только в виде
              зашифрованного блоба.
            </Text>
          </View>
        </GlassCard>
      </SettingsSection>

      <Text style={{ color: theme.textDisabled, fontSize: 11.5, textAlign: 'center', marginTop: 6 }}>
        SwarmGram {VERSION} · сделано для приватной связи
      </Text>

      <ProfileModal visible={info !== null} title={infoData?.title ?? ''} onClose={() => setInfo(null)}>
        <Text style={{ color: theme.textSecondary, fontSize: 14, lineHeight: 21 }}>{infoData?.body ?? ''}</Text>
      </ProfileModal>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  mono: { fontSize: 12.5, fontWeight: '600', fontVariant: ['tabular-nums'] as never },
});
