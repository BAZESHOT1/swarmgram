/**
 * Исправление op-sqlite для статических framework-подов iOS.
 *
 * podspec собирает все заголовки внутри ios, куда попадают заголовки внутри
 * libsql/crsqlite/sqlitevec.xcframework. Xcode затем копирует libsql.h
 * и в op_sqlite.framework/Headers, и из vendored framework — возникает
 * «Multiple commands produce .../libsql.h» (exit 65).
 */
const fs = require('fs');
const path = require('path');

const podspec = path.join(
  __dirname,
  '..',
  'node_modules',
  '@op-engineering',
  'op-sqlite',
  'op-sqlite.podspec',
);

try {
  let text = fs.readFileSync(podspec, 'utf8');
  const before = text;
  text = text.replace(
    'source_files = Dir.glob("ios/**/*.{h,m,mm}") + Dir.glob("cpp/**/*.{h,cpp,c}")',
    'source_files = Dir.glob("ios/**/*.{h,m,mm}").reject { |f| f.include?(".xcframework") } + Dir.glob("cpp/**/*.{h,cpp,c}")',
  );
  text = text.replace(
    's.vendored_frameworks = frameworks',
    's.vendored_frameworks = frameworks unless frameworks.empty?',
  );
  if (text !== before) {
    fs.writeFileSync(podspec, text);
    console.log('[patch] op-sqlite podspec: xcframework headers excluded');
  }
} catch (error) {
  console.warn('[patch] op-sqlite podspec not patched:', error?.message ?? error);
}
