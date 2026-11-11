import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { Avatar } from '../Avatar';
import { useReducedMotion } from '../useReducedMotion';
import { GlassCard } from './Glass';
import { PressableScale } from './PressableScale';
import { bannerBackground, bannerPreset } from './banner';
import type { AvatarInfo } from '../../data/api';

/** Дата рождения хранится как YYYY-MM-DD; показываем день и месяц. */
export function birthdayLabel(value?: string | null): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function MetaChip({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <View style={[styles.chip, { backgroundColor: theme.dark ? 'rgba(255,255,255,0.06)' : 'rgba(16,24,40,0.05)', borderColor: theme.line }]}>
      <Ionicons name={icon} size={12} color={theme.textSecondary} />
      <Text style={{ color: theme.textSecondary, fontSize: 12, fontWeight: '500' }} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

export interface ProfileHeroProps {
  name: string;
  username: string;
  avatar?: AvatarInfo | null;
  banner?: string | null;
  location?: string;
  birthday?: string | null;
  /** Краткое био показываем только в чужом профиле — в своём оно живёт отдельной карточкой. */
  bio?: string;
  /** Свободный статус пользователя («На связи 🚀»); пусто — не показываем. */
  status?: string;
  statusText?: string;
  online?: boolean;
  isSelf?: boolean;
  nodeOnline?: boolean;
  moduleOnline?: boolean;
  onBack: () => void;
  onShare?: () => void;
  onQr?: () => void;
  onEdit?: () => void;
}

/**
 * Стеклянный hero профиля: цветной баннер, размытый аватар-ореол,
 * крупный аватар с обводками узла/модуля и компактные действия.
 */
export function ProfileHero({
  name,
  username,
  avatar,
  banner,
  location,
  birthday,
  bio,
  status,
  statusText,
  online,
  isSelf,
  nodeOnline,
  moduleOnline,
  onBack,
  onShare,
  onQr,
  onEdit,
}: ProfileHeroProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const preset = bannerPreset(banner);

  return (
    <View style={styles.wrap}>
      <View style={[styles.banner, bannerBackground(banner)]}>
        {/* На нативных платформах CSS-градиента нет — добавляем мягкие слои. */}
        {Platform.OS !== 'web' ? (
          <>
            <View pointerEvents="none" style={[styles.bannerBlob, { backgroundColor: preset.colors[0], opacity: 0.55 }]} />
            <View pointerEvents="none" style={[styles.bannerBlobBottom, { backgroundColor: preset.colors[2], opacity: 0.6 }]} />
          </>
        ) : null}

        <MotiView
          from={reduced ? { opacity: 0.26 } : { opacity: 0, scale: 0.9 }}
          animate={{ opacity: 0.3, scale: 1 }}
          transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
          pointerEvents="none"
          style={[
            styles.halo,
            Platform.OS === 'web'
              ? ({ filter: 'blur(36px)' } as any)
              : { transform: [{ scale: 1.45 }] },
          ]}
        >
          <Avatar name={name || '?'} size={190} avatar={avatar} />
        </MotiView>

        <View style={styles.topBar}>
          <PressableScale
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel="Назад"
            hitSlop={8}
            style={[
              styles.iconBtn,
              { backgroundColor: theme.dark ? 'rgba(10,14,20,0.42)' : 'rgba(255,255,255,0.72)', borderColor: 'rgba(255,255,255,0.22)' },
            ]}
          >
            <Ionicons name="chevron-back" size={22} color={theme.dark ? '#FFFFFF' : theme.textPrimary} />
          </PressableScale>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {isSelf && onEdit ? (
              <PressableScale
                onPress={onEdit}
                accessibilityRole="button"
                accessibilityLabel="Редактировать профиль"
                hitSlop={8}
                style={[styles.iconBtn, { backgroundColor: theme.accent, borderColor: theme.accent }]}
              >
                <Ionicons name="pencil" size={17} color={theme.onAccent} />
              </PressableScale>
            ) : null}
            {onShare ? (
              <PressableScale
                onPress={onShare}
                accessibilityRole="button"
                accessibilityLabel="Поделиться профилем"
                hitSlop={8}
                style={[
                  styles.iconBtn,
                  { backgroundColor: theme.dark ? 'rgba(10,14,20,0.42)' : 'rgba(255,255,255,0.72)', borderColor: 'rgba(255,255,255,0.22)' },
                ]}
              >
                <Ionicons name="share-outline" size={18} color={theme.dark ? '#FFFFFF' : theme.textPrimary} />
              </PressableScale>
            ) : null}
          </View>
        </View>
      </View>

      <View style={styles.cardWrap}>
        <GlassCard glow padding={16}>
          <View style={styles.identity}>
            <Avatar
              name={name || '?'}
              size={96}
              avatar={avatar}
              nodeOnline={nodeOnline}
              moduleOnline={moduleOnline}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Text style={{ color: theme.textPrimary, fontSize: 23, fontWeight: '800', letterSpacing: -0.3 }} numberOfLines={1}>
                  {name || 'Пользователь'}
                </Text>
                {isSelf ? (
                  <View style={[styles.selfPill, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}>
                    <Ionicons name="sparkles" size={10} color={theme.accent} />
                    <Text style={{ color: theme.accent, fontSize: 10.5, fontWeight: '800' }}>Это вы</Text>
                  </View>
                ) : null}
              </View>
              <Text style={{ color: theme.textSecondary, fontSize: 14, marginTop: 1 }} numberOfLines={1}>
                @{username}
              </Text>
              {status ? (
                <View
                  style={[
                    styles.statusChip,
                    {
                      backgroundColor: theme.dark ? 'rgba(255,255,255,0.07)' : 'rgba(16,24,40,0.05)',
                      borderColor: theme.line,
                    },
                  ]}
                >
                  <View style={[styles.statusBar, { backgroundColor: theme.accent }]} />
                  <Text style={{ color: theme.textPrimary, fontSize: 12.5, fontWeight: '600', flexShrink: 1 }} numberOfLines={2}>
                    {status}
                  </Text>
                </View>
              ) : null}
              {statusText ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: online ? theme.success : theme.textDisabled }} />
                  <Text style={{ color: online ? theme.success : theme.textSecondary, fontSize: 12, fontWeight: online ? '600' : '400' }} numberOfLines={1}>
                    {statusText}
                  </Text>
                </View>
              ) : null}
            </View>
          </View>

          {bio ? (
            <Text style={{ color: theme.textPrimary, fontSize: 14, lineHeight: 20, marginTop: 14 }} numberOfLines={4}>
              {bio}
            </Text>
          ) : null}

          {location || birthday ? (
            <View style={styles.metaRow}>
              <MetaChip icon="location-outline" text={location ?? ''} />
              <MetaChip icon="gift-outline" text={birthday ? birthdayLabel(birthday) : ''} />
            </View>
          ) : null}

          {onShare || onQr || (isSelf && onEdit) ? (
            <View style={styles.actionsRow}>
              {isSelf && onEdit ? (
                <PressableScale
                  onPress={onEdit}
                  accessibilityRole="button"
                  accessibilityLabel="Редактировать профиль"
                  style={[styles.actionBtn, { backgroundColor: theme.accent, borderColor: theme.accent }]}
                >
                  <Ionicons name="pencil" size={16} color={theme.onAccent} />
                  <Text style={{ color: theme.onAccent, fontSize: 13.5, fontWeight: '700' }}>Редактировать</Text>
                </PressableScale>
              ) : null}
              {onQr ? (
                <PressableScale
                  onPress={onQr}
                  accessibilityRole="button"
                  accessibilityLabel="Показать QR-код профиля"
                  style={[styles.actionBtn, { backgroundColor: 'transparent', borderColor: theme.line }]}
                >
                  <Ionicons name="qr-code-outline" size={16} color={theme.textPrimary} />
                  <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }}>QR-код</Text>
                </PressableScale>
              ) : null}
              {onShare ? (
                <PressableScale
                  onPress={onShare}
                  accessibilityRole="button"
                  accessibilityLabel="Поделиться профилем"
                  style={[styles.actionBtn, { backgroundColor: 'transparent', borderColor: theme.line }]}
                >
                  <Ionicons name="share-social-outline" size={16} color={theme.textPrimary} />
                  <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }}>Поделиться</Text>
                </PressableScale>
              ) : null}
            </View>
          ) : null}
        </GlassCard>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%' },
  banner: { height: 154, overflow: 'hidden' },
  bannerBlob: { position: 'absolute', top: -70, left: -40, width: 240, height: 240, borderRadius: 120 },
  bannerBlobBottom: { position: 'absolute', bottom: -100, right: -50, width: 260, height: 260, borderRadius: 130 },
  halo: { position: 'absolute', top: -6, left: '50%', marginLeft: -95 },
  topBar: {
    position: 'absolute',
    top: 8,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  iconBtn: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  cardWrap: { paddingHorizontal: 12, marginTop: -54 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  selfPill: { flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 10,
    paddingLeft: 7,
    paddingRight: 9,
    paddingVertical: 4,
    marginTop: 7,
    maxWidth: '100%',
  },
  statusBar: { width: 3, height: 14, borderRadius: 2 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 40,
  },
});
