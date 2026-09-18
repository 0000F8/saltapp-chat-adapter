# HANDOFF: saltapp-chat-adapter (lane `chat-adapter`)

New repository at `/Users/z1ggy/projects/salt/saltapp-chat-adapter` (git
initialized, committed locally; no GitHub repo created, nothing published,
per the lane rules). Not a worktree of an existing repo -- this lane's
output IS the repo.

## What this is

A Vercel Chat SDK (`chat`) platform adapter for Salt: implements the
`Adapter<SaltThreadId, SaltRawMessage>` interface so any bot written
against `chat` runs on Salt as one more platform. Built on
`salt-agent-sdk` (^0.7.1) for PGP encrypt/decrypt and the REST client --
no Salt protocol logic (crypto, signing) is reimplemented, with one
documented, narrow exception below.

## Files

```
package.json, tsconfig.json, tsup.config.ts, vitest.config.ts, LICENSE, .gitignore
README.md, AGENTS.md, HANDOFF.md
src/
  index.ts        -- public exports
  adapter.ts       -- the Adapter implementation (SaltAdapter)
  types.ts          -- SaltAdapterConfig + the exact webhook wire shapes
  thread-id.ts       -- salt:<chatId>[:lane:<laneId>] encode/decode
  signature.ts        -- HMAC verification (see "Left for salt-agent-sdk" below)
  action-id.ts          -- packs a chat-sdk button's (id, value) into Salt's 40-char action_id
  cards.ts               -- CardElement -> Salt block vocabulary mapping
  salt-rest.ts             -- reactions/delete/getChat (see "Left for salt-agent-sdk" below)
  socket.ts                 -- mode: "socket" version/capability gate (always throws today)
tests/
  helpers.ts        -- FakeSaltApi (mocks fetch, not SaltClient's ~30 methods)
  thread-id.test.ts, action-id.test.ts, signature.test.ts, cards.test.ts,
  webhook.test.ts, post.test.ts, socket.test.ts
examples/echo-bot/    -- runnable example bot (own package.json, README, .env.example)
```

No migrations -- this is a fresh package, not a change to an existing one.

## How to test

```bash
cd /Users/z1ggy/projects/salt/saltapp-chat-adapter

# Local dev only: point salt-agent-sdk at the sibling checkout (rebuild it
# first if you changed it). Restored to "^0.7.1" below before committing.
npm install ../salt-agent-sdk
npm install

npm test          # vitest run -- 48 tests, all passing as of this handoff
npm run typecheck   # tsc --noEmit
npm run build        # tsup -> dist/ (ESM + .d.ts) -- also passing

cd examples/echo-bot
npm install
npm run typecheck    # passing
```

Manual smoke test performed during this lane (see transcript): started the
example bot with dummy credentials, confirmed it listens, confirmed an
unsigned webhook POST to `/webhooks/salt` gets a real `401 {"error":"invalid
signature"}` (proving signature verification actually runs against a real
HTTP request, not just in unit tests), confirmed a wrong path 404s.

**Package.json state at handoff**: `salt-agent-sdk` was temporarily pointed
at `file:../salt-agent-sdk` for local test runs. **It has been restored to
`"^0.7.1"` before this commit** -- verify this wasn't re-changed if you pull
up this repo again and see install failures (`npm install` will fail with
`ETARGET` if it's back on the real-registry range, since salt-agent-sdk
isn't published there; that's expected for anyone outside this monorepo
checkout, and is exactly why the README tells a real consumer to
`npm install saltapp-chat-adapter chat salt-agent-sdk` assuming
salt-agent-sdk eventually IS published, or to use the same local-path
override this lane used until then).

## Left for salt-agent-sdk (not fixed here -- out of this lane's repo)

Two things this adapter had to build itself because `salt-agent-sdk`
0.7.1 doesn't expose them yet. Both are called out in code comments
(`src/signature.ts`, `src/salt-rest.ts`) and should be deleted from this
package the moment `salt-agent-sdk` grows the real thing:

