import { readFileSync, writeFileSync } from 'node:fs';
const path = 'app/(app)/chat/[id].tsx';
let text = readFileSync(path, 'utf8');
text = text.replace('  KeyboardAvoidingView,\n', '  KeyboardAvoidingView as RNKeyboardAvoidingView,\n');
if (!text.includes('react-native-keyboard-controller')) {
  text = text.replace(
    "import { FlashList } from '@shopify/flash-list';",
    "import { FlashList } from '@shopify/flash-list';\nimport { KeyboardAvoidingView as KCKeyboardAvoidingView } from 'react-native-keyboard-controller';",
  );
}
text = text.replaceAll('<KeyboardAvoidingView', '<Avoider').replaceAll('</KeyboardAvoidingView>', '</Avoider>');
if (!text.includes('const Avoider')) {
  text = text.replace(
    'const listRef = useRef<FlashList<Row> | null>(null);',
    "const Avoider: React.ComponentType<any> = Platform.OS === 'web' ? RNKeyboardAvoidingView : KCKeyboardAvoidingView;\n  const listRef = useRef<FlashList<Row> | null>(null);",
  );
}
writeFileSync(path, text, 'utf8');
console.log('keyboard controller applied');
