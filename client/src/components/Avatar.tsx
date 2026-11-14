import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { MotiView } from 'moti';
import { useTheme } from '../theme/useTheme';
import { useReducedMotion } from './useReducedMotion';
import type { AvatarInfo } from '../data/api';
import { downloadObject } from '../data/chatkit';
import { decryptFileBytes, fromB64u, toB64 } from '../crypto/core';
import { getCachedAvatar, loadCachedAvatar, removeCachedAvatar, saveAvatar } from '../data/cache';

/* Градиентные пары: детерминированно по первой букве имени (Telegram-стиль). */
const PAIRS: [string, string][] = [
  ['#F5A623', '#E8620C'],
  ['#2ED47A', '#0E9C60'],
  ['#4D7CFE', '#2B4EDB'],
  ['#B95CF4', '#7B2EDB'],
  ['#F2555A', '#C01F2C'],
  ['#23C4C4', '#0E8C8C'],
  ['#F973B1', '#D63189'],
];

function pairOf(name: string): [string, string] {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  // hash по коду символа — детерминированно
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) & 0x7fffffff;
  const pair = PAIRS[(initial.charCodeAt(0) + hash) % PAIRS.length] ?? PAIRS[0];
  return pair as unknown as [string, string];
}

/* ------------------------------------------------------------- кэш фото -- */

/**
 * Кэш data-URI по objectId: профиль, список чатов и участники могут
 * показывать один и тот же аватар — скачиваем и расшифровываем один раз.
 */
const avatarCache = new Map<string, string>();
const avatarInflight = new Map<string, Promise<string>>();

/** Сбросить кэш конкретного аватара (например, после перезагрузки фото). */
export function invalidateAvatar(objectId?: string): void {
  if (objectId) {
    avatarCache.delete(objectId);
    removeCachedAvatar(objectId);
  } else {
    avatarCache.clear();
  }
}

async function loadAvatar(info: AvatarInfo): Promise<string> {
  const cached = avatarCache.get(info.objectId);
  if (cached) return cached;

  const existing = avatarInflight.get(info.objectId);
  if (existing) return existing;

  const task = (async () => {
    const encrypted = await downloadObject(info.objectId);
    if (!encrypted || !encrypted.length) throw new Error('avatar_unavailable');
    // Ключ приходит base64url, файл зашифрован целиком: [nonce][AES-GCM].
    const plain = decryptFileBytes(fromB64u(info.key), encrypted);
    const uri = `data:${info.mime || 'image/jpeg'};base64,${toB64(plain)}`;
    avatarCache.set(info.objectId, uri);
    // Постоянный кэш: следующий офлайн-старт покажет фото без сети.
    saveAvatar(info.objectId, uri);
    return uri;
  })();

  avatarInflight.set(info.objectId, task);
  try {
    return await task;
  } finally {
    avatarInflight.delete(info.objectId);
  }
}

export interface AvatarProps {
  name: string;
  size?: number;
  /** Зашифрованный аватар с узлов. Нет/ошибка — инициалы и градиент. */
  avatar?: AvatarInfo | null;
  /** Устаревшие флаги «есть модуль/узел» — оставлены для совместимости. */
  hasModule?: boolean;
  hasNode?: boolean;
  /** Онлайн-узел: оранжевая обводка (theme.accent / ringNode). */
  nodeOnline?: boolean;
  /** Онлайн-модуль: зелёная обводка (theme.success / ringModule). */
  moduleOnline?: boolean;
  /** Толщина обводки в px (по умолчанию 2.5). */
  ringSize?: number;
  /** Радиус скругления. По умолчанию круг; 10 — квадратная аватарка. */
  radius?: number;
}

/**
 * Аватар: зашифрованная картинка с узлов или градиент по имени (два полукруга),
 * инициалы и обводка статуса.
 *  - узел онлайн   → оранжевая;
 *  - модуль онлайн → зелёная;
 *  - оба онлайн    → градиентное кольцо (две пары цветов по сторонам, без SVG).
 * Пока обводка активна — мягкая пульсация-свечение (уважает reduced motion).
 */
