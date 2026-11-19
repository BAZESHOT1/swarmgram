## Kinto 1.10.60

Includes 1.10.59 (its iOS build failed after the rename): app renamed to **Kinto**, new native icon, no duplicates/old messages via kMesh, kMesh messages no longer shown as "Encrypted message".

- kMesh sending: one ordered queue to the module with a per-message timeout — a stuck send no longer blocks the rest; waiting messages show "Очередь: N"; a message without an encryption key shows that it will be sent once the Hub is reachable instead of hanging on "Подготовка KMesh".
- No lock icon on messages sent via kMesh in regular chats.
- Pull-to-refresh on "Чаты" without internet refreshes via kMesh instead of failing.
- Incoming messages from the Hub via kMesh are no longer delayed behind endlessly re-queued old packets.
- Navbar: pulsing green globe when the Hub is reachable via kMesh, blinking red cross when not, spinner while the module connects or changes cluster.
- Module cards and cluster map show the real ESP-NOW/LoRa signal (it was 0).
- Chat list updates instantly for messages that arrive via kMesh.
