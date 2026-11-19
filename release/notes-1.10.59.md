## Kinto 1.10.59

- The app is now called **Kinto** everywhere (app name, web tab, notifications).
- New app icon in native builds; iOS build number raised to 11059 so iOS refreshes the cached icon.
- kMesh: no more duplicates or old messages — the Hub no longer re-queues already delivered packets forever (max 3 attempts, only recent packets), and the app recognises copies of the same message across transports by its encryption nonce.
- kMesh messages synced to the Hub in regular (server) chats are no longer shown as "Encrypted message": the Hub stores the encryption scheme and key version; existing messages are fixed by a migration.
