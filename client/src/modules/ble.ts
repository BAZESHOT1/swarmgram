/**
 * Платформенная точка входа BLE.
 *
 * Metro на iOS/Android выберет ble.native.ts, веб-сборка — ble.web.ts.
 * TypeScript и Vite резолвят этот файл для веба.
 */
export { NativeBleTransport } from './ble.web';
export { NativeBleTransport as default } from './ble.web';
