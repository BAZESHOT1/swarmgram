## Kinto 1.10.61

Includes 1.10.60 (its release was not published).

- Connected module card shows the real cluster (gateway present / mobile gateway / searching, channel) instead of "Cluster unknown".
- The Hub now also receives a connected module's neighbours from the phone, so all your modules appear on the cluster map even when no gateway forwarded their links.
- kMesh sending: a stuck BLE write no longer holds the queue for 30-45 s (12 s / 20 s limits).
- Hub-access indicator in the navbar (pulsing green globe / red cross / spinner) fixed.
- Firmware 1.4.5: modules lose the cluster after 2 missed beacons, retry 3 times for 2 s on the same channel, then scan; LoRa no longer starves the gateway when the IRQ pin is wired wrong (priority lowered, back-off, log warning).
