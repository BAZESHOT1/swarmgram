# Mesh network architecture (SpectraMesh-inspired)

This document describes the Kinto module network. It follows the ideas of
[SpectraMesh](https://github.com/SpectraMeshCore/spectramesh): every radio is a
**hue**, routes are loop-free, and control frames are authenticated. Cluster
election and cross-cluster handover are Kinto extensions on top of hue routing.

## Identity

- Primary mesh address: **6-byte factory Wi-Fi STA MAC** (`esp_read_mac`,
  `ESP_MAC_WIFI_STA`), canonical string `esp32-<12 hex>`.
- BLE MAC: alias only (`esp_bt_dev_get_address` / `ESP_MAC_BT`).
- The canonical string is cached in NVS (`swarm/hw_id`), so a reboot or
  reflash never changes identity.
- Wire header carries `srcMac[6]` / `dstMac[6]`; the 32-bit `src`/`dst`
  fields are a deterministic FNV-1a projection used by the route table.
- Server key: `mesh_devices.mesh_addr` (text, PRIMARY KEY) + `modules.hardware_id`
  unique index. No generated IDs are used for identity.

## Hues and routing

| Hue | Use |
|---|---|
| `wifi` | default data plane, high throughput |
| `lora` | long range, text/status when Wi-Fi is down |
| `ble` | local link to the phone |

`mesh_v2/spectramesh_adapter.c` implements:

```
metric(hue) = (1 - delivery_ratio) * w_loss
            + latency_ewma * w_latency
            + queue_depth * w_queue
```

Media is only sent over Wi-Fi. Every frame carries a TTL; duplicate detection
uses `(srcMac, packetId)` in a 256-entry ring. Broadcast is flooded once per
node; unicast uses the route table when a route exists, otherwise floods.

## Beacons, clusters

Beacon (JSON, backward compatible) now includes:

```json
{
  "hw": "esp32-aabbccddeeff",
  "mesh_addr": "aa:bb:cc:dd:ee:ff",
  "ble_mac": "aa:bb:cc:dd:ee:ff",
  "cluster_id": 305419896,
  "is_anchor": true,
  "border": false,
  "neighbor_clusters": [305419897],
  "hues": ["wifi", "ble"],
  "load": 0.12
}
```

- `cluster_id = CRC32(sorted(anchor MACs))`; anchors are gateways and
  stationary repeaters visible in the last 12 s. No anchor → cluster `0`.
- Border election: candidates that see two clusters are scored by
  `rssi + battery - queue_depth * 8`; up to 2 border nodes are chosen
  deterministically by mesh address.

## Handover

Trigger (wearable only): current cluster RSSI < -85 dBm and another cluster
> -75 dBm for **3 consecutive beacon intervals**.

```
HANDOVER_REQUEST → ACCEPT(temp route via border) → dual-send transitional
→ COMPLETE after 3 stable beacons / 10 s timeout → ABORT + return to old cluster
```

During the transition, queued messages are sent twice (cluster-agnostic); the
receiver deduplicates by `(srcMac, packetId)`.

Handover completion is logged server-side when a module's `cluster_id`
changes (`handover_events`, anomaly warning above 20 requests / 10 min).

## Telemetry and monitoring

- Modules send `TELEMETRY_REPORT` (`POST /v1/mesh/telemetry`) every 30 s:
  cluster, neighbors, average RSSI, queue depth, hues.
- Server aggregates in `telemetry_reports` and exposes
  `GET /v1/mesh/network`: modules per cluster, average RSSI, handovers/hour,
  max outbox depth.
- `GET /v1/devices` returns the MAC-keyed DeviceRegistry (`mesh_devices`).

## Offline mode

- Client generates an Ed25519 ESK on entering autonomous mode.
- Outbox items are signed and flushed in batches of 20
  (`POST /v1/mesh/outbox/flush`), Hub verifies the signature with Node's
  built-in Ed25519 and audits the batch.
- The normal authenticated upload path stores the message; `clientId`
  makes it idempotent. After a complete flush the ESK is destroyed.
- Limitation: the Hub cannot decrypt E2E payloads, so the audit endpoint
  verifies authenticity but the actual message is persisted by the regular
  encrypted upload flow.

## Known limitations

- `hue_path` is not yet encoded per hop; hue selection is local to the sender.
- BLE is a client link, not a routed mesh hue between modules.
- Live Activity/Dynamic Island still requires an ActivityKit extension.
