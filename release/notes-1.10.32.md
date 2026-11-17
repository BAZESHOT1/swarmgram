# Klinto 1.10.32 — домены kintoapp.xyz и hub.kintoapp.xyz

Дата: 17 ноября 2026 года.

## Новые адреса

| Назначение | Основной адрес | Резерв |
| --- | --- | --- |
| Web | `https://kintoapp.xyz` | `https://150-251-143-212.nip.io:3443`, `https://kinto.is-a.dev` |
| Hub / API / KMesh | `https://hub.kintoapp.xyz` | `https://150-251-143-212.nip.io:3443/api` |
| Загрузка приложения | `https://get.kintoapp.xyz` | — |

- Все прошлые домены и HTTPS-входы сохранены в nginx (`server_name`), старые
  сертификаты продолжают работать.
- `HUB_PUBLIC_URL` на сервере переключён на `https://hub.kintoapp.xyz`;
  Hub подтверждает `publicUrl` в логе.
- Web собран заново и выложен в `kintoapp.xyz`; каталог предыдущей версии
  сохранён в `/opt/swarmgram/web-prev`.

## Приложение

- Первый адрес API — `https://hub.kintoapp.xyz/api`.
- При сетевой ошибке клиент автоматически перебирает резервные адреса:
  `https://150-251-143-212.nip.io:3443/api`, `https://api.kinto.is-a.dev/api`,
  `https://api.kinto.io/api`.
- WebSocket: `wss://hub.kintoapp.xyz/ws`.
- `secureWebUrl` для доменов теперь ведёт на `https://<host>` (без `:3443`).

## Прошивка и шлюзы

- Прошивка 167: `KL_HUB_URL` по умолчанию — `https://hub.kintoapp.xyz`;
  сохранённый в NVS старый Hub URL больше не перекрывает адрес из сборки.
- Шлюз проверен вживую: `gateway uplink=http hub=https://hub.kintoapp.xyz`,
  `GW->HUB: uplink ok status=200`.
- OTA и KMesh-релей используют тот же базовый URL.

## Проверка

| Проверка | Результат |
| --- | --- |
| `https://kintoapp.xyz/` | 200 |
| `https://hub.kintoapp.xyz/api/health` | `{"ok":true,...}` |
| `https://get.kintoapp.xyz/` | 200 |
| Hub publicUrl | `https://hub.kintoapp.xyz` |
| Шлюз → Hub | `uplink ok status=200` |
| APK 1.10.32 | SHA-256 `af373cd40c00db8ffbbd0ec5ff8c35c41a83e9a1fda4c80f63c14450c94bbac3` |
| IPA 1.10.32 | SHA-256 `701815339526c32bc2461eddcf18718e731ca339189bf14ac9b004f833bc7ec4` |
