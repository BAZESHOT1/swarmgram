# Kinto Mesh Transport (KMT v1)

KMT carries **any JSON API traffic** of the app over BLE + Wi-Fi mesh when the
phone has no internet. It is transparent to the app: `api.req()` falls back to
KMT when the module is connected and `transportOnline` is false.

## Layers

```
App API request
  │  AES-256-GCM (meshRelayKey = HKDF(userId, deviceId))
  ▼
BLE frame DATA_UP  chatId="__http__"
  │
Wearable ── MT_DATA broadcast/route ──► repeater ──► border ──► gateway
  │                                                         │
  │                                    POST /v1/modules/http (module token)
  │                                                         ▼
  │                                    Hub decrypts blob, performs the API call
  │                                    as the user (short-lived 120 s token),
  │                                    encrypts {status, body} and returns blob
  ▼
BLE frame DATA_DOWN chatId="__http__"  ◄── route back to source mesh_addr
```

- Encryption: AES-256-GCM, random 12-byte nonce per request. The gateway only
  sees an opaque blob; it cannot read tokens or bodies.
- Auth: the Hub issues a short-lived access token for the **verified module
  owner**; the gateway cannot elevate privileges.
- Path allowlist: all `/v1/*` except `admin`, `auth`, `objects`, `uploads`,
  `keys`.
- Idempotency: request `id`; client keeps a pending map with a 15 s timeout.
- Responses: JSON `{status, body}`; errors propagate as `ApiError`.

## Routing

- Mesh frames use the mesh-v2 router: hue metric (Wi-Fi/LoRa), route table,
  TTL, duplicate ring `(srcMac, packetId)`, cluster/border selection.
- API requests are broadcast if no gateway route is known; once a gateway
  neighbour/route is learned they use `meshTransmitRouted` unicast.
- Responses are unicast to the source `mesh_addr` and fall back to flood.

## Reliability

- The gateway keeps a persistent queue: if Hub is unreachable, the request
  stays in LittleFS and is retried.
- Downlink: `GET /v1/modules/relay/pending?since=<seq>` (numeric cursor).
  Text envelopes ≤ 4 KB include `envelopeB64` so the receiver can decrypt
  without downloading an object.
- `mesh_inbox` is drained every 30 s; `clientId` dedup prevents duplicates.

## Limitations / v2 roadmap

- LoRa API traffic is fragmented by the existing MT_FRAG layer; large
  responses are currently limited to Wi-Fi.
- Media uploads still require internet; KMT v2 will add chunked object
  transfer and per-chunk ACKs.
- The mesh relay key is derived from `(userId, deviceId)` on the Hub and
  shared with the phone at login; key rotation is tied to device revocation.
