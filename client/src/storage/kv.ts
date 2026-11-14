/**
 * Типовой fallback для TypeScript. Metro на каждой платформе выбирает
 * kv.native.ts или kv.web.ts, этот файл в бандл не попадает.
 */
export { syncKv } from './kv.web';