1. **Webhook signature verification isn't exported as a standalone
   function.** `salt-agent-sdk`'s `createWebhookServer` (`src/webhook.ts`)
   verifies the HMAC internally (`rejectionReason`), but that function
   isn't exported, and `createWebhookServer` itself is a complete,
   opinionated Express app (delegation, mediator, hand-offs, sessions)
   built for a native Salt agent process -- not something that fits inside
   a different framework's `handleWebhook(request: Request)` contract,
   which is what chat-sdk's `Adapter` interface requires. This package's
   `src/signature.ts` reimplements the same check (same header format,
   same HMAC formula, same constant-time compare) using
   `salt-agent-sdk`'s own `client.getWebhookSecret()` to fetch the actual
   secret. Suggested fix upstream: export a standalone
   `verifyWebhookSignature({rawBody, signatureHeader, secret,
   toleranceSeconds?})` from `salt-agent-sdk` that `createWebhookServer`
   itself calls internally, so this file disappears.
2. **`SaltClient` has no `addReaction`/`removeReaction`/`deleteMessage`/
   full-chat-payload methods.** `src/salt-rest.ts` adds
   `toggleReaction`/`deleteMessage`/`getChat` by calling the same three
   REST endpoints directly (with the identical auth-header/error-handling
   convention `client.ts`'s own internal `request()` helper uses).
   Suggested fix upstream: add these to `createSaltClient`'s returned
   object (`POST /api/v1/messages/:id/reactions`,
   `DELETE /api/v1/messages/:id`, and either a `getChat` or splitting
   `getChatMembers`/`getChatMessages`'s shared `GET /api/v1/chats/:id`
   call into a cached fetch both can reuse).

Also noted, not a gap this lane can close: **`mentions` isn't actually on
the wire.** `salt-api`'s `Message#formatted_message` (what `WebhookJob`
posts) never serializes the `mentions` jsonb column, even though
`salt-agent-sdk`'s own `webhook.ts` reads `message.mentions` defensively
in its agent-to-agent mention-gating re-check. This adapter reads it the
same defensive way and falls back to `true` (trusting Salt's own
send-webhook gate) when it's absent -- which is always, today. If `salt-api`
ever adds it to the payload, nothing here needs to change; the fallback
just stops being exercised. That's a `salt-api` fix, not a `salt-agent-sdk`
or adapter fix -- flagging here since it's the kind of thing that's easy
to lose track of across repos.

## Threat notes (security-sensitive: signing, keys)

- **Signature verification is on by default** (`verifySignatures: true`
  unless explicitly overridden) and rejects: missing header, malformed
  header, a signature older than `signatureToleranceSeconds` (default 300s,
  replay protection), and a bad HMAC -- using `timingSafeEqual`, not `===`,
  to avoid leaking the digest a byte at a time. Verified by
  `tests/signature.test.ts` and, at the HTTP layer, by
  `tests/webhook.test.ts`'s "rejects a webhook whose signature doesn't
  match" case and the manual smoke test above.
- **The webhook secret is per-agent**, fetched via the agent's own api-key
  (`client.getWebhookSecret`), matching `salt-agent-sdk`'s own model (no
  shared fleet-wide secret).
- **Decryption failures fail closed to a placeholder, never to plaintext
  the server sent.** If `pgp.decrypt` throws (wrong key, corrupted
  ciphertext, a message genuinely not encrypted to this agent), the
  message's text becomes `"[Encrypted]"` -- the same string Salt's own
  frontend shows for content it can't read -- rather than throwing an
  unhandled exception that could crash the bot process or, worse, than
  silently passing the raw ciphertext through as if it were the message.
- **Self-echo and system-event guards.** A webhook whose sender is this
  agent's own id is never dispatched (Salt redelivers an agent's own posts
  to it; without this guard a bot would answer itself in a loop). A message
  carrying `event_type` (a system event -- member added, chat renamed,
  etc.) is never treated as a prompt.
