## Klinto 1.10.55

Includes 1.10.53 and 1.10.54 (their iOS builds were cancelled by newer pushes).

- Remote module configuration (firmware 177): module type, battery divider, LoRa chip and pins, ESP-NOW and LoRa power; owner-signed by the Hub, over BLE, USB or kMesh. "Настроить" button in the module list.
- Fix: neighbours and name of the connected module reach the cluster map.
- Fix: WebSocket reconnect survives token refresh failures; web client has a direct fallback endpoint and an HTTP polling mode when the socket cannot connect.
