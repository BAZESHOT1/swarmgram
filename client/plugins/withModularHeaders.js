/**
 * Firebase iOS SDK + RNFirebase статическими библиотеками требуют modular
 * headers для GoogleUtilities/FirebaseCoreInternal. Добавляем директиву в
 * Podfile после генерации проекта.
 */
const fs = require('node:fs');
const path = require('node:path');
const { withDangerousMod } = require('@expo/config-plugins');

module.exports = function withModularHeaders(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podfile = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(podfile)) return cfg;
      let content = fs.readFileSync(podfile, 'utf8');
      if (!content.includes('use_modular_headers!')) {
        content = content.replace(
          /(platform :ios[^\n]*\n)/,
          '$1\n# Firebase requires modular headers for static Swift/ObjC pods.\nuse_modular_headers!\n',
        );
        fs.writeFileSync(podfile, content);
      }
      return cfg;
    },
  ]);
};
