/* eslint-disable no-undef */
/**
 * Firebase Cloud Messaging service worker (web push).
 * Лежит в public/ и копируется в dist без сборки.
 */
importScripts('https://www.gstatic.com/firebasejs/11.0.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyBW8RI2Hp2jezNlprSm-IeawWBRphEFjJY',
  authDomain: 'vdoh-crm.firebaseapp.com',
  projectId: 'vdoh-crm',
  storageBucket: 'vdoh-crm.firebasestorage.app',
  messagingSenderId: '1014607310889',
  appId: '1:1014607310889:web:c184cfeb2c861d0d5d6c38',
  measurementId: 'G-CDLNJE1B6Z',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notification = payload.notification || {};
  const data = payload.data || {};
  const title = notification.title || data.title || 'Klinto';
  const body = notification.body || data.body || '';

  return self.registration.showNotification(title, {
    body: body,
    data: data,
    icon: '/icon.svg',
    badge: '/icon.svg',
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const chatId = data.chatId || data.chat_id;
  const url = chatId ? '/chat/' + encodeURIComponent(chatId) : '/chats';

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });

      for (const client of clientList) {
        if ('focus' in client) {
          try {
            if ('navigate' in client) await client.navigate(url);
          } catch {
            /* навигация недоступна — просто фокусируем вкладку */
          }
          return client.focus();
        }
      }

      return self.clients.openWindow(url);
    })(),
  );
});
