/**
 * Expo config plugin: Notifee foreground service type for mesh BLE.
 *
 * Notifee 9 ships `app.notifee.core.ForegroundService` with
 * `android:foregroundServiceType="shortService"`. Android 14+ would stop a
 * short service after a few minutes, so merge in the types we actually use.
 * This is a manifest-only change — no native module is added.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const SERVICE_NAME = 'app.notifee.core.ForegroundService';
const SERVICE_TYPES = 'connectedDevice|dataSync';

module.exports = function withNotifeeForegroundService(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    if (!manifest.$) manifest.$ = {};
    if (!manifest.$['xmlns:tools']) manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    const application = manifest.application && manifest.application[0];
    if (!application) return mod;

    if (!Array.isArray(application.service)) application.service = [];
    let service = application.service.find(
      (item) => item && item.$ && item.$['android:name'] === SERVICE_NAME,
    );
    if (!service) {
      service = { $: { 'android:name': SERVICE_NAME, 'android:exported': 'false' } };
      application.service.push(service);
    }
    service.$['android:foregroundServiceType'] = SERVICE_TYPES;
    service.$['tools:replace'] = 'android:foregroundServiceType';
    return mod;
  });
};
