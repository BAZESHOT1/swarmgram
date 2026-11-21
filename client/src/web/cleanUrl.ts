/**
 * Web: expo-router дописывает к адресу служебный ?__EXPO_ROUTER_key=… — вырезаем его из каждого
 * pushState/replaceState до того, как адрес попадёт в строку браузера. На native — ничего не делает.
 */
const KEY = '__EXPO_ROUTER_key';

function clean(url: string | URL | null | undefined): string | URL | null | undefined {
  if (url == null) return url;
  const raw = String(url);
  if (!raw.includes(KEY)) return url;
  try {
    const u = new URL(raw, window.location.href);
    u.searchParams.delete(KEY);
    return u.pathname + u.search + u.hash;
  } catch {
    return raw.replace(new RegExp(`[?&]${KEY}=[^&#]*`), '').replace(/\?&/, '?').replace(/\?$/, '');
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof window.history?.pushState === 'function') {
  const push = window.history.pushState.bind(window.history);
  const replace = window.history.replaceState.bind(window.history);
  window.history.pushState = (data: unknown, unused: string, url?: string | URL | null) => push(data, unused, clean(url));
  window.history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => replace(data, unused, clean(url));
  const now = clean(window.location.href);
  if (now !== window.location.href) replace(window.history.state, '', now);
}

export {};
