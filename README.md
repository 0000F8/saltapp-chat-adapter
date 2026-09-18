# saltapp-chat-adapter

A [Vercel Chat SDK](https://chat-sdk.dev) platform adapter for
[Salt](https://saltapp.ai): write a bot once with `chat` and run it on Salt
as one more platform, the same way it runs on Slack, Telegram, or Discord.

Protocol mechanics -- PGP encrypt/decrypt, the signed REST client, agent
identity -- come from [`salt-agent-sdk`](https://github.com/0000F8/salt-agent-sdk).
This package's only job is translating between Salt's wire format and
chat-sdk's `Message` / `Thread` / `Author` model.

## Install

```bash
npm install saltapp-chat-adapter chat salt-agent-sdk
```

## Setup: create a Salt agent

1. Sign up at [saltapp.ai](https://saltapp.ai) and register an agent
   (Developers > Your agents in the drawer, or `POST /api/v1/agents`). This
   gives you an **api-key**.
2. Generate a PGP keypair for the agent -- `salt-agent-sdk`'s
   `generateKeypair()` produces one in the same format Salt's own frontend
   uses:
   ```ts
   import { generateKeypair } from "salt-agent-sdk";
   const keys = await generateKeypair("a passphrase");
   // keys.publicKey, keys.privateKey, keys.fingerprint
   ```
   Register the public key against the agent (the agent creation payload
   takes `public_key`/`private_key`/`public_fingerprint` -- see
   `salt-agent-sdk`'s `client.createAgent`, or set it up by hand on the
   agent's admin page).
3. Note the agent's own **id** (`X-Salt-Agent-Id` on every webhook it
   receives; also returned when you create it).
4. Point the agent's webhook at wherever you'll run this bot:
   `PATCH /api/v1/agents/callback {webhook: "https://your-host/webhooks/salt"}`
   with the agent's api-key, or through the Agent access page's connect flow.

You now have everything `SaltAdapterConfig` needs: `host`, `apiKey`,
`agentId`, `privateKey`, `publicKey`, `pgpPassphrase`.

## Usage

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { SaltAdapter } from "saltapp-chat-adapter";

const salt = new SaltAdapter({
  host: process.env.HOST!, // e.g. "https://saltapp.ai"
  apiKey: process.env.SALT_API_KEY!,
  agentId: process.env.SALT_APP_ID!,
  privateKey: process.env.APP_PRIVATE_KEY!,
  publicKey: process.env.APP_PUBLIC_KEY!,
  pgpPassphrase: process.env.PGP_PASSPHRASE!,
});

const chat = new Chat({
  adapters: { salt },
  state: createMemoryState(), // swap for @chat-adapter/state-redis etc. in production
  userName: "bot",
});

chat.onDirectMessage(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});

// Mount chat.webhooks.salt(request) behind whatever server you like --
// it speaks the standard Fetch API Request/Response. See examples/echo-bot
// for a complete, runnable server.
```

See `examples/echo-bot/` for a full runnable bot (echoes text, and answers
`ask` with a card carrying real Yes/No buttons).

## The custody line

Whoever runs this bot process holds the agent's PGP private key and its
api-key. That means whoever runs it can read every message and every chat
the agent is a member of, and can act as the agent (post messages, react,
open cards) for as long as it holds that key. Treat `APP_PRIVATE_KEY` and
`SALT_API_KEY` like any other credential that grants read access to private
conversations -- because that is exactly what they are. Rotate the api-key
(`POST /api/v1/agents/:id/rotate_webhook_secret` for the signing secret,
the admin page for the api-key itself) if a deployment holding them is
retired or compromised.

## What this adapter covers

- **Webhook handling**: verifies Salt's per-agent HMAC signature
  (`X-Salt-Signature`), decrypts the PGP ciphertext with the agent's own
  key, and normalizes into a chat-sdk `Message`.
- **Group @mention gating**: Salt's own server never delivers a group-chat
  message webhook to an agent unless it was @mentioned
  (`Message#send_webhook`) -- this adapter trusts that gate and marks every
  delivered message `isMention: true` rather than re-deriving it from data
  Salt doesn't currently send on the wire (see below).
- **Thread ids**: `salt:<chatId>` (a chat is its own thread and its own
  channel -- Salt has no Slack-style nesting), or `salt:<chatId>:lane:<laneId>`
  for a private sidechain/advisor/consult lane.
- **Posting text**: encrypted for every current chat member plus the
  agent's own readable copy (`sender_message`).
- **Cards**: a chat-sdk `CardElement` maps onto Salt's declarative block
  vocabulary (`section` / `fields` / `image` / `divider` / `actions`+buttons,
  see `CARD_PROTOCOL_SPEC.md` and salt-api's `Card` model). Anything Salt's
  vocabulary can't express natively (link buttons, selects, tables, charts)
  degrades to visible plain text instead of being dropped silently. A
  button's chat-sdk `value` (Salt has no such field) is packed into the
  40-char `action_id` Salt allows and decoded back out on tap; if the
  id+value pair is too big to fit, posting the card throws rather than
  silently truncating.
- **Reactions**: Salt's `POST /api/v1/messages/:id/reactions` endpoint
  *toggles*; `addReaction`/`removeReaction` check current state first so
  both stay idempotent the way every other chat-sdk adapter's do.
- **Typing**: `POST /api/v1/chats/:id/typing`.
- **Delete**: Salt's real delete-for-everyone (`DELETE /api/v1/messages/:id`,
  sender-only, 24h window, leaves a tombstone).
- **Fetching**: thread/channel info and message history via
  `GET /api/v1/chats/:id` (Salt has real server-side history, unlike
  Telegram/WhatsApp, so nothing is persisted client-side by this adapter).

## What this adapter does not cover

- **Editing.** Salt has no edit endpoint. `editMessage` throws; `stream()`
  buffers the whole reply and posts it once instead of incrementally
  editing (same fallback Messenger's own adapter uses, for the same reason).
- **Salt-specific webhook events with no chat-sdk equivalent** --
  `chat_opened`, `invoice_paid`, `handoff_confirmed`, `handoff_received`.
  `handleWebhook` acknowledges these with 200 and does nothing else with
  them. A bot that needs them should use `salt-agent-sdk`'s own
  `createWebhookServer` instead (or open an issue -- a future version of
  this adapter could expose them as adapter-specific events).
- **Attachments.** Incoming image/file attachments aren't decrypted or
  normalized into chat-sdk `Attachment`s yet, and `rehydrateAttachment` is a
  no-op. Text and cards are the whole surface today.
- **`getUser`, `markAsRead`, `getChannelVisibility`.** Left unimplemented --
  Salt has no general "look up any user" endpoint exposed via
  `salt-agent-sdk`'s client, and the latter two need a synchronous answer
  this adapter can't give without a prior fetch.
- The `mentions` field this adapter reads defensively from an incoming
  message isn't actually present on Salt's webhook wire format today (see
  `HANDOFF.md`) -- harmless, since the group-mention gate above already
  gets this right without it, but worth knowing if you go looking for it.

## Socket mode

Salt's socket-mode contract for a bot with no public URL (an outbox table,
a long-poll `GET /api/v1/agent/updates`, and an Action Cable channel) is
specified but not yet shipped in `salt-agent-sdk` (see
`design-fleet/runs/2026-09-17-distribution/LANES.md`'s "Socket mode contract
(K2)" in the Salt monorepo). Passing `mode: "socket"` to `SaltAdapter` checks
whether the installed `salt-agent-sdk` exposes a socket client and, if not,
throws a clear error naming the version you need
(`mode: "socket" needs salt-agent-sdk >= 0.8.0 ...`). The default,
`mode: "webhook"`, works today.

## Testing

```bash
npm install
npm test          # vitest run
npm run typecheck
npm run build      # tsup -> dist/ (ESM + .d.ts)
```

Tests mock the REST layer (a fake `fetch` implementation, see
`tests/helpers.ts`) but use **real** PGP keys and **real** encryption/
decryption via `salt-agent-sdk`'s `openpgp`-backed `crypto.ts` -- so
"posts encrypt for every member" is verified by actually decrypting the
ciphertext with each member's own private key, not by mocking crypto away.

## Listing this on chat-sdk.dev

Per `chat-sdk.dev/docs/contributing/publishing`, a community (non-vendor,
non-`@chat-adapter/`-scoped) adapter gets listed by:

1. Publishing this package to npm under its current unscoped name,
   `saltapp-chat-adapter` (the `@saltapp` org isn't set up yet, so this
   stays unscoped for now, per the workspace's naming decision).
2. Opening a PR against [vercel/chat](https://github.com/vercel/chat) that
   adds an entry to `apps/docs/adapters.json`:
   `name`, `slug` ("salt"), `type: "platform"`, `community: true`,
   `packageName: "saltapp-chat-adapter"`, and `readme` -- a GitHub URL
   **pinned to a tag or commit SHA**, e.g.
   `https://github.com/0000F8/saltapp-chat-adapter/tree/v0.1.0` (an
   unpinned `tree/main` is rejected in review).
3. The docs site fetches that README from GitHub at build time and renders
   it on the adapter's own page -- so keep this file the canonical
   description of what the adapter does.

This repo does not publish or open that PR itself (see `HANDOFF.md`); the
coordinator does once a tagged release exists to point `readme` at.

## License

MIT, see `LICENSE`.
