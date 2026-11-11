/** Скачивание расшифрованного файла: web — anchor, нативные — файл в кэше. */
import { Alert, Platform } from 'react-native';
import { toB64 } from '../crypto/core';

export async function saveToDevice(name: string, mime: string, bytes: Uint8Array): Promise<string> {
  if (Platform.OS === 'web') {
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return name;
  }
  const mod: any = await import('expo-file-system');
  const dir = mod.cacheDirectory ?? '';
  const path = `${dir}${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  await mod.writeAsStringAsync(path, toB64(bytes), { encoding: mod.EncodingType?.Base64 ?? 'base64' });
  Alert.alert('Файл расшифрован', `Сохранён в кэше устройства:\n${path}`);
  return path;
}
