import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { GlassCard, GlassSectionTitle } from './Glass';

/** Одна карточка-бейдж: иконка, название и короткое реальное основание. */
export interface ProfileBadge {
  key: string;
  title: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  soft: string;
}

const DAY_MS = 86_400_000;

/** Сколько дней пользователь в сети — для бейджа «Ранний участник». */
function daysSince(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
}

/** Фиолетовый для «Раннего участника»: в теме нет отдельного токена. */
const EARLY_COLOR = '#A78BFA';
const EARLY_SOFT = 'rgba(167,139,250,0.18)';

export interface ProfileBadgeFacts {
  createdAt?: string | null;
  /** Количество общих (для своего профиля — всех) чатов. */
  sharedChats?: number;
  nodeOnline?: boolean;
  /** У пользователя вообще есть узлы (для своего профиля считаем по /v1/me). */
  hasNodes?: boolean;
  moduleOnline?: boolean;
}

/** Собирает бейджи только из реальных данных: нет основания — нет карточки. */
export function buildProfileBadges(facts: ProfileBadgeFacts, theme: ReturnType<typeof useTheme>): ProfileBadge[] {
  const badges: ProfileBadge[] = [];
  const chats = facts.sharedChats ?? 0;
  const days = daysSince(facts.createdAt);

  if (facts.nodeOnline || facts.hasNodes) {
    badges.push({
      key: 'node',
      title: 'Узел сети',
      description: facts.nodeOnline ? 'Узел сейчас онлайн' : 'Есть узел Kinto',
      icon: 'hardware-chip-outline',
      color: theme.ringNode,
      soft: theme.dark ? 'rgba(245,166,35,0.16)' : 'rgba(247,144,9,0.14)',
    });
  }

  if (facts.moduleOnline) {
    badges.push({
      key: 'module',
      title: 'Модуль связи',
      description: 'ESP32-модуль онлайн',
      icon: 'radio-outline',
      color: theme.ringModule,
      soft: theme.successSoft,
    });
  }

  if (days !== null && days >= 30) {
    badges.push({
      key: 'early',
      title: 'Ранний участник',
      description: `В сети уже ${days} дн.`,
      icon: 'leaf-outline',
      color: EARLY_COLOR,
      soft: EARLY_SOFT,
    });
  }

  if (chats >= 3) {
    badges.push({
      key: 'active',
      title: 'Активный',
      description: `${chats} ${chats === 1 ? 'общий чат' : chats < 5 ? 'общих чата' : 'общих чатов'}`,
      icon: 'flame-outline',
      color: theme.warning,
      soft: theme.warningSoft,
    });
  }

  return badges;
}

/**
 * Секция достижений. Если реальных оснований нет — блок полностью скрывается,
 * никаких заглушек и фейковых наград.
 */
export function ProfileBadges({ facts }: { facts: ProfileBadgeFacts }) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const badges = buildProfileBadges(facts, theme);

  if (!badges.length) return null;

  return (
    <GlassCard>
      <GlassSectionTitle
        title="Достижения"
        right={<Text style={{ color: theme.textDisabled, fontSize: 11.5 }}>{badges.length}</Text>}
      />
      <View style={styles.grid}>
        {badges.map((badge, index) => (
          <MotiView
            key={badge.key}
            from={reduced ? { opacity: 0 } : { opacity: 0, translateY: 8, scale: 0.98 }}
            animate={{ opacity: 1, translateY: 0, scale: 1 }}
            transition={
              reduced
                ? { type: 'timing', duration: 0 }
                : { ...motion.spring, delay: Math.min(index, 4) * motion.staggerStepMs }
            }
            style={styles.cell}
          >
            <View
              style={[
                styles.badge,
                {
                  borderColor: theme.line,
                  backgroundColor: theme.dark ? 'rgba(255,255,255,0.04)' : 'rgba(16,24,40,0.03)',
                },
              ]}
            >
              <View style={[styles.iconBox, { backgroundColor: badge.soft, borderColor: badge.color }]}>
                <Ionicons name={badge.icon} size={18} color={badge.color} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ color: theme.textPrimary, fontSize: 13, fontWeight: '700' }} numberOfLines={1}>
                  {badge.title}
                </Text>
                <Text style={{ color: theme.textSecondary, fontSize: 11, marginTop: 2 }} numberOfLines={2}>
                  {badge.description}
                </Text>
              </View>
            </View>
          </MotiView>
        ))}
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: '48.5%', minWidth: 148, flexGrow: 1 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 10,
    minHeight: 58,
  },
  iconBox: { width: 34, height: 34, borderRadius: 11, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
});
