## Klinto 1.10.54

Includes everything from 1.10.53 (its iOS build was cancelled by a newer push).

- Remote module configuration (firmware 177): module type, battery divider pin/ratio, LoRa chip and pins, ESP-NOW and LoRa power; owner-signed by the Hub, delivered over BLE, USB or kMesh.
- Module list: "Настроить" button on every module.
- Fix: neighbours and name of the connected module reach the cluster map.
- Fix: the WebSocket reconnect no longer stops when the token refresh fails temporarily ("Нет связи").
