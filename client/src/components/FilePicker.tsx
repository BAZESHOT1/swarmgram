import React, { Suspense } from 'react';
import { Platform, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/useTheme';
import type { PickedFile } from './file';

/**
 * Выбор файла для вложения.
 * Web — настоящий <input type=file>; iOS/Android — системный пикер через
 * expo-document-picker (подгружается лениво, в веб-бандл не попадает).
 */
export function FilePicker({ onPicked }: { onPicked: (f: PickedFile) => void }) {
  const theme = useTheme();
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  if (Platform.OS === 'web') {
    const WebInput = 'input' as unknown as React.FC<
      React.DetailedHTMLProps<React.InputHTMLAttributes<HTMLInputElement>, HTMLInputElement> & { ref?: React.Ref<HTMLInputElement> }
    >;
    return (
      <Pressable onPress={() => inputRef.current?.click()} hitSlop={8} accessibilityLabel="Вложить файл" accessibilityRole="button">
        <Ionicons name="attach" size={20} color={theme.textSecondary} />
        <WebInput
          ref={inputRef}
          type="file"
          hidden
          onChange={async (e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (!f) return;
            const bytes = new Uint8Array(await f.arrayBuffer());
            onPicked({ name: f.name, mime: f.type || 'application/octet-stream', bytes });
            (e.target as HTMLInputElement).value = '';
          }}
        />
      </Pressable>
    );
  }

  const NativePicker = React.lazy(() => import('./FilePicker.native').then((m) => ({ default: m.FilePicker })));
  return (
    <Suspense fallback={<Ionicons name="attach" size={20} color={theme.textSecondary} />}>
      <NativePicker onPicked={onPicked} />
    </Suspense>
  );
}
