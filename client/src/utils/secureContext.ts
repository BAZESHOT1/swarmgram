/**
 * Помощники для браузерных API, которым нужен secure context
 * (Web Serial, Web Bluetooth): HTTPS или localhost.
 */
import { Platform } from 'react-native';
import { getSession } from '../data/api';

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

/**
 * Открывает HTTPS-версию, перенося текущую сессию через window.name.
 * Так после перехода не нужно логиниться заново (localStorage у другого
 * origin свой, а window.name сохраняется в пределах вкладки).
 */
export function openSecureWeb(): void {
  const url = secureWebUrl();
  if (!url) return;
  try {
    const session = getSession();
    if (session) window.name = `klinto-session:${JSON.stringify(session)}`;
  } catch {
    /* сессия не критична: пользователь просто войдёт заново */
  }
  if (typeof window !== 'undefined') window.location.href = url;
}

/** Забирает сессию, переданную из HTTP-версии при переходе на HTTPS. */
export function takeHandoffSession(): unknown | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    const value = window.name;
    if (!value || !value.startsWith('klinto-session:')) return null;
    window.name = '';
    return JSON.parse(value.slice('klinto-session:'.length));
  } catch {
    return null;
  }
}
