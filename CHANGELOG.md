# Changelog

## 0.1.1

**Open rooms are actually detected, and a rejected signature no longer costs an API call.**
`fetchThread` read `encrypted` and `name` from the top level of `GET /api/v1/chats/:id`, but the chat
payload nests every chat-level field under `session` — and an `as {…}` cast hid that from the type
checker. The consequence was not merely a dead branch: `fetchThread` could overwrite a correct cache
entry with the wrong value, after which `postMessage` took the PGP branch and salt-api refused the
send outright. Neither read had any test coverage, and the shared `FakeChat` double modelled the same
wrong shape. Both reads fixed, the double corrected, three regression tests added. Separately, the
webhook-secret fetch was unconditional on any verification failure during the window before the first
successful fetch (startup, or while Salt's response is empty); it is now gated behind a signature
shape check and an attempt-gated 60-second cooldown. 62 → 71 tests.

