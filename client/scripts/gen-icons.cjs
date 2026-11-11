/**
 * Генерация иконок приложения из текущего логотипа сайта (public/icon.svg).
 * Запуск: node scripts/gen-icons.cjs
 * Требует sharp (ставится через `npm i sharp --no-save`).
 */
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const out = path.join(root, 'assets');
fs.mkdirSync(out, { recursive: true });

const glyph = `
  <g stroke="#F5A623" stroke-width="14" stroke-linecap="round" opacity="0.85">
    <line x1="256" y1="256" x2="256" y2="128"/>
    <line x1="256" y1="256" x2="368" y2="320"/>
    <line x1="256" y1="256" x2="144" y2="320"/>
    <line x1="256" y1="256" x2="150" y2="150"/>
    <line x1="256" y1="256" x2="362" y2="150"/>
  </g>
  <g fill="#F5A623">
    <circle cx="256" cy="256" r="44"/>
    <circle cx="256" cy="128" r="20"/>
    <circle cx="368" cy="320" r="20"/>
    <circle cx="144" cy="320" r="20"/>
    <circle cx="150" cy="150" r="16"/>
    <circle cx="362" cy="150" r="16"/>
  </g>
  <circle cx="256" cy="256" r="30" fill="#0A0E14"/>
  <circle cx="256" cy="256" r="15" fill="#F5A623"/>
`;

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="42%" r="70%">
      <stop offset="0" stop-color="#18202E"/>
      <stop offset="1" stop-color="#0A0E14"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  ${glyph}
</svg>`;

const adaptiveSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <g transform="translate(150 150) scale(1.414)">
    ${glyph}
  </g>
</svg>`;

async function main() {
  await sharp(Buffer.from(iconSvg)).flatten({ background: '#0A0E14' }).png().resize(1024, 1024).toFile(path.join(out, 'icon.png'));
  await sharp(Buffer.from(iconSvg)).png().resize(512, 512).toFile(path.join(out, 'splash-icon.png'));
  await sharp(Buffer.from(iconSvg)).flatten({ background: '#0A0E14' }).png().resize(64, 64).toFile(path.join(out, 'favicon.png'));
  await sharp(Buffer.from(adaptiveSvg)).png().resize(1024, 1024).toFile(path.join(out, 'adaptive-icon.png'));
  console.log('icons written to', out);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
