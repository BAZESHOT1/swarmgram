## Kinto 1.10.79

- Files, photos, voice messages and backgrounds upload faster on iOS and Android: the app sends them straight through the Hub instead of first reserving space on a storage node it cannot reach over plain HTTP.

Hub 1.4.29:
- Every 15 minutes it removes unfinished upload reservations older than an hour (387 had piled up and held space on the storage node).
- The server was still running Hub 1.4.27 because of a deploy-script error; 1.4.28 features (instant delivery of new messages) are now actually live.
