# Changelog

## Unreleased

**Send guard.** Every encrypted post carries `recipient_fingerprints` and `sender_fingerprint` (members are read at send time). On a 409 `stale_recipient_keys` the post is re-encrypted once to the keys Salt returns and resent; a second refusal is thrown. Needs the salt-agent-sdk release that passes these fields through `postMessage` (0.23.0); an older SDK ignores them.

**One Salt card, four renderers.** `toSlackBlocks`, `toAdaptiveCard`, `toDiscordMessage` and
`toTelegramMessage` render a card from a Salt agent for Slack, Teams/Outlook, Discord and
Telegram, each with a plain-text fallback and platform limits enforced by truncation. `pay`,
`handoff` and `signup` buttons become links that open the card in Salt; every default button is a
callback that `parseInteraction(platform, payload)` turns back into a `card_interaction`-shaped
`{card_id, action_id, values?}`, with a short-hash encoding when an id overflows the platform cap.

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

