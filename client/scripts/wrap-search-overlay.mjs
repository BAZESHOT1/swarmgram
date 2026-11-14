import { readFileSync, writeFileSync } from 'node:fs';
const path = 'app/(app)/chats.tsx';
let text = readFileSync(path, 'utf8');
if (!text.includes('styles.searchOverlay')) {
  text = text.replace(
    '      {search.trim() ? (\n        <SearchResults',
    '      {search.trim() ? (\n        <View style={styles.searchOverlay}>\n        <SearchResults',
  );
  text = text.replace(
    '        />\n      ) : chats.isLoading ?',
    '        />\n        </View>\n      ) : chats.isLoading ?',
  );
  writeFileSync(path, text, 'utf8');
  console.log('search overlay wrapped');
} else {
  console.log('already');
}
