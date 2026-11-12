/**
 * Помощники для браузерных API, которым нужен secure context
 * (Web Serial, Web Bluetooth): HTTPS или localhost.
 */
import { Platform } from 'react-native';

function loc(): Location | null {
  if (Platform.OS !== 'web') return null;
  if (typeof window === 'undefined' || !window.location) return null;
  return window.location;
}

/** OTG/Web Serial работает только в защищённом контексте. */
export function isWebSecureContext(): boolean {
  if (Platform.OS !== 'web') return false;
  const location = loc();
  if (!location) return false;
  try {
    const secure = (window as unknown as { isSecureContext?: boolean }).isSecureContext;
    if (typeof secure === 'boolean') return secure;
  } catch {
    /* ignore */
  }
  const host = location.hostname;
  return location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
}

/**
 * HTTPS-адрес той же установки.
 * Для IP используем сертификат nip.io; порт 3443 — HTTPS-вход nginx.
 */
export function secureWebUrl(): string {
  const location = loc();
  if (!location) return '';
  if (location.protocol === 'https:') return location.origin;
  const host = location.hostname;
  if (!host) return '';
  const secureHost = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? `${host.replace(/\./g, '-')}.nip.io` : host;
  return `https://${secureHost}:3443`;
}
