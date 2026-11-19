## Klinto 1.10.56

- Module is online if a packet from it reached the Hub in the last 30 minutes.
- Module settings without a direct connection: the Hub delivers the owner-signed command through the gateway of the module's cluster (kMesh downlink).
- Module settings: transports (ESP-NOW / LoRa) and LED pin.
- Admin → OTA: build a release (canonical images per chip, node and gateway variants), start a rollout for selected clusters and transports (ESP-NOW, LoRa), progress per module.
- Firmware 178/179: LoRa receive fixed (RadioLib 8), ESP-NOW ⇄ LoRa bridging, LoRa driver in every build, module data volume in NVS, OTA over kMesh with full image written straight to the OTA slot, cascade, post-update link check with automatic rollback.
