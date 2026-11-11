import React from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../theme/useTheme';
import { PressableScale } from './PressableScale';
import type { ProfileLink } from '../../data/api';

/** Дополняем схему, если пользователь ввёл «example.com». */
export function normalizeLinkUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    // Разрешаем только безопасные схемы: ссылки и почта/Telegram.
    if (name === 'http' || name === 'https' || name === 'mailto' || name === 'tg') return trimmed;
    return '';
  }
  return `https://${trimmed}`;
}

function hostOf(url: string): string {
  try {
    return new URL(normalizeLinkUrl(url)).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Открыть ссылку в новой вкладке (web) или системном браузере. */
export function openProfileLink(url: string): void {
  const target = normalizeLinkUrl(url);
  if (!target) return;
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(target, '_blank', 'noopener,noreferrer');
    return;
  }
  void Linking.openURL(target).catch(() => undefined);
}

/** Список ссылок профиля: label + домен, переход в браузер. */
export function ProfileLinks({ links }: { links?: ProfileLink[] | null }) {
  const theme = useTheme();
  const rows = (links ?? []).filter((link) => Boolean(link && normalizeLinkUrl(link.url)));
  if (!rows.length) return null;

  return (
    <View style={{ gap: 6 }}>
      {rows.map((link, index) => {
        const host = hostOf(link.url);
        return (
          <PressableScale
            key={`${link.url}-${index}`}
            onPress={() => openProfileLink(link.url)}
            accessibilityRole="link"
            accessibilityLabel={`Открыть ссылку ${link.label || host}`}
            style={[styles.row, { borderColor: theme.line, backgroundColor: theme.dark ? 'rgba(255,255,255,0.03)' : 'rgba(16,24,40,0.02)' }]}
          >
            <View style={[styles.iconBox, { backgroundColor: theme.accentSoft }]}>
              <Ionicons name="link-outline" size={15} color={theme.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: theme.textPrimary, fontSize: 13.5, fontWeight: '600' }} numberOfLines={1}>
                {link.label || host}
              </Text>
              <Text style={{ color: theme.textSecondary, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
                {host}
              </Text>
            </View>
            <Ionicons name="open-outline" size={15} color={theme.textDisabled} />
          </PressableScale>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 9, minHeight: 48 },
  iconBox: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
});
