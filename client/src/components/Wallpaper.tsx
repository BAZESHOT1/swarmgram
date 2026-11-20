/**
 * Фон чата / группы / канала / профиля.
 *
 * Своё изображение владельца (зашифровано на узлах, расшифровывается на устройстве) либо
 * фирменный узор Kinto: диагональные полосы и тонкая сетка. Поверх своего фото — лёгкое
 * затемнение, чтобы стеклянные элементы и текст читались на любой картинке.
 */
import React from 'react';
import { Image, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AvatarInfo } from '../data/api';
import { useTheme } from '../theme/useTheme';
import { loadAvatar } from './Avatar';

const PATTERN = require('../../assets/wallpaper-default.png');

/** data-URI расшифрованного изображения (null — пока грузится или нет картинки). */
export function useEncryptedImage(info?: AvatarInfo | null): string | null {
  const [uri, setUri] = React.useState<string | null>(null);
  const objectId = info?.objectId ?? '';
  const key = info?.key ?? '';
  const mime = info?.mime ?? '';
  React.useEffect(() => {
    let alive = true;
    setUri(null);
    if (!objectId || !key) return undefined;
    loadAvatar({ objectId, key, mime })
      .then((value) => {
        if (alive) setUri(value);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [objectId, key, mime]);
  return uri;
}

export function Wallpaper({
  image,
  previewUri,
  dim = 0.38,
  pattern = false,
  bleed = false,
}: {
  image?: AvatarInfo | null;
  /** Локальное превью (сразу после выбора, до загрузки). */
  previewUri?: string | null;
  /** Затемнение своего фото (0..1). */
  dim?: number;
  /** Без своего фото: показывать узор Kinto (профиль) или оставить прозрачным (чаты). */
  pattern?: boolean;
  /** Растянуть за отступы AppShell (16 по бокам, safe-area+12 сверху), чтобы фон занимал весь экран. */
  bleed?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const wideShell = Platform.OS === 'web' && width >= 900;
  // На смартфоне оболочка уже не даёт отступов этим экранам — фон и так во весь экран.
  void bleed;
  void insets;
  void wideShell;
  const bleedStyle = null;
  const theme = useTheme();
  const loaded = useEncryptedImage(image);
  const uri = previewUri ?? loaded;
  // Чаты, каналы и группы без своего фона прозрачны: виден фон приложения.
  if (!uri && !pattern) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, bleedStyle, { backgroundColor: theme.dark ? '#161616' : '#ECEDF1' }]}>
      {uri ? (
        <>
          <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.dark ? `rgba(0,0,0,${dim})` : `rgba(255,255,255,${dim * 0.5})` }]} />
        </>
      ) : (
        <Image
          source={PATTERN}
          resizeMode="repeat"
          style={[StyleSheet.absoluteFill, { opacity: theme.dark ? 1 : 0.22, width: '100%', height: '100%' }]}
        />
      )}
    </View>
  );
}
