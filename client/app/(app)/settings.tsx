/**
 * Главный экран настроек: только карточка профиля, поиск и строки-разделы.
 * Порядок: Профиль → Уведомления и звук → Внешний вид → Приватность →
 * Безопасность → Сеть → О приложении → Выйти из аккаунта.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/theme/useTheme';
import { motion } from '../../src/theme/motion';
import { Avatar } from '../../src/components/Avatar';
import {
  GlassCard,
  SettingsRow,
  SettingsSection,
} from '../../src/components/settings/SettingsUI';
import { SettingsDivider } from '../../src/components/settings/SettingsWidgets';
import { HoldToConfirm } from '../../src/components/settings/HoldToConfirm';
import { SettingsDashboardSkeleton } from '../../src/components/skeletons/PageSkeletons';
import { PressableScale } from '../../src/components/profile/PressableScale';
import { useReducedMotion } from '../../src/components/useReducedMotion';
import { useMe, useModules, useNodes } from '../../src/data/queries';
import { hasNetworkAccess } from '../../src/data/access';
import { logout } from '../../src/data/auth';
import { useStore } from '../../src/state/useStore';

const VERSION = '1.0.0';

/** Описание одной строки-раздела на главной странице настроек. */
interface SectionRow {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
  route: string;
  /** Слова, по которым строка находится через поиск. */
  keywords: string[];
}

