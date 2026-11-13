# Kinto module bridge

Локальный HTTP-сервис для админ-страницы **Отладка**:

- список COM-портов и автоопределение модуля (MAC, роль, прошивка);
- живые мониторы портов (SSE) для нескольких модулей одновременно;
- сброс платы;
- прошивка `merged.bin` через `esptool` (Python 3 + `pip install esptool pyserial`).

Слушает только `127.0.0.1:8787`.

## Запуск

```bat
cd tools\module-bridge
npm install
start.cmd
```

Или вручную:

```bat
node server.mjs --port=8787
```

Python ищется по пути `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`.
Можно задать свой: `set KINTO_PYTHON=C:\Python312\python.exe`.

## API

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/health` | bridge + python |
| GET | `/api/ports` | порты и распознанные модули |
| POST | `/api/open` | `{path, baud}` — открыть монитор |
| POST | `/api/close` | закрыть порт |
| POST | `/api/reset` | DTR/RTS сброс |
| POST | `/api/write` | отправить строку |
| POST | `/api/flash` | `{path, url?, file?, token?, board}` |
| GET | `/api/logs?path=COM4` | последние строки |
| GET | `/api/stream?path=COM4` | SSE-поток |

## Прошивка

`file` — локальный `merged.bin`. `url` + `token` — скачать сборку из Hub
(`/v1/firmware/builds/:id/download`), затем прошить в `0x0`.

## Безопасность

Сервис не выходит в сеть и не требует авторизации: любой локальный процесс
может прошить подключённый модуль. Не запускайте на общих машинах.
