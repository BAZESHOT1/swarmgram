/**
 * Единая точка входа модулей: протокол, типы, транспорт и React-провайдер.
 * Импорт `./modules` на native подставит transport.native.ts.
 */
export * from './protocol';
export * from './types';
export * from './transport';
export { ModuleProvider, useModuleConnection } from './ModuleProvider';
