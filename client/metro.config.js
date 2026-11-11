const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// ВАЖНО: inlineRequires не включаем.
// react-native-reanimated/moti на web полагаются на порядок инициализации
// worklet-модулей; inline requires ломают это и дают
// "Uncaught ReferenceError: _WORKLET is not defined".
// Старт iOS/Android ускоряем Hermes-байткодом и splash, а не этим флагом.

module.exports = config;
