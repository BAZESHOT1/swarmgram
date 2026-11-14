import { readFileSync, writeFileSync } from 'node:fs';
const path = 'ARCHITECTURE_AND_PROTOCOL.md';
let text = readFileSync(path, 'utf8');
const oldNote = `> Для KMesh_v1 на 4 MB места хватает только на \`PartitionScheme=huge_app\` (3 MB app, без OTA).
> OTA для KMesh_v1 требует 8 MB flash у узла: \`max_app_8MB\`; v2 использует \`min_spiffs\`.`;
const newNote = `> Начиная с прошивки 1.3 KMesh_v1 использует собственные таблицы разделов
> \`klinto_4mb_ota.csv\` (два слота по 1.75 МБ) и \`klinto_8mb_ota.csv\`
> (два слота по 3.125 МБ). Полноценная OTA работает и на 4 МБ flash.`;
if (text.includes(oldNote)) {
  text = text.replace(oldNote, newNote);
  writeFileSync(path, text, 'utf8');
  console.log('replaced');
} else {
  console.log('old note not found');
}
