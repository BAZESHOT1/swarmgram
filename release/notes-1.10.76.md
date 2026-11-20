## Kinto 1.10.76

- Chats, groups and channels without a custom background are transparent again (the app background shows through). The pattern stays only on profiles.
- Chats page: search history and search results open on top of the chat list, with everything underneath blurred.
- Chat header: tap the title to open chat info, hold it to open search in the chat (animated, like Telegram), tap the photo to open the user's profile (in groups/channels: chat info). Menu moved to a separate "⋯" button. Compact header layout on desktop.
- Deleting your own messages in direct chats and groups again offers "Delete for me" and "Delete for everyone" (own dialog, works on desktop/web too).
- New messages appear immediately: the encrypted text of small messages now comes with the real-time event and with history, so the app no longer downloads it from storage nodes (it used to take 10-15 s). Message entrance animation runs only for newly arrived messages, so opening and scrolling chats no longer stutters.

Hub 1.4.28 (migration 049: inline ciphertext for small messages).
