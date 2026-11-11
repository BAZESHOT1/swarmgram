const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Inline requires ускоряют старт: модули подгружаются по мере обращения,
// а не все сразу при инициализации бандла.
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

module.exports = config;
