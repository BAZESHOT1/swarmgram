import React from 'react';
import { Image, Platform, Share, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { motion } from '../../theme/motion';
import { useReducedMotion } from '../useReducedMotion';
import { Btn } from '../Btn';
import { useStore } from '../../state/useStore';
import { ProfileModal } from './ProfileModal';
import { glassStyle } from './Glass';

/**
 * Копирование ссылки: clipboard API на web, Share/Clipboard на нативе.
 * expo-clipboard не подключён, поэтому используем доступные fallback-и.
 */
export async function copyText(value: string): Promise<void> {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(value);
    return;
  }
  try {
    const mod: any = await import('react-native');
    if (mod?.Clipboard?.setString) {
      mod.Clipboard.setString(value);
      return;
    }
    if (mod?.Share?.share) {
      await mod.Share.share({ message: value, url: value });
      return;
    }
  } catch {
    /* ниже общий fallback */
  }
  throw new Error('clipboard_unavailable');
}

/** Системный шеринг; на web без navigator.share просто копируем ссылку. */
export async function shareUrl(url: string, title: string, text: string): Promise<'shared' | 'copied'> {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    await navigator.share({ title, text, url });
    return 'shared';
  }
  if (Platform.OS !== 'web') {
    await Share.share({ message: `${text}\n${url}`, url, title });
    return 'shared';
  }
  await copyText(url);
  return 'copied';
}

function originUrl(username: string): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return `${window.location.origin}/user/${encodeURIComponent(username)}`;
  }
  // Нативная сборка без window — стабильная публичная ссылка, которая открывает профиль.
  return `https://klinto.app/user/${encodeURIComponent(username)}`;
}

/** Модалка QR: QR-код на web, крупная ссылка и копирование — на нативе. */
export function ProfileQrModal({
  visible,
  username,
  displayName,
  onClose,
}: {
  visible: boolean;
  username: string;
  displayName?: string;
  onClose: () => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const pushToast = useStore((s) => s.pushToast);

  const url = React.useMemo(() => originUrl(username), [username]);
  const [qr, setQr] = React.useState<string | null>(null);
  const [qrError, setQrError] = React.useState(false);
  const [busy, setBusy] = React.useState<'' | 'copy' | 'share'>('');

  React.useEffect(() => {
    if (!visible) return;
    let alive = true;
    setQrError(false);

    if (Platform.OS !== 'web') {
      // На нативе QR не рисуем — по контракту достаточно крупной ссылки.
      setQr(null);
      return () => {
        alive = false;
      };
    }

    void (async () => {
      try {
        const mod: any = await import('qrcode');
        const toDataURL = mod?.default?.toDataURL ?? mod?.toDataURL;
        if (typeof toDataURL !== 'function') throw new Error('qrcode_unavailable');
        const dataUrl = await toDataURL(url, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 260,
          color: { dark: '#0A0E14', light: '#FFFFFF' },
        });
        if (alive) setQr(String(dataUrl));
      } catch {
        if (alive) {
          setQr(null);
          setQrError(true);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [visible, url]);

  async function copy() {
    if (busy) return;
    setBusy('copy');
    try {
      await copyText(url);
      pushToast({ kind: 'success', message: 'Ссылка на профиль скопирована' });
    } catch {
      pushToast({ kind: 'error', message: 'Не удалось скопировать ссылку' });
    } finally {
      setBusy('');
    }
  }

  async function share() {
    if (busy) return;
    setBusy('share');
    try {
      const result = await shareUrl(url, displayName ? `${displayName} · Klinto` : `@${username} · Klinto`, `Профиль @${username} в Klinto`);
      if (result === 'copied') pushToast({ kind: 'success', message: 'Ссылка на профиль скопирована' });
    } catch {
      pushToast({ kind: 'error', message: 'Не удалось поделиться' });
    } finally {
      setBusy('');
    }
  }

  return (
    <ProfileModal visible={visible} title="QR-код профиля" subtitle="Отсканируйте камерой телефона" onClose={onClose}>
      <View style={styles.center}>
        {qr ? (
          <MotiView
            from={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={reduced ? { type: 'timing', duration: 0 } : motion.softSpring}
            style={[styles.qrWrap, { borderColor: theme.line }]}
          >
            <Image source={{ uri: qr }} style={styles.qrImage} resizeMode="contain" accessibilityLabel={`QR-код профиля @${username}`} />
          </MotiView>
        ) : (
          <View style={[styles.fallback, glassStyle(theme.dark, 16), { borderColor: theme.line }]}>
            <View style={[styles.fallbackIcon, { backgroundColor: theme.accentSoft, borderColor: theme.accent }]}>
              <Ionicons name={qrError ? 'qr-code-outline' : 'phone-portrait-outline'} size={22} color={theme.accent} />
            </View>
            <Text style={{ color: theme.textPrimary, fontSize: 14, fontWeight: '700', textAlign: 'center' }}>
              {qrError ? 'QR недоступен — используйте ссылку' : 'Ссылка на профиль'}
            </Text>
            <Text
              selectable
              style={{ color: theme.textPrimary, fontSize: 15, fontWeight: '600', textAlign: 'center', lineHeight: 21 }}
            >
              {url}
            </Text>
            <Text style={{ color: theme.textSecondary, fontSize: 12, textAlign: 'center' }}>
              Ссылка открывает профиль @{username}
            </Text>
          </View>
        )}

        {qr ? (
          <Text selectable style={{ color: theme.textSecondary, fontSize: 12.5, textAlign: 'center' }}>
            {url}
          </Text>
        ) : null}

        <View style={styles.buttons}>
          <View style={{ flex: 1 }}>
            <Btn title="Скопировать ссылку" size="s" variant="ghost" loading={busy === 'copy'} onPress={() => void copy()} />
          </View>
          <View style={{ flex: 1 }}>
            <Btn title="Поделиться" size="s" loading={busy === 'share'} onPress={() => void share()} />
          </View>
        </View>
      </View>
    </ProfileModal>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: 14 },
  qrWrap: {
    padding: 10,
    borderRadius: 18,
    borderWidth: 1,
    backgroundColor: '#FFFFFF',
    alignSelf: 'center',
  },
  qrImage: { width: 224, height: 224 },
  fallback: { width: '100%', alignItems: 'center', gap: 10, padding: 18, borderRadius: 16, borderWidth: 1 },
  fallbackIcon: { width: 46, height: 46, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  buttons: { flexDirection: 'row', gap: 10, width: '100%' },
});
