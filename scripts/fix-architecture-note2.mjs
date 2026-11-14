import { readFileSync, writeFileSync } from 'node:fs';
const path = 'ARCHITECTURE_AND_PROTOCOL.md';
let text = readFileSync(path, 'utf8');
const idx = text.indexOf('PartitionScheme=huge_app');
if (idx < 0) {
  console.log('marker not found');
  process.exit(0);
}
const lineStart = text.lastIndexOf('\n', idx) + 1;
const lineEnd = text.indexOf('\n', idx);
const replacement = '> Начиная с прошивки 1.3 KMesh_v1 использует таблицы `klinto_4mb_ota.csv`\n> (два OTA-слота по 1.75 МБ) и `klinto_8mb_ota.csv` (по 3.125 МБ).\n> Полноценная OTA работает и на 4 МБ flash.';
text = text.slice(0, lineStart) + replacement + text.slice(lineEnd);
writeFileSync(path, text, 'utf8');
console.log('replaced line');
