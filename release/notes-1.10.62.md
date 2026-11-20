## Kinto 1.10.62

kMesh works without internet: messages, search, chat list and the network map, verified on an Android phone with three modules (wearable, repeater, SX1278 LoRa gateway).

- Hub sends replies (search, chat list, chat keys) and incoming messages to the module the phone is actually connected to. Before, they went to the user's other module (for example the wearable while the phone was on the repeater) and never arrived.
- BLE to the module is much faster: Android writes without waiting for a per-chunk response, uses larger chunks under the MTU and asks for a high-priority connection; frames that already timed out are dropped instead of piling up (delays of 12-40 s are gone).
- Sending through kMesh no longer waits on HTTP requests for chat keys while offline (a message used to start sending after up to a minute).
- Delivery statuses ("Saved in Hub") now reach the right bubble even with a long backlog of old unsent messages.
- Incoming kMesh messages without a chat key on the device: the app requests the key from Hub through kMesh and decrypts the message instead of dropping it. Keys of recent chats are requested in advance when a module connects.
- Search and chat-list refresh over kMesh show a loading bar; offline HTTP errors are no longer shown in red.
- Chat previews are no longer overwritten with an empty "Message" by the kMesh chat-list sync; previews damaged by 1.10.61 are restored from the message cache.
- The app remembers your module list, so it auto-connects to your own modules without internet.
- Connected module card counts neighbours from the module's neighbour list.

Firmware 1.4.6:
- SX1278 runs on the network's 868/869 MHz plan (driven as SX1276), so all LoRa nodes share one band.
- LoRa SF7 instead of SF9: about 3x faster on air.
- ESP-NOW: 6 ms pacing instead of 25 ms, larger receive budget per poll.
- BLE connection interval 7.5-15 ms.

Hub 1.4.18.
