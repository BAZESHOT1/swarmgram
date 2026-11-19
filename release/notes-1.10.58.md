## Klinto 1.10.58

- New app icon everywhere (iOS, Android, web, PWA, notifications, app header).
- Chat: incoming messages appear in the open chat instantly (decrypted from the realtime event, no full reload); history loads with parallel decryption and background delivery receipts; older pages are prefetched earlier and cached; full refresh only every 60 s as a safety net.
- kMesh ⇄ internet: a message sent via kMesh no longer hangs when internet returns — Hub-synced status reaches the chat; texts that never reached the module are sent over HTTP as soon as the internet is back; sending to a slow module never blocks the UI for more than 4 s.
- Firmware 1.4.4: modules keep the cluster channel while connected; on link loss they retry on the same channel for 30 s before scanning; a phone on BLE keeps the module on the last cluster channel.
- Firmware 1.4.4: LoRa band follows the chip — SX1278 uses the 433 MHz channel plan (it cannot work at 868 MHz), SX1262/SX1276/LR2021 use 868 MHz; OTA diagnostics in the module log (why an announce was ignored, download progress, gateway checks).
