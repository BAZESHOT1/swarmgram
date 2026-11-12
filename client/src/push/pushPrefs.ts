/** Общие настройки push, доступные и в фоне, и в UI. */
import { kv } from '../crypto/storage';

export const HIDE_PUSH_CONTENT_KEY = 'sg:notify-hide-content';

export async function isPushContentHidden(): Promise<boolean> {
  try {
    return (await kv.get(HIDE_PUSH_CONTENT_KEY)) === '1';
  } catch {
    return false;
  }
}
