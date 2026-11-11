import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import React from 'react';
import { Pressable, Text } from 'react-native';
import { fromB64, toB64 } from '../crypto/core';
import type { PickedFile } from './file';

/** iOS/Android: системный выбор файла + чтение через expo-file-system (legacy API). */
export function FilePicker({ onPicked }: { onPicked: (f: PickedFile) => void }) {
  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.length) return;
    const asset = res.assets[0];
    const b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
    onPicked({ name: asset.name, mime: asset.mimeType ?? 'application/octet-stream', bytes: fromB64(b64) });
  };
  return (
    <Pressable onPress={pick} hitSlop={8}>
      <Text style={{ fontSize: 20 }}>📎</Text>
    </Pressable>
  );
}

export { toB64 };
