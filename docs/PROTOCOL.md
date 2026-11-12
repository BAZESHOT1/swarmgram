# Kinto Mesh Protocol v2

Статус: **core / simulation**. Прошивочная интеграция выполняется поэтапно;
аппаратные критерии требуют стенда с ESP32 + LoRa.

## 1. Адресация

- `mesh_addr` — 8 байт, стабильный идентификатор модуля, не зависит от радио.
  Для ESP32: `esp32-<MAC>` → BLAKE2b/FNV-64 → 8 байт. Один адрес для Wi-Fi и LoRa.
- `cluster_id` — 4 байта, `FNV1a32(sorted(anchor_mesh_addr[]))`.
  Якоря: gateway и стационарные repeater (питание от сети).
- `msg_id` — UUID v4.
- `sequence_number` — uint32 на отправителя, увеличивается на каждый mesh-пакет.

## 2. Beacon

```text
Beacon {
  version: u8 = 2
  type: u8 = BEACON
  mesh_addr: bytes[8]
  cluster_id: u32
  border: bool
  neighbor_clusters: u32[]
  rssi_hint: i8
  queue_depth: u8
  ttl: u8
  flags: u16  // gateway, anchor, wearable, lora, wifi
  seq: u32
}
```

Beacon отправляется каждые `BEACON_INTERVAL_MS` (по умолчанию 3000).
Border Node добавляет `border=true` и до 4 `neighbor_clusters`.

## 3. Cluster Manager

`cluster_id = fnv1a32(join(sorted(anchor_ids), "|"))`.
Если набор якорей меняется, cluster_id пересчитывается; старый ID живёт
`CLUSTER_GRACE_MS` (30 с), чтобы не рвать маршруты мгновенно.

Border election (`elect_border_node`):

```text
score = min(rssi_a, rssi_b) - queue_depth * 4 - battery_penalty
```

- Кандидат обязан видеть оба кластера минимум 3 beacon-интервала.
- Выбираются до 2 узлов: лучший и резервный.
- Порог: `min_rssi >= -95`, `max_queue_depth <= 8`.
- Переизбрание не чаще `BORDER_ELECTION_COOLDOWN_MS` (60 с).

## 4. Handover

Пороги:

- `HANDOVER_THRESHOLD = -85 dBm` — текущий кластер слабый.
- `HANDOVER_TARGET = -75 dBm` — целевой кластер сильный.
- `HANDOVER_HYSTERESIS = 3` beacon-интервала.
- `HANDOVER_RETRY_DELAY_MS = 15000`.

Состояния Wearable:

```text
IN_CLUSTER -> PENDING -> TRANSITIONAL -> COMPLETE
                    \-> RETRY -> PENDING
```

Пакеты:

```text
HANDOVER_REQUEST { mesh_addr, from_cluster, to_cluster, seq }
HANDOVER_ACCEPT  { mesh_addr, border_mesh_addr, route_id, ttl }
HANDOVER_COMPLETE{ mesh_addr, cluster_id }
HANDOVER_RETRY   { mesh_addr, cluster_id, delay_ms }
```

Во время `TRANSITIONAL`:

- сообщения помечаются `cluster_agnostic=true`;
- отправляются в старый и новый кластер параллельно;
- удаляются из очереди после ACK сервера/получателя;
- при потере Border Node — возврат в старый кластер и retry.

## 5. Hybrid routing

Route entry:

```text
destination_mesh_addr | next_hop_mesh_addr | interface | metric | expiry
```

- `metric` — EWMA задержки ACK в миллисекундах + штраф за hops.
- Wi-Fi предпочтителен при `metric < WIFI_PREFERRED_THRESHOLD` (120 мс).
- LoRa выбирается для текста/статуса, если Wi-Fi metric высокий или недоступен.
- Медиа и OTA — только Wi-Fi.
- TTL: Wi-Fi 16, LoRa 8. При Wi-Fi→LoRa `ttl = floor(ttl/2)`.
- Duplicate detection: кольцевой буфер 256 записей по
  `hash(src_mesh_addr, seq)`, TTL записи 60 с.

`select_route(destination, traffic_class)`:

1. Если media/ota и есть Wi-Fi — Wi-Fi.
2. Если Wi-Fi metric < threshold — Wi-Fi.
3. Если LoRa доступен и queue_depth < 3 — LoRa.
4. Иначе лучший по metric.
5. Нет маршрута — `ROUTE_NONE` (пакет в outbox).

## 6. Traffic classes

| Класс | Приоритет | Интерфейс | Сжатие |
|---|---|---|---|
| telemetry | low | LoRa | binary |
| ota | low/chunked | Wi-Fi only | 4 KiB chunks |
| telemetry_request | medium | any | none |
| search | medium | LoRa if no Wi-Fi | JSON < 1 KiB |
| text | high | any | optional protobuf |
| media | best-effort | Wi-Fi; LoRa thumb <2 KiB | WebP q20, 320px |

Media по LoRa: только thumbnail ≤ 2 КБ и `lora_queue_depth < 3`, иначе
`media_dropped_due_to_lora_congestion`.

## 7. Offline mode

ESK — Ed25519, генерируется при входе в Autonomous Mode.
Приватный ключ хранится в Keychain/Keystore, публичный — в каждом пакете.

```json
{
  "msg_id": "uuid",
  "chat_id": "hashed_chat_id",
  "sender_ephemeral_pubkey": "base64",
  "payload_ciphertext": "base64",
  "signature": "base64(ed25519(msg_id|chat_id|payload_ciphertext))",
  "timestamp": 0,
  "cluster_id": "hex8",
  "ttl_hops": 8
}
```

Outbox flush: батчи по 20, ACK → удалить и уничтожить ESK.
Если устройство сменилось до flush: запись получает
`unverifiable_after_device_change=true`; сообщение не переподписывается,
UI показывает «отправлено офлайн, подлинность подтверждена сетью».

## 8. Presence

- `ONLINE_SERVER`: есть интернет/шлюз, heartbeat < 5 с.
- `ONLINE_MESH`: сервера нет, но есть ACK прямого получателя.
- `OFFLINE_QUEUED`: сообщение в outbox, получатель не подтверждён.

При `ONLINE_MESH → ONLINE_SERVER` вызывается `outbox.flush()`; статусы
меняются с `mesh` на `delivered` после ACK.

## 9. Telemetry / OTA

Telemetry request:

```text
TELEMETRY_REQUEST { target_mesh_addr, metrics[], request_id }
TELEMETRY_REPORT  { request_id, target_mesh_addr, values{}, ts }
```

Rate limit: 1 запрос на модуль / 30 с, иначе 429 на шлюзе.

Cluster OTA:

```text
OTA_ANNOUNCE { firmware_hash, total_chunks, chunk_size }
OTA_CHUNK_REQUEST { firmware_hash, chunk_index }
OTA_CHUNK { firmware_hash, index, data[4 KiB] }
```

Только Wi-Fi. Chunk requester использует случайную задержку 50–500 мс.
