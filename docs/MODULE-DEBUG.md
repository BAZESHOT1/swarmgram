# Module debug & flashing

Админ → вкладка **«Отладка»** (`client/app/(app)/admin.tsx`,
`client/src/components/admin/ModuleDebugPanel.tsx`).

Страница работает через локальный bridge на ПК:

```bat
cd tools\module-bridge
npm install
start.cmd
```

Bridge слушает `127.0.0.1:8787` и даёт браузеру:

- список COM-портов и автоопределение модуля (`SG-INFO`: MAC, роль, прошивка);
- мониторы нескольких портов одновременно (SSE, последние 600 строк);
- DTR/RTS reset;
- прошивку `merged.bin` через `esptool` в `0x0`;
- скачивание готовой сборки из Hub по `buildId` + access token.

## Требования

- Python 3.12 + `pip install esptool pyserial`
  (bridge сам находит `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`);
- Node.js + `serialport` (устанавливается `npm install`);
- USB-кабель с линиями данных (не charge-only).

## Что проверять на нескольких модулях

1. Подключить все модули USB → в списке портов появятся `COMx`.
2. Открыть монитор каждого порта: в первых строках будет
   `SG-INFO {"hardwareId":"esp32-…","role":"…"}` и `firmware=…`.
3. Прошить каждому свою сборку (роль должна совпадать с физической ролью).
4. После перезагрузки убедиться:
   - MAC в `SG-INFO` не изменился;
   - gateway: `sta=1`, `apClients>0`, `udp rx>0`;
   - все: `[cluster] cid=…` одинаковый, `[border]` только у реальных мостов;
   - `[handover]` не появляется без пересечения границы кластера.
5. В админке Hub: `GET /v1/devices` и `GET /v1/mesh/network` показывают
   модули по MAC, кластерам, RSSI и хендоверам.

## Диагностика

| Симптом | Что смотреть |
|---|---|
| модуль не виден в списке | драйвер CH340/CP210x, кабель, `mode` COM-порта |
| нет `SG-INFO` | неверный baud (115200), плата не сбросилась |
| `mesh AP not found` | gateway не поднял AP или канал/SSID; hidden должен быть 0 |
| `apClients=0` | модуль не ассоциировался; смотреть `[wifi]` на обоих |
| `udp rx=0` | broadcast/подсети; проверить `10.42.x.x` у AP |
| `cid` скачет | в beacon попал чужой/свой `hw`; проверить `is_anchor` |
| handover-шторм | старые прошивки шлют `request`; gateway теперь отвечает `reject` |
