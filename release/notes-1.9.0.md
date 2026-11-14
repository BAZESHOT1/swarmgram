# Klinto 1.9.0 — производительность чатов и UX уровня Telegram

Дата: 14 ноября 2026 года.

## Главное

- **FlashList** для списка чатов и ленты сообщений
  (`estimatedItemSize`, переиспользование ячеек, `getItemType`).
- **MMKV** (iOS/Android) и синхронный Map + localStorage (Web) для
  `last_read_msg_id`, черновиков, позиции скролла и метаданных чатов.
- **op-sqlite** с WAL и индексом `(chat_id, created_at, msg_id)` на нативе;
  IndexedDB + in-memory кэш на web. Предзагрузка топ-5 чатов по 40 сообщений.
- **react-native-keyboard-controller**: `KeyboardProvider` в корне,
  синхронная анимация клавиатуры, `interactive` dismiss.
- **Reanimated + Gesture Handler**: свайп влево по сообщению для ответа,
  пружинный возврат, haptic при пороге; разделитель «Непрочитанные сообщения».
- **expo-image** для аватаров и медиа: disk/memory cache, без мигания.

## Платформы

- iOS: native build подтверждён GitHub Actions.
- Android: native build подтверждён GitHub Actions.
- Web: `expo export -p web` без ошибок; в бандле нет `op-sqlite`,
  `react-native-mmkv` и Nitro-модулей.

## Проверка

| Проверка | Результат |
| --- | --- |
| `tsc --noEmit` | OK |
| Web export | OK |
| Нативные модули в web-бандле | отсутствуют |
| Android APK | SUCCESS |
| iOS IPA | SUCCESS |
| Android heap Gradle | 4 ГБ |
| iOS op-sqlite libsql.h | исправлено postinstall-патчем |

## Артефакты

- `Klinto-android.apk` — versionCode 10900.
- `Klinto-unsigned.ipa` — unsigned IPA для Sideloadly.
- `klinto-web-1.9.0.zip`.
