/**
 * Платформенная точка входа web push.
 * Общий код импортирует `../push` — Metro/Vite подставят `.web.ts` на вебе.
 */
export { registerWebPush } from './push.web';
export { registerWebPush as initPush } from './push.web';
export type { WebPushCleanup, WebPushSession } from './push.web';