- **Custody**: see the README's "The custody line" section. Whoever runs
  this bot process holds the agent's PGP private key and api-key and can
  therefore read the agent's chats and act as it. This is inherent to how
  Salt agents work (same as `salt-app-example`'s own model), not something
  introduced by this adapter, but it's the single most important thing for
  anyone standing up a bot with this package to understand, so it's stated
  plainly in the README rather than left implicit.

## CLAUDE.md paragraph to add (coordinator's call on exact wording/placement)

> **saltapp-chat-adapter** (new repo, `/Users/z1ggy/projects/salt/saltapp-chat-adapter`,
> unscoped npm name) -- a [Vercel Chat SDK](https://chat-sdk.dev) platform
> adapter: implements `chat`'s `Adapter` interface for Salt, so a bot
> written against `chat` runs on Salt like it runs on Slack/Telegram.
> Built on `salt-agent-sdk` for PGP and the REST client (no Salt protocol
> logic reimplemented, aside from two small documented gaps in
> `salt-agent-sdk`'s current public surface -- see its `HANDOFF.md`). Covers
> webhook verification/decrypt, posting (encrypted for every member),
> reactions, typing, delete-for-everyone, and cards (mapped to Salt's
> `section`/`fields`/`image`/`divider`/`actions` block vocabulary, unmapped
> chat-sdk rich elements degrade to visible text rather than vanishing).
> Salt has no edit endpoint, so `editMessage` throws and streaming buffers
> to one post. `mode: "socket"` throws a clear "needs salt-agent-sdk >= 0.8"
> error until the socket-mode lane (LANES.md's K2) ships a client for it.
> Not yet published to npm or listed on chat-sdk.dev's adapters page -- see
> its own `HANDOFF.md` for the exact publish/listing steps.

## What's new (user-facing candidate)

**Internal only.** This is developer tooling (an SDK adapter package), not
a Salt product surface -- nothing here changes what a human or an agent
using Salt directly sees. Skip it in `salt-fe/src/whatsNew.js`.

## UAT steps

1. `cd /Users/z1ggy/projects/salt/saltapp-chat-adapter/examples/echo-bot`
2. Create a real test agent on saltapp.ai (username `SALT-...`, per the
   workspace's test-account convention) and get its api-key + PGP keypair
   (see this package's root README's "Setup" section for the exact calls).
3. `cp .env.example .env` and fill in `HOST`, `SALT_API_KEY`, `SALT_APP_ID`,
   `APP_PUBLIC_KEY`, `APP_PRIVATE_KEY`, `PGP_PASSPHRASE`.
4. `npm install && npm start`.
5. In a second terminal, `ngrok http 5100` (or any tunnel).
6. `PATCH /api/v1/agents/callback` with the agent's api-key, body
   `{"webhook": "https://<tunnel>/webhooks/salt"}`.
7. On saltapp.ai, message the test agent from a human account: it should
   echo the text back. Send `ask`: it should post a card with Yes/No
   buttons; tapping either should get a reply acknowledging the choice.
8. Confirm in the bot's console log that nothing throws, and that the
   webhook responds fast (the fire-and-forget dispatch pattern means the
   HTTP response returns before the reply is posted).

I was not able to run this live UAT myself in this session (no real Salt
agent credentials or a tunnel were available to me) -- steps 2-8 are for
whoever picks this up next. Everything up through a fully mocked-but-real
HTTP request/response cycle (signature verification, decryption, dispatch)
IS verified, per "How to test" above and the manual smoke test.

## Left undone / explicitly out of scope

- **Attachments** (incoming image/file decrypt+normalize into chat-sdk
  `Attachment[]`) -- not built. `rehydrateAttachment` is a pass-through
  no-op. The task's explicit scope list didn't include attachments; adding
  them is a reasonable follow-up but would need its own decrypt path
  (`salt-agent-sdk`'s `decryptAttachment`) and test coverage.
- **`getUser`, `markAsRead`, `getChannelVisibility`** -- left unimplemented
  (optional on the `Adapter` interface). `getUser` has no matching
  general-purpose endpoint on `SaltClient`; the other two need a
  synchronous answer this adapter can't give without a prior async fetch.
- **`chat_opened` / `invoice_paid` / `handoff_*` webhook events** --
  acknowledged (200) and otherwise dropped; chat-sdk's cross-platform model
  has no equivalent concept for any of them. Flagged in the README as a
  possible future adapter-specific-event extension, not attempted here.
- **True server-side cursor pagination in `fetchMessages`** -- Salt's
  `GET /api/v1/chats/:id` returns the whole chat's messages in one call
  (up to whatever the server itself caps it at); this adapter paginates
  that array client-side rather than using a real cursor API. Fine for a
  chat of ordinary size; would want revisiting for a very long-running
  channel.
- **Live UAT** -- see above; not run against a real Salt deployment in
  this session.
- Socket mode itself is, correctly, not implemented -- it's explicitly
  another lane's deliverable per this lane's own instructions. `src/socket.ts`
  is the integration point for whenever that lands.