const SECTION_ROWS: SectionRow[] = [
  {
    key: 'notifications',
    icon: 'notifications-outline',
    title: 'Уведомления и звук',
    subtitle: 'Звуки, вибрация, приглушённые чаты, заявки',
    route: '/settings/notifications',
    keywords: ['уведомления', 'звук', 'звуки', 'вибрация', 'haptics', 'приглушённые', 'заявки', 'приглашения'],
  },
  {
    key: 'appearance',
    icon: 'color-palette-outline',
    title: 'Внешний вид',
    subtitle: 'Тема, акцентный цвет, язык',
    route: '/settings/appearance',
    keywords: ['внешний вид', 'оформление', 'тема', 'тёмная', 'светлая', 'акцент', 'цвет', 'язык'],
  },
  {
    key: 'privacy',
    icon: 'lock-closed-outline',
    title: 'Приватность',
    subtitle: 'Приглашения в группы, блокировки',
    route: '/settings/privacy',
    keywords: ['приватность', 'приглашения', 'блокировки', 'заблокированные', 'blacklist'],
  },
  {
    key: 'security',
    icon: 'shield-checkmark-outline',
    title: 'Безопасность',
    subtitle: 'Пароль, устройства и сессии, удаление аккаунта',
    route: '/settings/security',
    keywords: ['безопасность', 'пароль', 'сессии', 'устройства', 'удаление', 'аккаунт'],
  },
  {
    key: 'modules',
    icon: 'hardware-chip-outline',
    title: 'Модули',
    subtitle: 'Карта сети, подключение, прошивка',
    route: '/modules',
    keywords: ['модули', 'esp32', 'ble', 'bluetooth', 'usb', 'прошивка', 'карта', 'mesh', 'носимый', 'шлюз'],
  },
  {
    key: 'network',
    icon: 'server-outline',
    title: 'Сеть',
    subtitle: 'Монитор узлов, вклад и частые вопросы',
    route: '/nodes',
    keywords: ['сеть', 'узлы', 'монитор', 'статистика', 'хранилище', 'квота', 'трафик', 'вклад'],
  },
  {
    key: 'about',
    icon: 'information-circle-outline',
    title: 'О приложении',
    subtitle: 'Версия, лицензии, политика, шифрование',
    route: '/settings/about',
    keywords: ['о приложении', 'версия', 'лицензии', 'политика', 'конфиденциальность', 'о проекте', 'шифрование'],
  },
];

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const reduced = useReducedMotion();
  const me = useMe();
  const nodes = useNodes();
  const modules = useModules();
  const session = useStore((s) => s.session);
  const moduleLink = useStore((s) => s.transportModule);
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    if (me.data) useStore.getState().setMe(me.data);
  }, [me.data?.id]);

  const username = me.data?.username ?? session?.username ?? '';
  const displayName = me.data?.displayName || username || '—';
  const isAdmin = me.data?.role === 'admin';
  const nodeList = (nodes.data ?? []).filter(Boolean);

  const q = query.trim().toLowerCase();
  /** Совпадение строки с поисковым запросом (пустой запрос — показываем всё). */
  const match = React.useCallback(
    (...values: Array<string | undefined | null>) =>
      !q || values.some((v) => Boolean(v) && String(v).toLowerCase().includes(q)),
    [q],
  );

  const go = (to: string) => router.push(to as never);

  const profileVisible = match('профиль', displayName, username, 'аккаунт', '@');
  const adminVisible = isAdmin && match('админка', 'админ', 'управление', 'аккаунты', 'сеть');
  const logoutVisible = match('выйти', 'выход', 'аккаунт', 'logout');

  const visibleRows = SECTION_ROWS.filter(
    (row) => match(row.title, row.subtitle, ...row.keywords) && (row.key !== 'network' || hasNetworkAccess(me.data)),
  );

  const anyVisible =
    profileVisible ||
    adminVisible ||
    logoutVisible ||
    visibleRows.length > 0;

  async function doLogout() {
    await logout();
    router.replace('/login' as never);
  }

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 140 }} showsVerticalScrollIndicator={false}>
      <View style={styles.wrap}>
        <View style={styles.head}>
          <Text style={{ color: theme.textPrimary, fontSize: 26, fontWeight: '800' }}>Настройки</Text>
        </View>

        {/* Поиск по названиям разделов */}
        <MotiView
          from={reduced ? { opacity: 1 } : { opacity: 0, translateY: -8 }}
          animate={{ opacity: 1, translateY: 0 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.spring}
          style={[styles.search, { backgroundColor: theme.glass, borderColor: theme.glassBorder }]}
        >
          <Ionicons name="search" size={17} color={theme.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Поиск по настройкам"
            placeholderTextColor={theme.textDisabled}
            accessibilityLabel="Поиск по настройкам"
            autoCapitalize="none"
            style={[styles.searchInput, { color: theme.textPrimary }]}
          />
          {query ? (
            <PressableScale
              onPress={() => setQuery('')}
              accessibilityRole="button"
              accessibilityLabel="Очистить поиск"
              scaleTo={0.86}
            >
              <Ionicons name="close-circle" size={17} color={theme.textDisabled} />
            </PressableScale>
          ) : null}
        </MotiView>

        {me.isLoading && !session ? (
          <SettingsDashboardSkeleton />
        ) : (
          <MotiView
            key={q ? 'search' : 'all'}
            from={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.quick}
          >
            {!anyVisible ? (
              <GlassCard style={{ marginTop: 8 }}>
                <View style={{ alignItems: 'center', paddingVertical: 26, gap: 8 }}>
                  <Ionicons name="search-outline" size={26} color={theme.textDisabled} />
                  <Text style={{ color: theme.textPrimary, fontSize: 15, fontWeight: '600' }}>Ничего не найдено</Text>
                  <Text style={{ color: theme.textSecondary, fontSize: 12.5, textAlign: 'center' }}>
                    Попробуйте другой запрос, например «пароль», «тема» или «узлы».
                  </Text>
                </View>
              </GlassCard>
            ) : null}

            {/* ------------------------------------------------ профиль ---- */}
            {profileVisible ? (
              <SettingsSection title="Профиль" delay={0}>
                <GlassCard>
                  <PressableScale
                    onPress={() =>
                      username
                        ? go(`/user/${encodeURIComponent(username)}`)
                        : useStore.getState().pushToast({ kind: 'error', message: 'Профиль ещё не загружен' })
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`Открыть профиль @${username}`}
                    style={styles.profileRow}
                  >
                    <Avatar
                      name={displayName}
                      avatar={me.data?.avatar}
                      hasModule={moduleLink !== null}
                      hasNode={nodeList.some((n) => n.status !== 'banned')}
                      size={52}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ color: theme.textPrimary, fontSize: 15.5, fontWeight: '700' }} numberOfLines={1}>
                        {displayName}
                      </Text>
                      <Text style={{ color: theme.textSecondary, fontSize: 13, marginTop: 1 }} numberOfLines={1}>
                        @{username || '—'}
                      </Text>
                      <Text style={{ color: theme.textDisabled, fontSize: 11.5, marginTop: 2 }}>
                        План {me.data?.plan === 'pro' ? 'Pro' : 'Free'} · редактирование в профиле
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={theme.textDisabled} />
                  </PressableScale>
                </GlassCard>
              </SettingsSection>
            ) : null}

            {/* ------------------------------------------ основные строки --- */}
            {visibleRows.length > 0 ? (
              <SettingsSection title="Разделы" delay={40}>
                <GlassCard>
                  {visibleRows.map((row, index) => (
                    <React.Fragment key={row.key}>
                      {index > 0 ? <SettingsDivider /> : null}
                      <SettingsRow
                        icon={row.icon}
                        title={row.title}
                        subtitle={row.subtitle}
                        onPress={() => go(row.route)}
                        delay={index * motion.staggerStepMs}
                      />
                    </React.Fragment>
                  ))}
                </GlassCard>
              </SettingsSection>
            ) : null}

            {/* --------------------------------------- админка (если админ) -- */}
            {adminVisible ? (
              <SettingsSection title="Управление" delay={80}>
                <GlassCard>
                  <SettingsRow
                    icon="construct-outline"
                    title="Админка"
                    subtitle="Аккаунты, узлы, модули, чаты"
                    onPress={() => go('/admin')}
                  />
                </GlassCard>
              </SettingsSection>
            ) : null}

            {/* -------------------------------------------------- выход ----- */}
            {logoutVisible ? (
              <SettingsSection title="Аккаунт" delay={120}>
                <HoldToConfirm
                  title="Выйти из аккаунта"
                  subtitle="Удерживайте 1 секунду для выхода"
                  onConfirmed={() => void doLogout()}
                />
                <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 8, paddingHorizontal: 4 }}>
                  Ключи шифрования останутся на этом устройстве. При следующем входе резерв ключей восстановится по паролю.
                </Text>
              </SettingsSection>
            ) : null}
          </MotiView>
        )}

        <Text style={{ color: theme.textDisabled, fontSize: 11.5, textAlign: 'center', marginTop: 6 }}>
          Kinto {VERSION}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 10 },
  head: { marginBottom: 14 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 18,
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 14,
  },
});
