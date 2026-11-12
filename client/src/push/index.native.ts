/**
 * Native push entry point. Platform resolution picks this file on iOS/Android;
 * the web build never imports Firebase/notifee.
 */

export * from './push.native';
export { initNativePush as initPush } from './push.native';
export * from './types';

/** На native разрешение уже запрашивается при регистрации push. */
export async function ensureWebPushPermission(): Promise<'unsupported'> {
  return 'unsupported';
}
