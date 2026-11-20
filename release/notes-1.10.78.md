## Kinto 1.10.78

Includes 1.10.77 (its release was not published because of a GitHub connection error).

- Profile without a custom background is transparent (same as the app background).
- Custom chat and profile backgrounds fill the whole screen, with no app-background strips on the sides or at the top; the profile background stays fixed while the profile scrolls.
- Setting a background (or any request) while the server restarts no longer shows a raw HTML error page: requests are retried automatically and a clear "server temporarily unavailable" message is shown.
- Profile: avatar moved up to the level of the top buttons; actions are now large tiles — invite, notifications, call, more (block, report, share, QR). The "Write" button is removed.

- Chat header: no "⋯" button; the chat name is centred, the user's photo sits at the right edge. Tap the name — chat info, hold the name — search in the chat, tap the photo — profile, hold the photo — chat menu.
- Header no longer sits too low on phones (the safe-area top inset was applied twice).
- Voice messages on iOS and Android (previously web only): with an empty message field the send button becomes a microphone. Hold to record, release to send. An arrow above the button shows you can slide up to lock recording hands-free; tap the button again to send. Slide left to cancel.
- The message field is force-cleared after sending, so an autocorrected word no longer stays in the field.
