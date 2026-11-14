# Производительность экранов чатов

## Стек

- **FlashList 1.7** — виртуализация списка чатов и сообщений, переиспользование ячеек.
- **Reanimated 3.16 + Gesture Handler 2.20** — свайп ответа на сообщении целиком на UI-потоке.
- **react-native-keyboard-controller 1.15** — `KeyboardProvider` в корне и синхронная
  анимация клавиатуры; на web используется `KeyboardAvoidingView` из RN.
- **expo-image** — аватары и медиа с кэшем `memory-disk` и `recyclingKey`.
- **react-native-mmkv 2.12** — синхронный KV на iOS/Android.
- **op-sqlite 11.4** — локальная БД сообщений с WAL и индексом
  `(chat_id, created_at DESC, msg_id)`.

## Платформенное разделение

| Слой | Native | Web |
| --- | --- | --- |
| KV | `src/storage/kv.native.ts` (MMKV) | `src/storage/kv.web.ts` (Map + localStorage) |
| Сообщения | `src/storage/messages.native.ts` (op-sqlite) | `src/storage/messages.web.ts` (IndexedDB + Map) |

Metro выбирает файлы по расширению, поэтому `op-sqlite`, `mmkv` и Nitro
не попадают в web-бандл. Проверка: в `dist/_expo/static/js/web` нет строк
`op-sqlite`, `react-native-mmkv`, `nitro-modules`.

## Первый кадр

- `last_read_msg_id`, черновики, позиция скролла и метаданные чатов лежат в
  синхронном KV и читаются прямо в `useState`/`useMemo`.
- При старте `loadCaches()` прогревает последние 40 сообщений топ-5 чатов;
  `getCachedMessages()` сначала смотрит в память, затем в локальную БД.
- Чат с непрочитанными открывается на границе первого непрочитанного
  сообщения; при отсутствии непрочитанных — строго внизу.

## Список чатов

- `FlashList` с `estimatedItemSize={86}` и `drawDistance={900}`.
- Свайпы — `Swipeable` из Gesture Handler (нативный жест), haptic при
  пересечении порога.
- Аватары — `expo-image`, кэш на диск и в память, без мигания.

## Экран чата

- `FlashList` с `estimatedItemSize={72}`, `drawDistance={1000}`,
  `getItemType` (`text/media/system/unread_divider`) и
  `maintainVisibleContentPosition`.
- Разделитель «Непрочитанные сообщения» вставляется в ленту.
- Свайп влево по сообщению — Reply: `Gesture.Pan` с
  `activeOffsetX([-15,15])`, `failOffsetY([-10,10])`, `withSpring`,
  haptic при срабатывании.
- Optimistic UI уже был в `onSend`; добавлены синхронный черновик и
  сохранение последнего прочитанного сообщения.
- Кнопка «Вниз» со счётчиком новых сообщений появляется, когда пользователь
  читает старую переписку.
