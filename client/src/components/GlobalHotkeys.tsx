/**
 * Глобальные горячие клавиши (web):
 *  - Ctrl/Cmd+K — перейти к чатам и сфокусировать поиск (событие `sg-focus-search`);
 *  - Ctrl/Cmd+N — новый чат (/compose);
 *  - Esc — назад.
 * В input/textarea сочетания не перехватываем, Esc работает всегда.
 */
import React from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';

function isEditable(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true;
}

export function GlobalHotkeys() {
  React.useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        router.back();
        return;
      }
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || isEditable(e.target)) return;

      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        router.push('/chats' as never);
        // Даём экрану смонтироваться, затем просим сфокусировать поиск.
        setTimeout(() => {
          try {
            window.dispatchEvent(new Event('sg-focus-search'));
          } catch {
            /* ignore */
          }
        }, 60);
      } else if (key === 'n') {
        e.preventDefault();
        router.push('/compose' as never);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return null;
}
