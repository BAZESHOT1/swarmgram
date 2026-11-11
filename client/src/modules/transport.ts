/**
 * Платформенная точка входа транспортов.
 *
 * На web используется Web Serial/Web Bluetooth (transport.web.ts),
 * на iOS/Android Metro подставит transport.native.ts.
 */
export * from './transport.web';
