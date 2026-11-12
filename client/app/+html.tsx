import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

/** HTML-оболочка для web-сборки: тёмный фон по умолчанию, светлый включается из JS. */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="ru">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
        <meta name="theme-color" content="#0A0E14" />
        <meta
          name="description"
          content="Kinto — приватный мессенджер на рое узлов: чаты, каналы, секретные диалоги и свои устройства хранения."
        />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Kinto" />
        <meta name="mobile-web-app-capable" content="yes" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" type="image/svg+xml" href="/icon.svg" />
        <link rel="apple-touch-icon" href="/icon.svg" />
    <style
      id="bg-root"
      dangerouslySetInnerHTML={{
        __html: `html,body{margin:0;padding:0;background:#0A0E14;height:100%;-webkit-text-size-adjust:100%;text-size-adjust:100%;touch-action:manipulation}body{color:#E8F0FA;color-scheme:dark}#scaling-root{display:none}*,*::before,*::after{-webkit-tap-highlight-color:transparent}@media (max-width:900px),(pointer:coarse){input,textarea,select{font-size:16px !important}html,body{touch-action:manipulation}}`,
      }}
    />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
