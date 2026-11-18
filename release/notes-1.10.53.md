## Klinto 1.10.53

- Remote module configuration (firmware 177): module type, battery divider pin/ratio, LoRa chip and pins, ESP-NOW and LoRa power. Commands are signed by the Hub for the module owner and delivered over BLE, USB or kMesh; settings are stored in the module and survive reboot.
- Module list: "Настроить" button on every module.
- Fix: live neighbours and name of the connected module now reach the cluster map.
- Hub 1.4.10: POST /kmesh/v1/modules/:mac/config (signed config), firmware 177.
