/**
 * Увеличивает понятную версию прошивки Klinto.
 *
 * Использование:
 *   node scripts/bump-firmware-version.mjs        # 1.1 -> 1.2
 *   node scripts/bump-firmware-version.mjs 1.5    # зафиксировать 1.5
 *
 * Файл firmware/klinto_core/VERSION читает firmware-builder и подставляет
 * в config.h как KL_FIRMWARE_VERSION.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'firmware/klinto_core/VERSION';
const current = readFileSync(file, 'utf8').trim();
const explicit = process.argv[2];

let next;
if (explicit) {
  if (!/^\d+\.\d+$/.test(explicit)) {
    console.error('Версия должна быть в формате 1.1, 1.2, ...');
    process.exit(1);
  }
  next = explicit;
} else {
  const match = /^(\d+)\.(\d+)$/.exec(current);
  if (!match) {
    console.error(`Некорректная текущая версия: ${current}`);
    process.exit(1);
  }
  next = `${match[1]}.${Number(match[2]) + 1}`;
}

writeFileSync(file, `${next}\n`, 'utf8');
console.log(`Версия прошивки: ${current} -> ${next}`);
