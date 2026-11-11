/**
 * Составные скелетоны страниц: профиль, информация о чате, настройки,
 * узлы и модули. Макет повторяет реальные карточки, поэтому контент
 * «подменяется» без скачка вёрстки.
 */
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { SkeletonBlock, SkeletonChatRow, SkeletonCircle } from './Skeleton';

function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.glass, borderColor: theme.glassBorder }, style]}>{children}</View>
  );
}

/** Одна строка списка: иконка/аватар + две линии. */
export function DeviceRowSkeleton({ size = 34 }: { size?: number }) {
  return (
    <View style={styles.listRow}>
      <SkeletonCircle size={size} />
      <View style={{ flex: 1, gap: 7 }}>
        <SkeletonBlock width="54%" height={12} radius={6} />
        <SkeletonBlock width="76%" height={10} radius={5} />
      </View>
    </View>
  );
}

/** Строки списка устройств / блокировок / статистики. */
export function SettingsRowsSkeleton({
  rows = 4,
  size = 34,
  right = false,
}: {
  rows?: number;
  size?: number;
  right?: boolean;
}) {
  return (
    <View>
      {Array.from({ length: rows }).map((_, index) => (
        <View key={index} style={styles.listRow}>
          <SkeletonCircle size={size} />
          <View style={{ flex: 1, gap: 7 }}>
            <SkeletonBlock width={index % 2 === 0 ? '52%' : '44%'} height={12} radius={6} />
            <SkeletonBlock width={index % 3 === 0 ? '78%' : '64%'} height={10} radius={5} />
          </View>
          {right ? <SkeletonBlock width={42} height={12} radius={6} /> : null}
        </View>
      ))}
    </View>
  );
}

/** Плитки сводки: ёмкость, онлайн, вкладчики. */
export function SummaryTilesSkeleton({ count = 4 }: { count?: number }) {
  const theme = useTheme();
  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <View
          key={index}
          style={[styles.summaryTile, { backgroundColor: theme.glass, borderColor: theme.glassBorder }]}
        >
          <SkeletonBlock width={26} height={26} radius={8} />
          <SkeletonBlock width="68%" height={16} radius={6} style={{ marginTop: 7 }} />
          <SkeletonBlock width="86%" height={9} radius={5} style={{ marginTop: 7 }} />
          <SkeletonBlock width="58%" height={9} radius={5} style={{ marginTop: 5 }} />
        </View>
      ))}
    </>
  );
}

/** Карточки узлов/модулей: шапка, статус, прогресс и нижняя строка. */
export function CardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <View>
      {Array.from({ length: count }).map((_, index) => (
        <Card key={index} style={{ marginBottom: 8 }}>
          <View style={styles.cardHead}>
            <SkeletonBlock width={34} height={34} radius={10} />
            <View style={{ flex: 1, gap: 7 }}>
              <SkeletonBlock width="52%" height={13} radius={6} />
              <SkeletonBlock width="74%" height={10} radius={5} />
            </View>
            <SkeletonBlock width={54} height={18} radius={999} />
          </View>
          <View style={styles.progressRow}>
            <SkeletonBlock width="48%" height={10} radius={5} />
            <SkeletonBlock width={34} height={10} radius={5} />
          </View>
          <SkeletonBlock width="100%" height={5} radius={999} />
          <View style={[styles.cardHead, { marginTop: 12, marginBottom: 0 }]}>
            <SkeletonBlock width="58%" height={10} radius={5} />
            <SkeletonBlock width={74} height={28} radius={9} />
          </View>
        </Card>
      ))}
    </View>
  );
}

/** Скелетон страницы профиля: hero, карточка, действия, чаты и устройства. */
export function ProfileSkeleton({ onBack }: { onBack?: () => void }) {
  const theme = useTheme();
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 80 }} showsVerticalScrollIndicator={false}>
      <View style={styles.center}>
        <View style={styles.hero}>
          <SkeletonCircle size={168} />
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Назад"
            hitSlop={8}
            style={[styles.backBtn, { backgroundColor: theme.dark ? 'rgba(10,14,20,0.45)' : 'rgba(255,255,255,0.7)' }]}
          >
            <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
          </Pressable>
          <View style={styles.heroActions}>
            <SkeletonCircle size={38} />
            <SkeletonCircle size={38} />
          </View>
        </View>

        <View style={styles.body}>
          <Card style={{ marginTop: -38 }}>
            <View style={styles.avatarRow}>
              <SkeletonCircle size={84} />
              <View style={{ flex: 1, gap: 8 }}>
                <SkeletonBlock width="58%" height={20} radius={8} />
                <SkeletonBlock width="34%" height={13} radius={7} />
                <SkeletonBlock width="26%" height={11} radius={6} />
              </View>
            </View>
            <SkeletonBlock width="92%" height={12} radius={6} style={{ marginTop: 16 }} />
            <SkeletonBlock width="70%" height={12} radius={6} style={{ marginTop: 8 }} />
          </Card>

          <View style={styles.actionsGrid}>
            {[0, 1, 2].map((index) => (
              <SkeletonBlock key={index} height={58} radius={16} style={styles.actionTile} />
            ))}
          </View>

          <Card style={{ marginTop: 12 }}>
            <SkeletonBlock width="38%" height={11} radius={6} style={{ marginBottom: 8 }} />
            {[0, 1, 2].map((index) => (
              <SkeletonChatRow key={index} />
            ))}
          </Card>

          <Card style={{ marginTop: 12 }}>
            <SkeletonBlock width="46%" height={11} radius={6} style={{ marginBottom: 8 }} />
            {[0, 1, 2, 3].map((index) => (
              <DeviceRowSkeleton key={index} />
            ))}
          </Card>
        </View>
      </View>
    </ScrollView>
  );
}