export function Avatar({
  name,
  size = 44,
  avatar,
  hasModule,
  hasNode,
  nodeOnline,
  moduleOnline,
  ringSize,
  radius,
}: AvatarProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const [c1, c2] = pairOf(name);

  const avatarObjectId = avatar?.objectId ?? '';
  const avatarKey = avatar?.key ?? '';
  const avatarMime = avatar?.mime ?? '';
  const [photo, setPhoto] = React.useState<{ id: string; uri: string } | null>(() => {
    if (!avatarObjectId) return null;
    const uri = avatarCache.get(avatarObjectId) ?? getCachedAvatar(avatarObjectId);
    return uri ? { id: avatarObjectId, uri } : null;
  });
  const [photoFailed, setPhotoFailed] = React.useState(false);
  // Пока читаем постоянный кэш, не показываем инициалы — иначе будет «мигание».
  const [checkingCache, setCheckingCache] = React.useState(
    () => Boolean(avatarObjectId && avatarKey) && !avatarCache.get(avatarObjectId) && !getCachedAvatar(avatarObjectId),
  );

  React.useEffect(() => {
    let alive = true;
    if (!avatarObjectId || !avatarKey) {
      setPhoto(null);
      setPhotoFailed(false);
      setCheckingCache(false);
      return () => {
        alive = false;
      };
    }

    const cached = avatarCache.get(avatarObjectId) ?? getCachedAvatar(avatarObjectId);
    if (cached) {
      avatarCache.set(avatarObjectId, cached);
      setPhoto({ id: avatarObjectId, uri: cached });
      setPhotoFailed(false);
      setCheckingCache(false);
      return () => {
        alive = false;
      };
    }

    setPhoto(null);
    setPhotoFailed(false);
    setCheckingCache(true);

    // Сначала постоянный кэш (асинхронно), только потом сеть.
    void (async () => {
      const stored = await loadCachedAvatar(avatarObjectId);
      if (!alive) return;
      if (stored) {
        avatarCache.set(avatarObjectId, stored);
        setPhoto({ id: avatarObjectId, uri: stored });
        setCheckingCache(false);
        return;
      }
      try {
        const uri = await loadAvatar({ objectId: avatarObjectId, key: avatarKey, mime: avatarMime });
        if (alive) {
          setPhoto({ id: avatarObjectId, uri });
          setCheckingCache(false);
        }
      } catch {
        if (alive) {
          setPhotoFailed(true);
          setCheckingCache(false);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [avatarObjectId, avatarKey, avatarMime]);

  // Новый контракт: nodeOnline/moduleOnline; старые hasNode/hasModule — запасной вариант.
  const node = nodeOnline ?? hasNode ?? false;
  const moduleOn = moduleOnline ?? hasModule ?? false;
  const hasRing = node || moduleOn;
  const thickness = Math.max(2, ringSize ?? 2.5);
  const gap = 2;

  const ring = (() => {
    if (node && moduleOn) {
      // Визуальный градиент: верх/лево — оранжевый, низ/право — зелёный.
      return {
        borderWidth: thickness,
        borderColor: 'transparent',
        borderTopColor: theme.ringNode,
        borderLeftColor: theme.ringNode,
        borderBottomColor: theme.ringModule,
        borderRightColor: theme.ringModule,
      };
    }
    if (node) return { borderWidth: thickness, borderColor: theme.ringNode };
    if (moduleOn) return { borderWidth: thickness, borderColor: theme.ringModule };
    return { borderWidth: 0 };
  })();

  // Отступ обводки от аватара: 2px. Без обводки сохраняем прежний вид.
  const inner = hasRing ? Math.max(12, size - 2 * (thickness + gap)) : size - 7;
  const outerRadius = radius ?? Math.max(8, Math.round(size * 0.28));
  const innerRadius = Math.max(2, outerRadius - (hasRing ? thickness + gap : 3.5));
  const glowColor = node && moduleOn ? theme.ringNode : node ? theme.ringNode : theme.ringModule;
  const showPhoto = Boolean(photo) && !photoFailed && photo?.id === avatarObjectId;

  return (
    <View
      style={[
        styles.ring,
        { width: size, height: size, borderRadius: outerRadius },
        ring,
      ]}
    >
      {hasRing && !reduced ? (
        <MotiView
          pointerEvents="none"
          from={{ opacity: 0.3, scale: 0.97 }}
          animate={{ opacity: 0.08, scale: 1.08 }}
          transition={{ loop: true, repeatReverse: true, type: 'timing', duration: 1800 }}
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: outerRadius,
            backgroundColor: glowColor,
          }}
        />
      ) : null}
      <View style={[styles.inner, { width: inner, height: inner, borderRadius: innerRadius, overflow: 'hidden', backgroundColor: c1 }]}>
        {/* правый-нижний второй цвет — псевдоградиент по диагонали */}
        <View style={{ position: 'absolute', right: 0, bottom: 0, width: inner * 0.62, height: inner * 0.62, borderTopLeftRadius: innerRadius, backgroundColor: c2 }} />
        {showPhoto ? (
          <Image
            source={{ uri: photo?.uri ?? '' }}
            style={{ width: inner, height: inner, borderRadius: innerRadius }}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={photo?.uri ?? name}
            transition={120}
            accessibilityIgnoresInvertColors
          />
        ) : checkingCache ? (
          // Постоянный кэш читается — пустое место лучше, чем мигание инициалов.
          <View style={{ width: inner, height: inner }} />
        ) : (
          <Text
            style={[styles.initial, { width: inner, height: inner, lineHeight: inner, fontSize: size * 0.4, color: 'rgba(255,255,255,0.94)' }]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {initial}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { alignItems: 'center', justifyContent: 'center' },
  inner: { alignItems: 'center', justifyContent: 'center' },
  initial: { fontWeight: '700', textAlign: 'center', textAlignVertical: 'center' as never },
});
