# Фоновый mesh и BLE

Клиент держит подключение к носимому модулю, пока приложение в фоне, но не
завершено пользователем. Убитое приложение ОС не поднимает ради BLE, поэтому
фоновые уведомления работают только в состоянии background/inactive.

## iOS

- `app.json` → `ios.infoPlist.UIBackgroundModes` содержит
  `fetch`, `remote-notification`, `bluetooth-central`.
- `NSBluetoothAlwaysUsageDescription` уже задан.
- `BleManager` создаётся один раз (`src/modules/ble.native.ts`) с
  `restoreStateIdentifier` / `restoreStateFunction`: после фонового запуска
  CoreBluetooth отдаёт уже подключённые периферийные устройства.
- Активное соединение не закрывается при переходе в background. При возврате
  в `active` `ModuleProvider` сверяет состояние транспорта и при разрыве
  запускает восстановление.
- Входящий mesh/BLE-конверт в фоне показывает локальное уведомление Notifee
  (`src/push/local.native.ts`), в foreground — только in-app карточку.

## Android

- `app.json` → `android.permissions`: `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `FOREGROUND_SERVICE_DATA_SYNC`,
  `POST_NOTIFICATIONS`.
- При успешном подключении модуля `ModuleProvider` запускает foreground
  service через Notifee (`src/modules/background.native.ts`). Используется уже
  установленный `@notifee/react-native`, без новых native-модулей.
- `plugins/withNotifeeForegroundService.js` (Expo config plugin) добавляет
  сервису Notifee типы `connectedDevice|dataSync|shortService`: без этого
  Android 14+ останавливает `shortService` через несколько минут. Это только
  правка AndroidManifest, native-код не добавляется.
- Канал `klinto-mesh` имеет `AndroidImportance.LOW`: без звука, вибрации и
  heads-up. Уведомление постоянное (`ongoing`), пока модуль подключён.
- При разрыве, ручном disconnect или выходе из аккаунта сервис
  останавливается.

## Ограничения

- iOS Live Activity / Dynamic Island для состояния mesh **не реализованы**:
  это требует отдельного ActivityKit/Widget Extension и native-кода.
  Имитации нет. TODO оставлен в `src/modules/background.native.ts`.
- Фоновое сканирование на iOS ограничено системой; надёжнее держать уже
  установленное соединение, чем рассчитывать на новый скан в фоне.
- Android 14+ может ограничивать foreground service в зависимости от
  политики производителя; уведомление и разрешения должны быть выданы.
