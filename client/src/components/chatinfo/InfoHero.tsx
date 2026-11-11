import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { Avatar } from '../Avatar';
import { useReducedMotion } from '../useReducedMotion';
import { PressableScale } from '../profile/PressableScale';
import { GlassCard } from '../profile/Glass';

const TYPE_LABEL: Record<string, string> = { direct: 'Личный диалог', group: 'Группа', channel: 'Канал' };

/** Hero экрана информации о чате: размытый ореол, аватар, название и бейджи. */
export function InfoHero({
  title,
  type,
  subtitle,
  online,
  encryption,
  membersCount,
  ownerUsername,
  onBack,
}: {
  title: string;
  type: string;
  subtitle?: string;
  online?: boolean;
  encryption: 'server' | 'e2e';
  membersCount?: number;
  ownerUsername?: string | null;
  onBack: () => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const isDirect = type === 'direct';

  return (
    <View style={{ marginBottom: 10 }}>
      <View style={styles.topRow}>
        <PressableScale
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Назад"
          hitSlop={8}
          style={[styles.iconBtn, { backgroundColor: theme.dark ? 'rgba(24,32,46,0.6)' : 'rgba(255,255,255,0.7)' }]}
        >
          <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
        </PressableScale>
        <Text style={{ color: theme.textPrimary, fontWeight: '700', fontSize: 16 }}>Информация о чате</Text>
        <View style={{ width: 38 }} />
      </View>

      <GlassCard glow style={styles.heroCard}>
        <View style={styles.avatarWrap}>
          <MotiView
            from={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}
          >
            <View
              style={
                Platform.OS === 'web'
                  ? ({ filter: 'blur(26px)', opacity: 0.55, transform: [{ scale: 1.35 }] } as any)
                  : { opacity: 0.22, transform: [{ scale: 1.4 }] }
              }
            >
              <Avatar name={title || '?'} size={86} hasModule={false} hasNode={false} />
            </View>
          </MotiView>
          <Avatar name={title || '?'} size={78} hasModule={false} hasNode={false} />
          {isDirect && typeof online === 'boolean' ? (
            <View
              style={[
                styles.statusDot,
                { backgroundColor: online ? theme.success : theme.textDisabled, borderColor: theme.background },
              ]}
            />
          ) : null}
        </View>

        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ color: theme.textPrimary, fontSize: 20, fontWeight: '700' }} numberOfLines={1}>
            {title || 'Без названия'}
          </Text>
          <Text style={{ color: theme.textSecondary, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
            {isDirect ? (subtitle || (online ? 'в сети' : 'не в сети')) : TYPE_LABEL[type] || 'Чат'}
            {!isDirect && membersCount ? ` · ${membersCount} участников` : ''}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9 }}>
            <View style={[styles.badge, { backgroundColor: theme.surfacePressed, borderColor: theme.line }]}>
              <Ionicons name={isDirect ? 'chatbubble-outline' : type === 'channel' ? 'megaphone-outline' : 'people-outline'} size={11} color={theme.textSecondary} />
              <Text style={{ color: theme.textSecondary, fontSize: 11, fontWeight: '600' }}>
                {isDirect ? 'Личный чат' : TYPE_LABEL[type]}
              </Text>
            </View>
            <View
              style={[
                styles.badge,
                { backgroundColor: encryption === 'e2e' ? theme.accentSoft : theme.surfacePressed, borderColor: encryption === 'e2e' ? theme.accent : theme.line },
              ]}
            >
              <Ionicons name={encryption === 'e2e' ? 'lock-closed' : 'shield-checkmark-outline'} size={11} color={encryption === 'e2e' ? theme.accent : theme.textSecondary} />
              <Text style={{ color: encryption === 'e2e' ? theme.accent : theme.textSecondary, fontSize: 11, fontWeight: '600' }}>
                {encryption === 'e2e' ? 'Секретный · E2E' : 'Серверный ключ'}
              </Text>
            </View>
            {ownerUsername ? (
              <View style={[styles.badge, { backgroundColor: theme.surfacePressed, borderColor: theme.line }]}>
                <Ionicons name="person-outline" size={11} color={theme.textSecondary} />
                <Text style={{ color: theme.textSecondary, fontSize: 11, fontWeight: '600' }} numberOfLines={1}>
                  @{ownerUsername}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </GlassCard>
    </View>
  );
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, marginBottom: 8 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  heroCard: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  avatarWrap: { width: 86, height: 86, alignItems: 'center', justifyContent: 'center' },
  statusDot: { position: 'absolute', bottom: 3, right: 3, width: 13, height: 13, borderRadius: 7, borderWidth: 2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
});
