import React from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MotiView } from 'moti';
import { useTheme } from '../../theme/useTheme';
import { useReducedMotion } from '../useReducedMotion';
import type { PickedFile } from '../file';
import { fromB64 } from '../../crypto/core';

const WebInput = 'input' as unknown as React.FC<
  React.DetailedHTMLProps<React.InputHTMLAttributes<HTMLInputElement>, HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }
>;

async function pickNativeFile(accept?: string): Promise<PickedFile | null> {
  try {
    const DocumentPicker = await import('expo-document-picker');
    const FS = await import('expo-file-system');
    const res = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      type: accept ?? '*/*',
    });
    if (res.canceled || !res.assets?.length) return null;
    const asset = res.assets[0];
    const b64 = await FS.readAsStringAsync(asset.uri, { encoding: FS.EncodingType.Base64 });
    return { name: asset.name, mime: asset.mimeType ?? 'application/octet-stream', bytes: fromB64(b64) };
  } catch {
    return null;
  }
}

/**
 * Стеклянное меню вложений: фото, файл и камера.
 * Камера доступна только там, где браузер умеет захват (web); на native скрыта.
 */
export function AttachmentMenu({
  visible,
  onClose,
  onPicked,
}: {
  visible: boolean;
  onClose: () => void;
  onPicked: (file: PickedFile) => void;
}) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const photoRef = React.useRef<HTMLInputElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const cameraRef = React.useRef<HTMLInputElement | null>(null);

  const web = Platform.OS === 'web';
  const cameraAvailable = web && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices);

  const readWeb = async (input: HTMLInputElement | null) => {
    const f = input?.files?.[0];
    if (!f) return;
    const bytes = new Uint8Array(await f.arrayBuffer());
    onPicked({ name: f.name || 'file', mime: f.type || 'application/octet-stream', bytes });
    if (input) input.value = '';
    onClose();
  };

  const pickNative = async (accept?: string) => {
    onClose();
    const file = await pickNativeFile(accept);
    if (file) onPicked(file);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Закрыть меню вложений"
        />
        <MotiView
          from={reduced ? { opacity: 1 } : { opacity: 0, translateY: 18, scale: 0.97 }}
          animate={{ opacity: 1, translateY: 0, scale: 1 }}
          transition={reduced ? { type: 'timing', duration: 0 } : { type: 'spring', damping: 24, stiffness: 300 }}
          style={[
            styles.panel,
            {
              backgroundColor: theme.glassStrong,
              borderColor: theme.glassBorder,
              ...theme.shadow,
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: theme.line }]} />
          <Text style={{ color: theme.textSecondary, fontSize: 12.5, fontWeight: '600', marginBottom: 6 }}>Вложение</Text>

          <AttachItem
            icon="image-outline"
            label="Фото"
            hint="Изображение из галереи"
            color={theme.accent}
            onPress={() => (web ? photoRef.current?.click() : void pickNative('image/*'))}
          />
          <AttachItem
            icon="document-outline"
            label="Файл"
            hint="Любой документ"
            color={theme.success}
            onPress={() => (web ? fileRef.current?.click() : void pickNative())}
          />
          {cameraAvailable ? (
            <AttachItem
              icon="camera-outline"
              label="Камера"
              hint="Снять фото сейчас"
              color={theme.warning}
              onPress={() => cameraRef.current?.click()}
            />
          ) : null}

          {web ? (
            <>
              <WebInput ref={photoRef} type="file" accept="image/*" hidden onChange={() => void readWeb(photoRef.current)} />
              <WebInput ref={fileRef} type="file" hidden onChange={() => void readWeb(fileRef.current)} />
              <WebInput
                ref={cameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={() => void readWeb(cameraRef.current)}
              />
            </>
          ) : null}
        </MotiView>
      </View>
    </Modal>
  );
}

function AttachItem({
  icon,
  label,
  hint,
  color,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  color: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.item, { backgroundColor: pressed ? theme.surfacePressed : 'transparent' }]}
    >
      <View style={[styles.itemIcon, { backgroundColor: `${color}22` }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: theme.textPrimary, fontSize: 14.5, fontWeight: '600' }}>{label}</Text>
        <Text style={{ color: theme.textSecondary, fontSize: 12 }}>{hint}</Text>
      </View>
      <Ionicons name="chevron-forward" size={15} color={theme.textDisabled} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end', alignItems: 'center' },
  panel: {
    width: '100%',
    maxWidth: 520,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: 1,
    borderBottomWidth: 0,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 22,
    gap: 4,
  },
  grabber: { width: 38, height: 4, borderRadius: 2, alignSelf: 'center', marginVertical: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 9, borderRadius: 12, minHeight: 54 },
  itemIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
