# Routing metrics and thresholds

## EWMA задержки

```
sample = now_ms - sent_at
ewma = (ewma == 0) ? sample : ewma * (1 - ALPHA) + sample * ALPHA
```

- `ALPHA = 0.25`
- Замер обновляется только по ACK.
- При 3 потерях ACK подряд `metric = INFINITY`, маршрут удаляется через `ROUTE_EXPIRY_MS = 45000`.

## Составной metric

```
metric = ewma_rtt_ms + hop_count * 35 + queue_depth * 8
```

Порог Wi-Fi: `WIFI_PREFERRED_THRESHOLD = 120`.
LoRa: `LORA_PREFERRED_THRESHOLD = 400` (используется как fallback).

## Handover

| Параметр | Значение |
|---|---|
| HANDOVER_THRESHOLD | -85 dBm |
| HANDOVER_TARGET | -75 dBm |
| HANDOVER_HYSTERESIS | 3 beacon |
| HANDOVER_RETRY_DELAY_MS | 15000 |
| BORDER_ELECTION_COOLDOWN_MS | 60000 |

## Border election

```
score = min(rssi_a, rssi_b) - queue_depth * 4
```

- Отбрасываются кандидаты с `min_rssi < -95` или `queue_depth > 8`.
- Выбираются top-2 (основной и резервный).
- Основной переизбирается только если его score упал ниже 90% от лучшего.

## TTL

- Wi-Fi: 16
- LoRa: 8
- Wi-Fi → LoRa: `floor(ttl / 2)`
- TTL 0 — drop + счётчик `mesh_ttl_expired`.

## Traffic priorities

`text` > `telemetry_request` > `search` > `telemetry` > `ota` > `media`.

Медиа:
- Wi-Fi: полный файл.
- LoRa: только thumbnail ≤ 2 КБ при `lora_queue_depth < 3`.
- Иначе `media_dropped_due_to_lora_congestion`.

## Presence

| Состояние | Условие |
|---|---|
| ONLINE_SERVER | transportOnline и heartbeat < 5000 мс |
| ONLINE_MESH | есть ACK от mesh-получателя |
| OFFLINE_QUEUED | outbox > 0 и нет ACK |

Переход `ONLINE_MESH → ONLINE_SERVER` инициирует `outbox.flush(20)`.
