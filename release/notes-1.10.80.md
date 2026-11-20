## Kinto 1.10.80

- Chat and profile backgrounds now fill the entire screen on phones — no app-coloured strips at the sides or top (the app shell no longer adds padding to these screens; they handle the safe area themselves).
- Light theme: glass buttons, the phone navbar, the message field and the profile are light with dark text; dark theme stays dark with light text. The glass look is kept.
- The send button is the same size as the voice-message button.
- Android: notifications arrive when the app is closed. The push now carries a system notification that Android shows by itself, and the background handler is registered at app start (before any screen loads). Tapping such a notification opens the chat.
- Attachments → "Photo" on phones opens the photo gallery (photos and videos), asking for gallery access the first time. Chat/profile backgrounds and avatars are also picked from the gallery.
- Modules page: cleaner connected-module card (four metrics shown once, action tiles), and a clear "connect a module" card when none is connected.
- Admin: readable scrollable tabs; OTA section redesigned — summary with rollout progress, step cards, chip toggles, rollout history and module list filtered by update status.

Hub 1.4.30 (Android system notification in pushes).
