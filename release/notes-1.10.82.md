## Kinto 1.10.82

Includes 1.10.81.

- Admin: blocking a user works again. The reason field is optional (defaults to "Rule violation"); success and errors are shown as notifications instead of a hidden message at the top of the page.
- Blocked accounts stay signed in but every screen is blurred with "Account blocked by the site administration" in the middle; the only action left is signing out. The Hub rejects all other requests from a blocked account, and blocking/unblocking applies instantly.
- Desktop: chat and profile backgrounds fill the whole area next to the sidebar, with no margins.
- The address bar no longer shows `?__EXPO_ROUTER_key=…`: the parameter is removed before every navigation reaches the browser.

Hub 1.4.32.
