import { readFileSync, writeFileSync } from 'node:fs';
const path = 'app/(app)/chat/[id].tsx';
let text = readFileSync(path, 'utf8');
text = text.replace('  FlatList,\n', '');
if (!text.includes("@shopify/flash-list")) {
  text = text.replace("import { MotiView } from 'moti';", "import { MotiView } from 'moti';\nimport { FlashList } from '@shopify/flash-list';");
}
text = text.replaceAll('useRef<FlatList<Row> | null>', 'useRef<FlashList<Row> | null>');
text = text.replaceAll('<FlatList', '<FlashList').replaceAll('</FlatList>', '</FlashList>');
writeFileSync(path, text, 'utf8');
console.log('chat list swapped');
