/**
 * Платформенная точка входа push.
 *
 * Metro выбирает `index.native.ts` для iOS/Android и этот файл для web
 * (на вебе Firebase JS SDK, на нативе — RNFirebase + background-fetch).
 * TypeScript видит web-вариант; сигнатуры `initPush(session)` совпадают.
 */
export { registerWebPush as initPush } from './push.web';
export { registerWebPush } from './push.web';
export type { WebPushCleanup as PushCleanup, WebPushSession as PushSession } from './push.web';