/** Скелетон страницы информации о чате: hero, действия, участники, медиа. */
export function ChatInfoSkeleton({ onBack }: { onBack?: () => void }) {
  const theme = useTheme();
  return (
    <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 80 }} showsVerticalScrollIndicator={false}>
      <View style={styles.center}>
        <View style={styles.topRow}>
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Назад"
            hitSlop={8}
            style={[styles.backBtn, { backgroundColor: theme.dark ? 'rgba(24,32,46,0.6)' : 'rgba(255,255,255,0.7)' }]}
          >
            <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
          </Pressable>
          <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: 16 }}>Информация о чате</Text>
          <View style={{ width: 38 }} />
        </View>

        <Card style={{ marginBottom: 10 }}>
          <View style={styles.heroCard}>
            <SkeletonCircle size={78} />
            <View style={{ flex: 1, gap: 8 }}>
              <SkeletonBlock width="58%" height={20} radius={8} />
              <SkeletonBlock width="36%" height={12} radius={6} />
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 2 }}>
                <SkeletonBlock width={82} height={20} radius={999} />
                <SkeletonBlock width={96} height={20} radius={999} />
              </View>
            </View>
          </View>
        </Card>

        <View style={styles.actionsGrid}>
          {[0, 1, 2, 3].map((index) => (
            <SkeletonBlock key={index} height={78} radius={16} style={styles.actionTile} />
          ))}
        </View>

        <Card>
          <SkeletonBlock width="42%" height={11} radius={6} style={{ marginBottom: 8 }} />
          {[0, 1, 2, 3].map((index) => (
            <View key={index} style={styles.listRow}>
              <SkeletonCircle size={38} />
              <View style={{ flex: 1, gap: 7 }}>
                <SkeletonBlock width="50%" height={12} radius={6} />
                <SkeletonBlock width="34%" height={10} radius={5} />
              </View>
              <SkeletonBlock width={56} height={18} radius={999} />
            </View>
          ))}
        </Card>

        <Card style={{ marginTop: 10 }}>
          <SkeletonBlock width="30%" height={11} radius={6} style={{ marginBottom: 10 }} />
          <View style={styles.mediaGrid}>
            {[0, 1, 2, 3].map((index) => (
              <SkeletonBlock key={index} width="23%" height={72} radius={10} />
            ))}
          </View>
        </Card>
      </View>
    </ScrollView>
  );
}

/** Скелетон главной страницы настроек: карточка профиля и шесть строк-секций. */
export function SettingsDashboardSkeleton() {
  return (
    <View>
      <Card>
        <View style={styles.avatarRow}>
          <SkeletonCircle size={52} />
          <View style={{ flex: 1, gap: 8 }}>
            <SkeletonBlock width="46%" height={15} radius={7} />
            <SkeletonBlock width="30%" height={12} radius={6} />
            <SkeletonBlock width="56%" height={10} radius={5} />
          </View>
        </View>
      </Card>

      <View style={{ height: 22 }} />

      <SkeletonBlock width="22%" height={11} radius={6} style={{ marginBottom: 8, marginLeft: 4 }} />
      <Card>
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <View key={index} style={[styles.listRow, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(127,127,127,0.16)' }]}>
            <SkeletonBlock width={34} height={34} radius={10} />
            <View style={{ flex: 1, gap: 7 }}>
              <SkeletonBlock width={index % 2 === 0 ? '48%' : '38%'} height={12} radius={6} />
              <SkeletonBlock width={index % 3 === 0 ? '72%' : '58%'} height={10} radius={5} />
            </View>
            <SkeletonBlock width={10} height={10} radius={5} />
          </View>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { width: '100%', maxWidth: 720, alignSelf: 'center' },
  body: { paddingHorizontal: 12 },
  card: { borderWidth: 1, borderRadius: 20, padding: 14 },
  hero: { height: 178, width: '100%', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  backBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  heroActions: { position: 'absolute', top: 8, right: 8, flexDirection: 'row', gap: 8 },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  actionsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  actionTile: { flexGrow: 1, flexBasis: 96, minWidth: 96 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 2 },
  summaryTile: { flexGrow: 1, flexBasis: 96, minWidth: 96, borderWidth: 1, borderRadius: 18, padding: 10 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginBottom: 12 },
  progressRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, marginBottom: 8 },
  heroCard: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
